'use strict';

const store = require('./store');
const graph = require('./graph');
const embedModule = require('./embed');

const BODY_LIMIT = 2 * 1024 * 1024;

function respond(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject({ code: 413, error: 'body too large' });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject({ code: 400, error: 'invalid JSON' });
      }
    });
    req.on('error', () => reject({ code: 400, error: 'request error' }));
  });
}

function fail(err) {
  if (err && typeof err === 'object' && 'code' in err && 'error' in err) return err;
  return { code: 500, error: err && err.message ? err.message : String(err) };
}

// Vector change token for the client. Vectors stay out of /api/graph (payload
// size); the client refetches /api/embeddings only when this token moves.
function embedRev(s) {
  let count = 0;
  let sumAt = 0;
  for (const n of Object.values(s.nodes)) {
    const e = n.embedding;
    if (!e || !Array.isArray(e.v) || !e.v.length) continue;
    count++;
    sumAt += Number(e.at) || 0;
  }
  return count ? `${count}:${sumAt}` : 0;
}

function publicNode(n) {
  const copy = { ...n };
  delete copy.embedding;
  return copy;
}

// Path is decoded exactly once here. id segments must NOT be decoded again
// (a literal '%' in a real node id is legitimate; second decode throws URIError).
function requireStrings(body, keys) {
  for (const k of keys) {
    if (typeof body[k] !== 'string' || !body[k].trim().length) {
      return { code: 400, error: `missing field: ${k}` };
    }
  }
  return null;
}

