'use strict';
/* Focused flake hunter: mirror the sweep test; run reverse-coherence repeatedly and dump raw payloads on failure. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 4789;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'memhub-flake-'));
const ENV = { ...process.env, MEMHUB_PORT: String(PORT), MEMHUB_DATA: DATA };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function mj(method, p, body) {
  const res = await fetch(BASE + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let json = {};
  try { json = await res.json(); } catch { json = { _raw: 'unparseable' }; }
  return { status: res.status, json };
}

function mcp(lines) {
  return new Promise((resolve) => {
    const c = spawn('node', [path.join(__dirname, '..', 'server', 'src', 'mcp.js')], { env: ENV, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => resolve(out.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { _bad: l }; } })));
    c.stdin.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    c.stdin.end();
  });
}

async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server', 'src', 'index.js')], { env: ENV, stdio: ['pipe', 'pipe', 'inherit'] });
  for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/api/health`); break; } catch { await wait(100); } }

  const proj = (await mj('POST', '/api/node', { type: 'project', label: 'TestApp' })).json.node;
  await mj('POST', '/api/edge', { source: proj.id, target: 'concept:dependency-injection', type: 'uses' });
  const P = proj.id;
  let fails = 0;
  for (let round = 1; round <= 6; round++) {
    await mj('POST', '/api/notes', { text: `probe note round ${round}`, model: 'http-side' });
    await wait(420);
    const msgs = await mcp([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memhub_list_notes', arguments: { q: `round ${round}` } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memhub_neighborhood', arguments: { id: P, hops: 1 } } },
    ]);
    let ok = true, info = [];
    try {
      const notes = JSON.parse(msgs[0].result.content[0].text);
      ok = ok && notes.length === 1;
      info.push(`notes(${notes.length})`);
    } catch (e) { ok = false; info.push(`list:${e.message} raw=${JSON.stringify(msgs[0])}`); }
    try {
      const nb = JSON.parse(msgs[1].result.content[0].text);
      ok = ok && nb.subgraph && nb.subgraph.nodes.length >= 2;
      info.push(`nb(${nb.subgraph ? nb.subgraph.nodes.length : 'NOSUB'}), err=${msgErr(msgs[1])}`);
    } catch (e) { ok = false; info.push(`nb:${e.message} raw=${JSON.stringify(msgs[1]).slice(0, 300)}`); }
    console.log(`round ${round}: ${ok ? 'ok' : 'FAIL'} :: ${info.join(' | ')}`);
    if (!ok) fails++;
  }
  server.kill('SIGINT');
  console.log(`\nflake-hunter done: ${fails} failing rounds`);
  process.exit(fails ? 1 : 0);
}
function msgErr(m) { return m && m.error ? (m.error.message || JSON.stringify(m.error)) : (m && m.result && m.result.isError ? m.result.content[0].text : 'none'); }
main().catch((e) => { console.error(e); process.exit(1); });
