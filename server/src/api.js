'use strict';

const store = require('./store');
const graph = require('./graph');

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
      return respond(res, 200, { nodes: Object.values(s.nodes), edges: s.edges, notes: Object.values(s.notes) });
    }

    // ---- stats ----
    if (method === 'GET' && path === '/api/stats') {
      return respond(res, 200, graph.stats());
    }

    // ---- node: get ----
    let m = path.match(/^\/api\/node\/(.+)$/);
    if (m && method === 'GET') {
      const id = store.resolveId(m[1]);
      if (!id || !store.getStore().nodes[id]) return respond(res, 404, { error: 'node not found' });
      const s = store.getStore();
      const node = s.nodes[id];
      const edges = s.edges.filter((e) => e.source === id || e.target === id);
      const nbMap = graph.neighbors(id, 1);
      const nids = new Set();
      for (const e of edges) {
        nids.add(e.source);
        nids.add(e.target);
      }
      nids.delete(id);
      const neighbors = [...nids].map((n) => s.nodes[n]).filter(Boolean);
      const notes = Object.values(s.notes).filter((n) => n.parent === id);
      return respond(res, 200, { node, edges, neighbors, notes });
    }

    // ---- node: create/upsert ----
    if (method === 'POST' && path === '/api/node') {
      const bad = requireStrings(body, ['type', 'label']);
      if (bad) return respond(res, bad.code, bad);
      const node = store.upsertNode(body.type, body.label, body.meta);
      store.saveDebounced();
      return respond(res, 200, { node });
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

    // ---- query / neighborhood ----
    m = path.match(/^\/api\/query\/(.+)$/);
    if (m && method === 'GET') {
      const id = store.resolveId(m[1]);
      const hops = parseInt(url.searchParams.get('hops'), 10);
      const r = graph.neighbors(id, Number.isFinite(hops) && hops >= 1 ? hops : 2);
      return respond(res, 200, { center: r.center, subgraph: r.subgraph });
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
