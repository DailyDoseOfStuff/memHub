/* memHub end-to-end tests. Spawns an isolated HTTP server (port 4788) + MCP
   processes (same temp data dir), exercises every endpoint and the protocol,
   then verifies cross-process coherence and on-disk persistence. Run: node test.js */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const PORT = 4788;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'memhub-test-'));
const STORE = path.join(DATA, 'store.json');
const ENV = { ...process.env, MEMHUB_PORT: String(PORT), MEMHUB_DATA: DATA, MEMHUB_NO_EMBED: '1' };
const MB = JSON.parse(JSON.stringify(ENV));

let server = null;
let passed = 0;
let failed = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`FAIL ${name} :: ${err.message}`);
  }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function j(method, path, body, expect) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (expect) assert.equal(res.status, expect, `${method} ${path} -> ${res.status}`);
  let json = {};
  const text = await res.text();
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, json, headers: res.headers };
}

/* ---------- MCP helpers ---------- */
function mcpProc(lines) {
  return new Promise((resolve) => {
    const child = spawn('node', [path.join(__dirname, 'server', 'src', 'mcp.js')], { env: MB, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('close', () => {
      const msgs = out.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { _bad: true }; } });
      resolve(msgs);
    });
    child.stdin.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    child.stdin.end();
  });
}