async function handle(req, res, url) {
  const method = req.method;
  try {
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      return respond(res, 400, { error: 'bad path encoding' });
    }

    let body = {};
    if (method === 'POST') body = await readBody(req);

    // ---- health ----
    if (method === 'GET' && path === '/api/health') {
      const s = store.getStore();
      return respond(res, 200, {
        ok: true,
        version: '1.0.0',
        counts: {
          nodes: Object.keys(s.nodes).length,
          edges: s.edges.length,
          notes: Object.keys(s.notes).length,
          sessions: Object.keys(s.sessions).length,
        },
      });
    }

    // ---- full graph ----
    if (method === 'GET' && path === '/api/graph') {
      const s = store.getStore();
      return respond(res, 200, {
        nodes: Object.values(s.nodes).map(publicNode),
        edges: s.edges,
        notes: Object.values(s.notes),
        embedRev: embedRev(s),
      });
    }

    // ---- cached vectors (fetched separately from the graph) ----
    if (method === 'GET' && path === '/api/embeddings') {
      const s = store.getStore();
      const vectors = {};
      for (const n of Object.values(s.nodes)) {
        if (n.embedding && Array.isArray(n.embedding.v) && n.embedding.v.length) {
          vectors[n.id] = n.embedding.v;
        }
      }
      // Repeats converge: missing/stale vectors get queued while the engine is up.
      if (embedModule.status().status === 'ready') {
        for (const n of Object.values(s.nodes)) {
          if (store.needsEmbedding(n.id)) store.refreshEmbedding(n.id); // fire-and-forget, deduped
        }
      }
      return respond(res, 200, {
        status: embedModule.status(),
        rev: embedRev(s),
        dim: embedModule.EMBED_DIM,
        vectors,
      });
    }

    // ---- stats ----
    if (method === 'GET' && path === '/api/stats') {
      return respond(res, 200, graph.stats());
    }

    // ---- token savings ledger (bar in the UI; per-session rollups) ----
    if (method === 'GET' && path === '/api/tokens') {
      const t = store.tokenUsage();
      return respond(res, 200, { all: t.all, sessions: t.sessions });
    }

    // ---- deterministic 3D layout (positions + union graph) ----
    if (method === 'GET' && path === '/api/layout') {
      const s = store.getStore();
      const cur = store.ensureLayout();
      const status = cur && cur.status === 'ready'
        ? { status: 'ready', hash: cur.hash, positions: cur.positions, links: cur.links }
        : { status: 'stale', hash: (s.layout && s.layout.hash) || null,
            positions: (s.layout && s.layout.positions) || {}, links: (s.layout && s.layout.links) || [] };
      return respond(res, 200, { rev: embedRev(s), ...status });
    }

    // ---- embedding engine status (UI decides whether to show vector fallbacks) ----
    if (method === 'GET' && path === '/api/embed/status') {
      return respond(res, 200, embedModule.status());
    }

    // ---- node: get ----
    let m = path.match(/^\/api\/node\/(.+)$/);
    if (m && method === 'GET') {
      const id = store.resolveId(m[1]);
      if (!id || !store.getStore().nodes[id]) return respond(res, 404, { error: 'node not found' });
      const s = store.getStore();
      const node = s.nodes[id];
      const edges = store.edgesOf(id);
      const nids = new Set();
      for (const e of edges) {
        nids.add(e.source);
        nids.add(e.target);
      }
      nids.delete(id);
      const neighbors = [...nids].map((n) => s.nodes[n]).filter(Boolean).map(publicNode);
      const notes = Object.values(s.notes).filter((n) => n.parent === id);
      return respond(res, 200, {
        node: publicNode(node),
        edges,
        neighbors,
        notes,
        origin: store.nodeOrigin(id),
      });
    }

    // ---- node: create/upsert ----
    if (method === 'POST' && path === '/api/node') {
      const bad = requireStrings(body, ['type', 'label']);
      if (bad) return respond(res, bad.code, bad);
      const node = store.upsertNode(body.type, body.label, body.meta);
      store.saveDebounced();
      return respond(res, 200, { node: publicNode(node) });
    }

    // ---- node: delete ----
    if (m && method === 'DELETE') {
      const id = store.resolveId(m[1]);
      if (!id || !store.getStore().nodes[id]) return respond(res, 404, { error: 'node not found' });
      store.deleteNode(id);
      store.saveDebounced();
      return respond(res, 200, { deleted: true });
    }

    // ---- edge: create/upsert ----
    if (method === 'POST' && path === '/api/edge') {
      const bad = requireStrings(body, ['source', 'target']);
      if (bad) return respond(res, bad.code, bad);
      const edge = store.upsertEdge(body.source, body.target, body.type, body.weight);
      store.saveDebounced();
      return respond(res, 200, { edge });
    }

    // ---- edge: delete ----
    m = path.match(/^\/api\/edge\/(.+)$/);
    if (m && method === 'DELETE') {
      store.deleteEdge(m[1]);
      store.saveDebounced();
      return respond(res, 200, { deleted: true });
    }

    // ---- notes ----
    if (method === 'POST' && path === '/api/notes') {
      if (typeof body.text !== 'string' || !body.text.trim().length) {
        return respond(res, 400, { error: 'missing field: text' });
      }
      const note = store.addNote(body);
      store.saveDebounced();
      return respond(res, 200, { note });
    }

    if (method === 'GET' && path === '/api/notes') {
      const parent = url.searchParams.get('parent');
      const q = url.searchParams.get('q');
      const tag = url.searchParams.get('tag');
      let notes = Object.values(store.getStore().notes);
      if (parent) notes = notes.filter((n) => n.parent === parent);
      if (q) {
        const ql = q.toLowerCase();
        notes = notes.filter((n) => n.text.toLowerCase().includes(ql));
      }
      if (tag) notes = notes.filter((n) => Array.isArray(n.tags) && n.tags.includes(tag));
      return respond(res, 200, { notes });
    }

    m = path.match(/^\/api\/notes\/(.+)$/);
    if (m && method === 'DELETE') {
      store.deleteNote(m[1]);
      store.saveDebounced();
      return respond(res, 200, { deleted: true });
    }

    // ---- sessions ----
    if (method === 'POST' && path === '/api/sessions') {
      const bad = requireStrings(body, ['model']);
      if (bad) return respond(res, bad.code, bad);
      const session = store.addSession(body);
      store.saveDebounced();
      return respond(res, 200, { session });
    }

    // ---- search ----
    if (method === 'GET' && path === '/api/search') {
      const q = url.searchParams.get('q') || '';
      const limit = parseInt(url.searchParams.get('limit'), 10) || 10;
      const results = graph.search(q, limit);
      return respond(res, 200, { results });
    }

    // ---- hybrid recall (token + semantic; token-only when engine is off) ----
    if (method === 'GET' && path === '/api/recall') {
      const q = url.searchParams.get('q') || '';
      const limit = parseInt(url.searchParams.get('limit'), 10) || 10;
      const budgetParam = parseInt(url.searchParams.get('budget'), 10);
      if (Number.isFinite(budgetParam) && budgetParam > 0) {
        const ranked = await graph.recall(q, limit, embedModule.embed);
        const session = url.searchParams.get('session');
        return respond(res, 200, { mode: ranked.mode, ranking: ranked.results, ...graph.recallContext(ranked.results, { budget: budgetParam, session }) });
      }
      const out = await graph.recall(q, limit, embedModule.embed);
      return respond(res, 200, out);
    }

    // ---- query / neighborhood ----
    m = path.match(/^\/api\/query\/(.+)$/);
    if (m && method === 'GET') {
      const id = store.resolveId(m[1]);
      const hops = parseInt(url.searchParams.get('hops'), 10);
      const r = graph.neighbors(id, Number.isFinite(hops) && hops >= 1 ? hops : 2);
      const subgraph = { ...r.subgraph, nodes: r.subgraph.nodes.map(publicNode) };
      return respond(res, 200, { center: r.center, subgraph });
    }

    // ---- backup ----
    if (method === 'POST' && path === '/api/backup') {
      return respond(res, 200, graph.makeBackupFile());
    }

    // ---- log ----
    if (method === 'GET' && path === '/api/log') {
      const limitRaw = parseInt(url.searchParams.get('limit'), 10);
      const limit = Number.isFinite(limitRaw) && limitRaw >= 0 ? limitRaw : 50;
      const log = store.getStore().log;
      const out = limit ? log.slice(-limit) : [];
      return respond(res, 200, { log: out });
    }

    return respond(res, 404, { error: 'not found' });
  } catch (err) {
    const f = fail(err);
    respond(res, f.code, { error: f.error });
    if (f.code === 413) req.destroy();
    return;
  }
}

module.exports = { handle };