/* ---------- boot ---------- */
async function waitForListen() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/health`); return; } catch { await wait(100); }
  }
  throw new Error('server did not listen');
}

/* ---------- tests ---------- */
async function main() {
  server = spawn('node', [path.join(__dirname, 'server', 'src', 'index.js')], { env: ENV, stdio: ['pipe', 'pipe', 'inherit'] });
  await waitForListen();

  await t('health: ok + zero counts', async () => {
    const { json, headers } = await j('GET', '/api/health', null, 200);
    assert.equal(json.ok, true);
    assert.equal(json.counts.nodes, 0);
    assert.equal(headers.get('access-control-allow-origin'), '*');
  });

  await t('CORS preflight: OPTIONS -> 204', async () => {
    const res = await fetch(`${BASE}/api/health`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-methods').includes('DELETE'), true);
  });

  let projA, projB;
  await t('node create: deterministic id + meta', async () => {
    const { json } = await j('POST', '/api/node', { type: 'project', label: 'TestApp', meta: { root: '/tmp/x' } }, 200);
    assert.equal(json.node.id, 'project:testapp');
    assert.equal(json.node.meta.root, '/tmp/x');
    projA = json.node;
    projB = projA;
  });

  await t('node upsert: same id, createdAt preserved', async () => {
    const { json } = await j('POST', '/api/node', { type: 'project', label: 'TestApp' }, 200);
    assert.equal(json.node.id, projA.id);
    assert.equal(json.node.createdAt, projA.createdAt);
  });

  await t('node POST validation: 400 on missing fields', async () => {
    const a = await j('POST', '/api/node', { label: 'x' });
    const b = await j('POST', '/api/node', { type: 'x' });
    assert.equal(a.status, 400);
    assert.equal(b.status, 400);
  });

  await t('edge POST: auto-creates missing endpoint as concept', async () => {
    const { json } = await j('POST', '/api/edge', { source: projA.id, target: 'dependency injection', type: 'uses' }, 200);
    assert.equal(json.edge.source, projA.id);
    assert.equal(json.edge.target, 'concept:dependency-injection');
  });

  let note1;
  await t('note POST: defaults + attach', async () => {
    const { json } = await j('POST', '/api/notes', { text: '  locked schema v2  ', tags: 'decision,db'.split(','), model: 'opus-4' }, 200);
    assert.equal(json.note.text, 'locked schema v2');
    assert.equal(json.note.model, 'opus-4');
    assert.deepEqual(json.note.tags, ['decision', 'db']);
    note1 = json.note;
  });

  await t('note POST: empty text -> 400', async () => {
    const a = await j('POST', '/api/notes', { text: '   ' });
    assert.equal(a.status, 400);
  });

  await t('note POST: invalid -> 400, db untouched', async () => {
    const res = await fetch(`${BASE}/api/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(res.status, 400);
    const { json } = await j('GET', '/api/health', null, 200);
    assert.equal(json.counts.notes, 1);
  });

  await t('node detail: neighbors + notes arrays', async () => {
    const { json } = await j('GET', `/api/node/${encodeURIComponent(projA.id)}`, null, 200);
    assert.equal(json.node.id, projA.id);
    assert.equal(json.neighbors.length, 1);
    assert.equal(json.neighbors[0].id, 'concept:dependency-injection');
    assert.equal(json.notes.length, 0); // note1 has no parent
    await j('POST', '/api/notes', { text: 'attached probe', parent: projA.id, model: 'm2' }, 200);
    const again = (await j('GET', `/api/node/${encodeURIComponent(projA.id)}`, null, 200)).json;
    assert.equal(again.notes.length, 1);
    assert.equal(again.notes[0].text, 'attached probe');
  });

  let session;
  await t('session POST: creates session node', async () => {
    const { json } = await j('POST', '/api/sessions', { model: 'gpt-5', agent: 'cursor' }, 200);
    assert.equal(json.session.model, 'gpt-5');
    session = json.session;
    const h = (await j('GET', '/api/health', null, 200)).json;
    assert.equal(h.counts.sessions, 1);
    const s = (await j('GET', '/api/stats', null, 200)).json;
    assert.equal(s.byType.session, 1);
  });

  await t('note filters: parent + q + tag combinable', async () => {
    await j('POST', '/api/notes', { text: 'coherence probe separate', parent: projA.id, tags: ['probe'], model: 'm2' }, 200);
    const all = (await j('GET', '/api/notes', null, 200)).json;
    assert.equal(all.notes.length, 3); // note1 + attached probe + this
    const byParent = (await j('GET', `/api/notes?parent=${encodeURIComponent(projA.id)}`, null, 200)).json;
    assert.equal(byParent.notes.length, 2);
    const byTag = (await j('GET', '/api/notes?tag=probe', null, 200)).json;
    assert.equal(byTag.notes.length, 1);
    const byQ = (await j('GET', '/api/notes?q=locked%20schema', null, 200)).json;
    assert.equal(byQ.notes.length, 1);
    const both = (await j('GET', `/api/notes?parent=${encodeURIComponent(projA.id)}&tag=probe`, null, 200)).json;
    assert.equal(both.notes.length, 1);
    const none = (await j('GET', '/api/notes?parent=project:zzz', null, 200)).json;
    assert.equal(none.notes.length, 0);
  });

  await t('search: exact > prefix > substring ordering', async () => {
    await j('POST', '/api/node', { type: 'concept', label: 'search things' }, 200);
    const { json } = await j('GET', `/api/search?q=${encodeURIComponent('search')}&limit=5`, null, 200);
    assert.equal(json.results.length >= 1, true);
    const top = json.results[0];
    assert.equal(top.label, 'search things');
    assert.equal(top.score, 80 + 10); // prefix match (80) + fresh recency bump (10)
  });

  await t('search: token match via note text, not just label', async () => {
    // Old search matched label substring only; query words that appear only
    // in an attached note must now surface the node (recall-quality pin).
    await j('POST', '/api/node', { type: 'decision', label: 'booking queue' }, 200);
    await j('POST', '/api/notes', { text: 'we chose serializable isolation for the booking queue', parent: 'decision:booking-queue', model: 'pin' }, 200);
    await wait(400);
    const { json } = await j('GET', `/api/search?q=${encodeURIComponent('chose serializable')}&limit=5`, null, 200);
    assert.equal(json.results[0].id, 'decision:booking-queue', JSON.stringify(json.results));
  });

  await t('recall: token-mode fallback shape when embeddings are disabled', async () => {
    // Suite runs with MEMHUB_NO_EMBED=1, so /api/recall must degrade to token
    // ranking instead of erroring, keeping the same {id,label,type,score} shape.
    const { json } = await j('GET', `/api/recall?q=${encodeURIComponent('chose serializable')}&limit=5`, null, 200);
    assert.equal(json.mode, 'token');
    assert.equal(json.results[0].id, 'decision:booking-queue', JSON.stringify(json.results));
    assert.equal(typeof json.results[0].score, 'number');
    const empty = await j('GET', '/api/recall?q=%20&limit=5', null, 200);
    assert.equal(empty.json.results.length, 0);
  });

  await t('query hops: BFS subgraph bounded + concept-id normalization', async () => {
    const e = await j('POST', '/api/edge', { source: 'concept:dependency-injection', target: 'concept:di-frameworks', type: 'implies' }, 200);
    assert.equal(e.json.edge.target, 'concept:concept-di-frameworks'); // slugified id
    const diExact = e.json.edge.target;
    const { json } = await j('GET', `/api/query/${encodeURIComponent(projA.id)}?hops=1`, null, 200);
    const ids = json.subgraph.nodes.map((n) => n.id);
    assert.equal(ids.includes(diExact), false); // 2 hops away
    const h2 = (await j('GET', `/api/query/${encodeURIComponent(projA.id)}?hops=2`, null, 200)).json;
    assert.equal(h2.subgraph.nodes.map((n) => n.id).includes(diExact), true);
  });

  await t('query: missing node -> 500 with clear error', async () => {
    const r = await j('GET', `/api/query/${encodeURIComponent('project:ghost')}`);
    assert.equal(r.json.error, 'node not found');
  });

  await t('stats: degrees non-increasing + byType counts', async () => {
    const { json } = await j('GET', '/api/stats', null, 200);
    const degs = json.topConnected.map((x) => x.degree);
    for (let i = 1; i < degs.length; i++) assert.equal(degs[i] <= degs[i - 1], true, 'topConnected not sorted');
    const me = json.topConnected.find((x) => x.id === projA.id);
    assert.equal(me && me.degree >= 1, true);
    assert.equal(json.byType.project >= 1, true);
  });

  await t('log: records mutations', async () => {
    const { json } = await j('GET', '/api/log?limit=10', null, 200);
    const actions = json.log.map((l) => l.action);
    assert.equal(actions.includes('note.create'), true);
    assert.equal(actions.includes('node.create'), true);
  });

  await t('edge delete + node delete cascade + 404 after', async () => {
    const e = (await j('POST', '/api/edge', { source: projA.id, target: 'concept:temp-link', type: 'x' }, 200)).json.edge;
    const d1 = await j('DELETE', `/api/edge/${encodeURIComponent(e.id)}`, null, 200);
    assert.equal(d1.json.deleted, true);
    const detail = (await j('GET', `/api/node/${encodeURIComponent(projA.id)}`, null, 200)).json;
    assert.equal(detail.edges.some((x) => x.id === e.id), false);

    const ghost = (await j('POST', '/api/node', { type: 'concept', label: 'temp-node' }, 200)).json.node;
    const nd = await j('DELETE', `/api/node/${encodeURIComponent(ghost.id)}`, null, 200);
    assert.equal(nd.json.deleted, true);
    const gone = await j('GET', `/api/node/${encodeURIComponent(ghost.id)}`);
    assert.equal(gone.status, 404);
  });

  await t('graph: full snapshot shape', async () => {
    const { json } = await j('GET', '/api/graph', null, 200);
    assert.equal(json.nodes.length > 3, true);
    assert.equal(Array.isArray(json.edges), true);
  });

  await t('/api/graph strips embedding vectors, carries embedRev', async () => {
    await j('POST', '/api/node', { type: 'concept', label: 'embed-shape probe' }, 200);
    const { json } = await j('GET', '/api/graph', null, 200);
    assert.equal(json.nodes.length > 0, true);
    assert.equal(json.nodes.every((n) => !('embedding' in n)), true, 'embedding leaked into /api/graph');
    assert.equal(typeof json.embedRev === 'string' || json.embedRev === 0, true, JSON.stringify(json.embedRev));
  });

  await t('/api/embeddings shape under disabled engine', async () => {
    const st = await j('GET', '/api/embed/status', null, 200);
    assert.equal(st.json.status, 'failed');
    assert.equal(st.json.error, 'disabled');
    const { json } = await j('GET', '/api/embeddings', null, 200);
    assert.equal(json.status.status, 'failed');
    assert.equal(json.status.error, 'disabled');
    assert.equal(json.dim, 384);
    assert.equal(typeof json.vectors, 'object');
    assert.equal(Object.keys(json.vectors).length, 0, 'disabled engine must not have produced vectors');
    for (const [id, v] of Object.entries(json.vectors)) {
      assert.equal(Array.isArray(v), true, id + ' vector not array');
      assert.equal(v.length, 384, id + ' vector length ' + v.length);
      assert.equal(v.every((x) => typeof x === 'number'), true, id + ' non-numeric');
    }
  });

  await t('embeddings: vectors stripped from graph/node/query but served by /api/embeddings', async () => {
    const node = (await j('POST', '/api/node', { type: 'concept', label: 'seeded vector probe' }, 200)).json.node;
    const id = node.id;
    try {
      // Wait for the server's debounced flush, then inject a vector atomically.
      for (let i = 0; i < 20; i++) {
        const disk = fs.existsSync(STORE) ? JSON.parse(fs.readFileSync(STORE, 'utf8')) : null;
        if (disk && disk.nodes && disk.nodes[id]) break;
        await wait(150);
      }
      await wait(400); // let saveNow finish so the watcher is not deferred by dirty state
      const disk = JSON.parse(fs.readFileSync(STORE, 'utf8'));
      assert.equal(!!disk.nodes[id], true, 'seeded node never reached disk');
      const v = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
      disk.nodes[id].embedding = { model: 'test', dim: 384, v, at: Date.now(), hash: 'x', stale: false };
      const seedTmp = STORE + '.seed.tmp';
      fs.writeFileSync(seedTmp, JSON.stringify(disk));
      fs.renameSync(seedTmp, STORE);

      let emb = null;
      for (let i = 0; i < 20; i++) {
        emb = (await j('GET', '/api/embeddings', null, 200)).json;
        if (emb.vectors && Array.isArray(emb.vectors[id]) && emb.vectors[id].length === 384) break;
        await wait(150);
      }
      assert.equal(emb.dim, 384);
      assert.equal(Array.isArray(emb.vectors[id]), true, 'seeded vector not served: ' + JSON.stringify(emb.rev));
      assert.equal(emb.vectors[id].length, 384);
      assert.equal(emb.vectors[id].every((x) => typeof x === 'number'), true);
      for (const [vid, vec] of Object.entries(emb.vectors)) {
        assert.equal(vec.length, 384, vid + ' vector length ' + vec.length);
        assert.equal(vec.every((x) => typeof x === 'number'), true, vid + ' non-numeric');
      }

      const g = (await j('GET', '/api/graph', null, 200)).json;
      const gn = g.nodes.find((n) => n.id === id);
      assert.equal(gn !== undefined, true, 'seeded node missing from graph');
      assert.equal('embedding' in gn, false, 'graph leaked embedding');

      const d = (await j('GET', `/api/node/${encodeURIComponent(id)}`, null, 200)).json;
      assert.equal(d.node.id, id);
      assert.equal('embedding' in d.node, false, 'node detail leaked embedding');

      const q = (await j('GET', `/api/query/${encodeURIComponent(id)}?hops=1`, null, 200)).json;
      const qn = q.subgraph.nodes.find((n) => n.id === id);
      assert.equal(qn !== undefined, true, 'seeded node missing from query subgraph');
      assert.equal('embedding' in qn, false, 'query subgraph leaked embedding');
    } finally {
      await j('DELETE', `/api/node/${encodeURIComponent(id)}`, null, 200);
    }
  });

  await t('backup: file written immediately', async () => {
    const { json } = await j('POST', '/api/backup', {}, 200);
    assert.equal(json.ok, true);
    assert.equal(fs.existsSync(json.file), true);
  });

  await t('413: oversized body rejected, server alive', async () => {
    const big = '{"text":"' + 'x'.repeat(2 * 1024 * 1024) + '"}';
    const res = await fetch(`${BASE}/api/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
    assert.equal(res.status, 413);
    const h = await j('GET', '/api/health', null, 200);
    assert.equal(h.json.ok, true);
  });

  await t('static: index, assets, 404, 405, traversal blocked', async () => {
    const idx = await fetch(`${BASE}/`);
    assert.equal(idx.status, 200);
    assert.equal(idx.headers.get('content-type').includes('text/html'), true);
    const css = await fetch(`${BASE}/style.css`);
    assert.equal(css.status, 200);
    const js = await fetch(`${BASE}/app.js`);
    assert.equal(js.status, 200);
    const nf = await fetch(`${BASE}/nope.js`);
    assert.equal(nf.status, 404);
    const bad = await fetch(`${BASE}/`, { method: 'POST' });
    assert.equal(bad.status, 405);
    const trav1 = await fetch(`${BASE}/..%2fREADME.md`);
    const trav2 = await fetch(`${BASE}/%2e%2e%2fREADME.md`);
    assert.equal(trav1.status !== 200 && trav2.status !== 200, true);
  });

  await t('static: graph3d.js + vendored 3D lib served', async () => {
    const g = await fetch(`${BASE}/graph3d.js`);
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('content-type').includes('javascript'), true);
    const text = await g.text();
    assert.equal(text.includes('ForceGraph'), true);
    const lib = await fetch(`${BASE}/vendor/3d-force-graph.min.js`);
    assert.equal(lib.status, 200);
    assert.equal(lib.headers.get('content-type').includes('javascript'), true);
  });

  await t('unknown api path -> 404 JSON', async () => {
    const r = await j('GET', '/api/wat');
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'not found');
  });

  /* ---------- MCP protocol ---------- */
  await t('MCP: initialize + tools/list (10 tools)', async () => {
    const msgs = await mcpProc([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    assert.equal(msgs[0].result.protocolVersion, '2024-11-05');
    assert.equal(msgs[0].result.serverInfo.name, 'memhub');
    assert.equal(msgs[1].result.tools.length, 10);
  });

  await t('MCP: one-shot save_note flushes to disk', async () => {
    await mcpProc([
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memhub_save_note', arguments: { text: 'written by mcp process', model: 'mcp-test', tags: ['mcp'] } } },
    ]);
    const disk = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    const notes = Object.values(disk.notes).filter((n) => n.model === 'mcp-test');
    assert.equal(notes.length, 1);
  });

  await t('MCP: create_node + link_nodes + find_nodes', async () => {
    const msgs = await mcpProc([
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'memhub_create_node', arguments: { type: 'decision', label: 'adopt memhub' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'memhub_link_nodes', arguments: { source: 'decision:adopt-memhub', target: projA.id, type: 'made-for' } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'memhub_find_nodes', arguments: { query: 'adopt memhub' } } },
    ]);
    assert.equal(msgs[0].result.content[0].text !== undefined, true);
    const created = JSON.parse(msgs[0].result.content[0].text);
    assert.equal(created.id, 'decision:adopt-memhub');
    const link = JSON.parse(msgs[1].result.content[0].text);
    assert.equal(link.source, 'decision:adopt-memhub');
    const found = JSON.parse(msgs[2].result.content[0].text);
    assert.equal(found[0].id, 'decision:adopt-memhub');
    assert.equal(found[0].score > 1000, true, 'exact label match must outrank token accumulations'); // exact-match (+1000) on top of token scores
  });

  await t('MCP: recall returns node + notes + neighbors in one call', async () => {
    await j('POST', '/api/notes', { text: 'recall probe: uses optimistic caching layer', parent: projA.id, model: 'recall-pin' }, 200);
    await wait(400);
    const msgs = await mcpProc([
      { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'memhub_recall', arguments: { query: 'optimistic caching recall' } } },
    ]);
    assert.equal(msgs[0].result && msgs[0].result.isError === undefined, true, JSON.stringify(msgs[0]).slice(0, 300));
    const out = JSON.parse(msgs[0].result.content[0].text);
    const entry = out.find((x) => x.node.id === projA.id);
    assert.equal(entry !== undefined, true, 'target node missing from recall: ' + JSON.stringify(out.map((x) => x.node.id)));
    assert.equal(entry.notes.some((n) => n.text.includes('optimistic caching')), true);
    assert.equal(Array.isArray(entry.neighbors) && entry.neighbors.length > 0, true);
  });

  await t('MCP: errors (parse -32700, method -32601, tool isError)', async () => {
    const child = spawn('node', [path.join(__dirname, 'server', 'src', 'mcp.js')], { env: MB });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stdin.write('not-json\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'bogus' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'nope', arguments: {} } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'memhub_save_note', arguments: { text: '  ' } } }) + '\n');
    child.stdin.end();
    await new Promise((r) => child.on('close', r)); // asserts must not defer past t()
    const msgs = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(msgs[0].error.code, -32700);
    assert.equal(msgs[1].error.code, -32601);
    assert.equal(msgs[2].result.isError, true);
    assert.equal(msgs[3].result.isError, true);
  });

  await t('MCP: notification (no id) gets NO response', async () => {
    const msgs = await mcpProc([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'memhub_stats', arguments: {} } },
    ]);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].id, 7);
  });

  /* ---------- cross-process coherence ---------- */
  // Baseline must be STABLE (watcher can still be applying pending external
  // writes when the previous test ends); poll until two consecutive reads match.
  async function stableNotes() {
    let prev = -1;
    for (let i = 0; i < 12; i++) {
      const n = (await j('GET', '/api/health', null, 200)).json.counts.notes;
      if (n === prev) return n;
      prev = n;
      await wait(600);
    }
    return prev;
  }
  let beforeNotes;
  await t('coherence: MCP write visible to live HTTP server', async () => {
    beforeNotes = await stableNotes();
    await mcpProc([
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'memhub_save_note', arguments: { text: 'coherence probe while server live', model: 'coherence-mcp' } } },
    ]);
    let after = beforeNotes;
    for (let i = 0; i < 12 && after === beforeNotes; i++) {
      await wait(250);
      after = (await j('GET', '/api/health', null, 200)).json.counts.notes;
    }
    assert.equal(after, beforeNotes + 1);
  });

  await t('coherence: reverse direction (HTTP -> fresh MCP) + neighborhood', async () => {
    await j('POST', '/api/notes', { text: 'server wrote this first', model: 'http-side' }, 200);
    await wait(400);
    const msgs = await mcpProc([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memhub_list_notes', arguments: { q: 'server wrote this first' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memhub_neighborhood', arguments: { id: projA.id, hops: 1 } } },
    ]);
    const notes = JSON.parse(msgs[0].result.content[0].text);
    assert.equal(notes.some((n) => n.model === 'http-side'), true, JSON.stringify(msgs));
    assert.equal(msgs[1].error === undefined, true, JSON.stringify(msgs[1]));
    const nb = JSON.parse(msgs[1].result.content[0].text);
    assert.equal(nb.subgraph.nodes.length >= 2, true);
  });

  /* ---------- keep-alive guard: list/remember flake regression ---------- */
  await t('note delete logs reliably (regression)', async () => {
    const n = (await j('POST', '/api/notes', { text: 'delete-me probe', model: 'regress' }, 200)).json.note;
    const pre = (await j('GET', '/api/log?limit=100', null, 200)).json.log.length;
    await j('DELETE', `/api/notes/${n.id}`, null, 200);
    await wait(50);
    const tail = (await j('GET', '/api/log?limit=100', null, 200)).json.log;
    assert.equal(tail.length, pre + 1, `pre=${pre} post=${tail.length} tail=${JSON.stringify(tail.slice(-6))}`);
  });

  /* ---------- audit-fix pins ---------- */
  await t('validation: whitespace label -> 400, unknown type -> 400', async () => {
    const a = await j('POST', '/api/node', { type: 'project', label: '   ' });
    const b = await j('POST', '/api/node', { type: '<img src=x onerror>', label: 'x' });
    assert.equal(a.status, 400, JSON.stringify(a));
    assert.equal(b.status, 400, JSON.stringify(b));
  });

  await t('upsert: meta preserved when omitted, replaced when provided', async () => {
    const node = (await j('POST', '/api/node', { type: 'concept', label: 'meta-pin', meta: { keep: 'me' } }, 200)).json.node;
    const again = (await j('POST', '/api/node', { type: 'concept', label: 'meta-pin' }, 200)).json.node;
    assert.equal(again.meta.keep, 'me', JSON.stringify(again));
    const replaced = (await j('POST', '/api/node', { type: 'concept', label: 'meta-pin', meta: { fresh: 'yes' } }, 200)).json.node;
    assert.deepEqual(replaced.meta, { fresh: 'yes' });
    const empty = (await j('POST', '/api/node', { type: 'concept', label: 'meta-pin', meta: {} }, 200)).json.node;
    assert.deepEqual(empty.meta, { fresh: 'yes' }, 'empty meta object must not wipe');
    assert.equal(replaced.createdAt, node.createdAt);
  });

  await t('ghost deletes: node 404, note+edge idempotent 200', async () => {
    await j('DELETE', '/api/node/project:audit-ghost', null, 404);
    const de = await j('DELETE', '/api/edge/edge:nope::nope::related', null, 200);
    assert.equal(de.json.deleted, true);
    const dn = await j('DELETE', '/api/notes/note:never-existed', null, 200);
    assert.equal(dn.json.deleted, true);
  });

  await t('edge dedupe: same args twice -> one edge, same id', async () => {
    const before = (await j('GET', '/api/health', null, 200)).json.counts.edges;
    const a = (await j('POST', '/api/edge', { source: 'concept:meta-pin', target: projA.id, type: 'pins' }, 200)).json.edge;
    const b = (await j('POST', '/api/edge', { source: 'concept:meta-pin', target: projA.id, type: 'pins' }, 200)).json.edge;
    assert.equal(a.id, b.id);
    const after = (await j('GET', '/api/health', null, 200)).json.counts.edges;
    assert.equal(after, before + 1);
  });

  await t('query hops clamp + search limit coercion', async () => {
    const set = async (hops) => JSON.stringify((await j('GET', `/api/query/${encodeURIComponent(projA.id)}?hops=${hops}`, null, 200)).json.subgraph.nodes.map((n) => n.id).sort());
    assert.equal(await set(0), await set(2));
    assert.equal(await set(-3), await set(2));
    assert.equal(await set(999), await set(5));
    const s1 = (await j('GET', '/api/search?q=meta-pin&limit=0', null, 200)).json.results.length;
    const s2 = (await j('GET', '/api/search?q=meta-pin&limit=abc', null, 200)).json.results.length;
    assert.equal(s1 > 0 && s2 > 0, true);
    assert.equal((await j('GET', '/api/search?q=%20&limit=10', null, 200)).json.results.length, 0);
  });

  await t('graph route carries notes array with harness-consumed fields', async () => {
    const g = (await j('GET', '/api/graph', null, 200)).json;
    assert.equal(Array.isArray(g.notes), true);
    assert.equal(g.notes.length > 0, true);
    assert.equal(g.notes.every((n) => n.id && typeof n.text === 'string' && typeof n.createdAt === 'string'), true);
  });

  await t('graph3d pure: cosine/mutualKnn/communities', async () => {
    const g3 = require(path.join(__dirname, 'web', 'graph3d.js'));
    const A = [1, 0, 0], B = [1, 0, 0], C = [0, 1, 0], D = [0, 0, 1];
    const near = (x, y) => Math.abs(x - y) < 1e-9;
    assert.equal(near(g3.cosine(A, A), 1), true, 'self cosine');
    assert.equal(near(g3.cosine(A, C), 0), true, 'orthogonal cosine');
    assert.equal(near(g3.cosine([2, 0], [2, 0]), 1), true, 'renormalizes non-unit');

    const vecs = { A, B, C, D }, k = 2, minCos = 0.35;
    const links = g3.mutualKnn(vecs, k, minCos);
    assert.equal(links.length <= Math.floor(Object.keys(vecs).length * k / 2), true, 'at most k mutual pairs per side: ' + JSON.stringify(links));
    const keys = links.map((l) => [l.source, l.target].sort().join('|'));
    assert.equal(new Set(keys).size, keys.length, 'duplicate unordered pair: ' + JSON.stringify(keys));
    assert.equal(links.every((l) => l.sim >= minCos), true, 'sim below threshold leaked: ' + JSON.stringify(links));
    assert.equal(links.some((l) => l.source === 'A' && l.target === 'B' && near(l.sim, 1)), true, 'A-B mutual pair missing: ' + JSON.stringify(links));

    const groups = g3.communities(['a', 'b', 'c'], [{ source: 'a', target: 'b' }]);
    assert.equal(groups instanceof Map, true, 'communities returns Map');
    assert.equal(groups.get('a'), groups.get('b'), 'linked nodes share a group');
    assert.equal(groups.get('c'), -1, 'isolated node is -1');
    assert.deepEqual([...g3.communities(['a', 'b', 'c'], [{ source: 'a', target: 'b' }])], [...groups], 'deterministic');
  });

  await t('layout pure: buildLinks + computeLayout deterministic, finite coords', async () => {
    const L = require(path.join(__dirname, 'server', 'src', 'layout.js'));
    const g3 = require(path.join(__dirname, 'web', 'graph3d.js'));
    const A = [1, 0, 0], B = [1, 0, 0], C = [0, 1, 0], D = [0, 0, 1];
    const nodes = { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' }, d: { id: 'd' } };
    const vec = { a: A, b: B, c: C, d: D };
    const edges = [{ id: 'e1', source: 'a', target: 'b' }];

    const links = L.buildLinks(nodes, vec, edges);
    assert.equal(links[0].source === 'a' && links[0].target === 'b' && links[0].real === 1, true,
      'real edge first, flagged real: ' + JSON.stringify(links));
    // server kNN agrees with browser kNN on the remaining sim links
    const browserKnn = (await Promise.resolve(g3.mutualKnn(vec, L.KNN_K, L.MIN_COS)))
      .filter((l) => !(l.source === 'a' && l.target === 'b'));
    const simLinks = links.filter((l) => !l.real);
    const keyOf = (l) => [l.source, l.target].sort().join('|');
    assert.deepEqual(simLinks.map(keyOf).sort(), browserKnn.map(keyOf).sort(), 'server vs browser mutualKnn differ');
    assert.equal(links.every((l) => l.w > 0 && (l.real || l.sim >= L.MIN_COS)), true, 'bad weights: ' + JSON.stringify(links));

    const r1 = L.computeLayout(Object.keys(nodes).sort(), links, vec);
    const r2 = L.computeLayout(Object.keys(nodes).sort(), links, vec);
    assert.equal(r1.hash, r2.hash, 'hash not deterministic');
    assert.deepEqual(r1.positions, r2.positions, 'positions not deterministic');
    for (const id of Object.keys(nodes)) {
      const p = r1.positions[id];
      assert.equal(Array.isArray(p) && p.length === 3 && p.every((x) => Number.isFinite(x)), true,
        `coord for ${id} not finite: ${JSON.stringify(p)}`);
    }
    // d-d is orthogonal-pair (cos 0) -> no sim link; a-b identical -> pair exists
    assert.equal(simLinks.some((l) => keyOf(l) === 'a|b'), false, 'real-edge pair duplicated by kNN');
  });

  await t('/api/layout: ready, full coverage, stable hash, rev present', async () => {
    const first = (await j('GET', '/api/layout', null, 200)).json;
    assert.equal(first.status, 'ready', JSON.stringify(first.status));
    assert.equal(typeof first.hash, 'string', 'missing hash');
    assert.equal(typeof first.rev, 'number', 'missing rev');
    assert.equal(Array.isArray(first.links), true, 'missing links');
    const nodes = (await j('GET', '/api/graph', null, 200)).json.nodes.map((n) => n.id);
    for (const id of nodes) {
      const p = first.positions[id];
      assert.equal(Array.isArray(p) && p.length === 3 && p.every((x) => Number.isFinite(x)), true,
        `no layout position for ${id}`);
    }
    // idempotent: second read unchanged while data unchanged
    const second = (await j('GET', '/api/layout', null, 200)).json;
    assert.equal(second.hash, first.hash, 'hash changed without data change');
    assert.deepEqual(second.positions, first.positions, 'positions changed without data change');
    // links reference existing nodes only
    const set = new Set(nodes);
    for (const l of first.links) {
      assert.equal(set.has(l.source) && set.has(l.target), true, `link to unknown node: ${JSON.stringify(l)}`);
    }
  });

  await t('layout persists to store.json with served hash', async () => {
    const served = (await j('GET', '/api/layout', null, 200)).json;
    await wait(450); // debounced save lands
    const onDisk = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    assert.equal(onDisk.layout && typeof onDisk.layout, 'object', 'layout section missing on disk');
    assert.equal(onDisk.layout.hash, served.hash, 'disk hash != served hash');
    const ids = Object.keys(served.positions);
    assert.equal(ids.length > 0, true, 'served layout has no positions');
    assert.equal(ids.every((id) => Array.isArray(onDisk.layout.positions[id])), true, 'positions missing on disk');
  });

  await t('recall budget: truncation marker + payload inside tiny cap', async () => {
    await j('POST', '/api/node', { type: 'concept', label: 'budget cut sentence' }, 200);
    // ~2600 chars: way past budget 300, marker must appear with honest count
    const filler = [];
    for (let i = 0; i < 26; i++) filler.push('alpha bravo charlie delta echo foxtrot golf hotel india juliet zulu' + String(i).padStart(2, '0'));
    await j('POST', '/api/notes', {
      text: 'budget-cut-sentence ' + filler.join(' ') + '. terminal tail token.',
      parent: 'concept:budget-cut-sentence',
      model: 'budget-test',
    }, 200);
    await wait(300);
    const msgs = await mcpProc([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memhub_recall', arguments: { query: 'budget-cut-sentence', budget: 300 } } },
    ]);
    assert.equal(msgs[0]._bad, undefined, JSON.stringify(msgs[0]).slice(0, 300));
    const body = JSON.parse(msgs[0].result.content[0].text);
    assert.equal(body.tokens != null && typeof body.tokens === 'object', true, 'stats missing: ' + JSON.stringify(body).slice(0, 120));
    assert.equal(body.tokens.used <= 300, true, `reported used ${body.tokens.used} > budget 300: ` + JSON.stringify(body.tokens));
    const top = body.nodes.find((n) => n.node.id === 'concept:budget-cut-sentence');
    assert.equal(!!top, true, 'probe node missing from payload: ' + JSON.stringify(body.nodes.map((x) => x.node.id)));
    assert.equal(top.notes.some((n) => /\.\.\.\(\+\d+ chars\)$/.test(n.text)), true, 'top note not truncated: ' + JSON.stringify(top.notes.map((n) => n.text).join('|')).slice(0, 200));
  });

  await t('recall budget: near-duplicate notes deduped payload-wide', async () => {
    await j('POST', '/api/node', { type: 'concept', label: 'budget dedupe' }, 200);
    await j('POST', '/api/notes', { text: 'the layout engine stores deterministic three-dimensional coordinates for every node in the graph throughout the shared store and also writes them to disk for later reuse by any agent that asks for coordinates', parent: 'concept:budget-dedupe', model: 'budget-test' }, 200);
    await j('POST', '/api/notes', { text: 'the layout engine stores deterministic three-dimensional coordinates for every node in the graph throughout the shared store and also writes them to disk for later reuse by whichever agent requests coordinates again', parent: 'concept:budget-dedupe', model: 'budget-test' }, 200);
    await wait(300);
    const msgs = await mcpProc([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memhub_recall', arguments: { query: 'budget-dedupe', budget: 1800 } } },
    ]);
    assert.equal(msgs[0]._bad, undefined, JSON.stringify(msgs[0]).slice(0, 300));
    const body = JSON.parse(msgs[0].result.content[0].text);
    assert.equal(body.tokens != null && typeof body.tokens === 'object', true, 'stats missing: ' + JSON.stringify(body).slice(0, 200));
    assert.equal(body.tokens.dupesDropped >= 1, true, 'dedupe dropped nothing: ' + JSON.stringify(body.tokens));
    const top = body.nodes.find((n) => n.node.id === 'concept:budget-dedupe');
    assert.equal(!!top, true, 'dedupe probe node missing');
    assert.equal(top.notes.length, 1, `near-dupes both survived: ${top.notes.length} notes`);
  });

  await t('recall without budget: legacy shape unchanged', async () => {
    const msgs = await mcpProc([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memhub_recall', arguments: { query: 'budget-dedupe' } } },
    ]);
    const body = JSON.parse(msgs[0].result.content[0].text);
    assert.equal(Array.isArray(body), true, 'legacy recall returns array');
    assert.equal(body[0].node.meta !== undefined, true, 'legacy payload keeps meta');
    assert.equal(!!body[0].node.updatedAt, true, 'legacy payload keeps updatedAt');
    assert.equal(Array.isArray(body[0].neighbors), true, 'legacy neighbors array');
  });

  await t('/api/node origin: models + sessions provenance', async () => {
    await j('POST', '/api/sessions', { model: 'claude-opus-4-6', agent: 'claude-code' }, 200);
    const nid = 'concept:origin-probe';
    await j('POST', '/api/node', { type: 'concept', label: 'origin probe' }, 200);
    await j('POST', '/api/notes', { text: 'origin probe note one', parent: nid, model: 'claude-opus-4-6', tags: ['probe'] }, 200);
    await j('POST', '/api/notes', { text: 'origin probe note two', parent: nid, model: 'opencode-glm-5.3-flash-free' }, 200);
    const detail = (await j('GET', `/api/node/${encodeURIComponent(nid)}`, null, 200)).json;
    const models = (detail.origin.models || []).map((m) => m.model);
    assert.equal(models.includes('claude-opus-4-6'), true, JSON.stringify(detail.origin));
    assert.equal(models.includes('opencode-glm-5.3-flash-free'), true, JSON.stringify(detail.origin));
    assert.deepEqual(detail.origin.models.map((m) => m.notes), [1, 1], 'note counts wrong: ' + JSON.stringify(detail.origin.models));
    // no-provenance node: empty but present
    await j('POST', '/api/node', { type: 'concept', label: 'origin empty probe' }, 200);
    const bare = (await j('GET', `/api/node/${encodeURIComponent('concept:origin-empty-probe')}`, null, 200)).json;
    assert.deepEqual(bare.origin, { models: [], sessions: [] }, JSON.stringify(bare.origin));
  });

  await t('MCP: oversized reply (1MB note) parses fully, no truncation', async () => {
    await j('POST', '/api/notes', { text: 'big-reply-marker ' + 'x'.repeat(1024 * 1024), model: 'big-reply' }, 200);
    await wait(400);
    const msgs = await mcpProc([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memhub_list_notes', arguments: { q: 'big-reply-marker' } } },
    ]);
    assert.equal(msgs[0]._bad, undefined, JSON.stringify(msgs[0]).slice(0, 200));
    const notes = JSON.parse(msgs[0].result.content[0].text);
    assert.equal(notes.length, 1, 'big note found');
    assert.equal(notes[0].text.length, ('big-reply-marker '.length + 1024 * 1024), 'note text intact');
  });

  /* ---------- shutdown + persistence ---------- */
  await t('persistence: debounce flush then kill, disk holds all', async () => {
    const counts = (await j('GET', '/api/health', null, 200)).json.counts;
    await wait(500);
    server.kill('SIGINT');
    await wait(400);
    const disk = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    assert.equal(Object.keys(disk.nodes).length, counts.nodes);
    assert.equal(disk.edges.length, counts.edges);
    assert.equal(Object.keys(disk.notes).length, counts.notes);
    assert.equal(Object.keys(disk.sessions).length, counts.sessions);
  });

  console.log(`\n${passed} passed, ${failed} failed${failures.length ? ' :: ' + failures.join(' | ') : ''}`);
  console.log(`data dir: ${DATA}`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  if (server) server.kill('SIGINT');
  console.error('SUITE ERROR:', err);
  process.exit(1);
});
