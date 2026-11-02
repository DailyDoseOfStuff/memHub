const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.MEMHUB_DATA || path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const TMP_FILE = STORE_FILE + '.tmp';
const SAVE_DELAY = 250;
const LOG_CAP = 500;

let store = null;
let saveTimer = null;
let lastSavedMtime = 0;
let watchArmed = false;
let dirty = false;
let deferExternalUntil = 0;
let closing = false;
let watcher = null;

// Adjacency index: nodeId -> array of touching edges, rebuilt lazily after
// any edge/reload mutation. Turns BFS/degree lookups from O(E) scans into
// O(degree) index reads.
let adjIndex = null;
function invalidateEdges() {
  adjIndex = null;
}
function edgesOf(id) {
  if (!adjIndex) {
    const idx = new Map();
    for (const e of store.edges) {
      let a = idx.get(e.source);
      if (!a) idx.set(e.source, (a = []));
      a.push(e);
      let b = idx.get(e.target);
      if (!b) idx.set(e.target, (b = []));
      b.push(e);
    }
    adjIndex = idx;
  }
  return adjIndex.get(id) || [];
}

function dbg(msg) {
  if (process.env.MEMHUB_DEBUG) console.error(`[dbg pid=${process.pid} t=${Date.now() % 100000}] ${msg}`);
}

// Mutators mark dirty and schedule a save. A queued save must never fire on a
// reloaded foreign snapshot, so the watcher defers reloads while dirty.
function schedDirtySave() {
  dirty = true;
  if (closing) return; // exit path: no new timer, loop must be able to drain
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, SAVE_DELAY);
}

function emptyStore() {
  return { version: 1, nodes: {}, edges: [], notes: {}, sessions: {}, log: [] };
}

function ensureDefaults(s) {
  if (!s.nodes) s.nodes = {};
  if (!Array.isArray(s.edges)) s.edges = [];
  if (!s.notes) s.notes = {};
  if (!s.sessions) s.sessions = {};
  if (!Array.isArray(s.log)) s.log = [];
  if (!s.layout || typeof s.layout !== 'object') s.layout = { hash: null, positions: {}, links: [] };
  if (!s.layout.positions || typeof s.layout.positions !== 'object') s.layout.positions = {};
  if (!Array.isArray(s.layout.links)) s.layout.links = [];
  s.version = 1;
  return s;
}

// --- multi-process coherence: HTTP server + MCP processes share one store.json.
// fs.watchFile picks up writes made by other processes and reloads them.
// Rule: unflushed local state (dirty) is never clobbered by a foreign write —
// the reload is deferred; after the local flush lands, a later poll re-checks.
function watchExternal() {
  if (watchArmed) return;
  watchArmed = true;
  watcher = fs.watchFile(STORE_FILE, { interval: 500 }, (curr) => {
    if (!curr || curr.size === 0) return;
    if (dirty) {
      dbg('watcher: dirty, deferring');
      return;
    }
    if (Math.abs(curr.mtimeMs - lastSavedMtime) < 1) return; // our own write
    dbg(`watcher: external change (mtime=${Math.round(curr.mtimeMs)}, lastSaved=${Math.round(lastSavedMtime)})`);
    try {
      const loaded = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      if (loaded && typeof loaded === 'object') {
        ensureDefaults(loaded);
        invalidateEdges();
        store = loaded;
        dbg(`watcher: reloaded (notes=${Object.keys(store.notes).length}, nodes=${Object.keys(store.nodes).length})`);
      }
    } catch {
      // foreign/partial write or parse failure: ignore, keep current memory
    }
  });
}

function nowIso() {
  return new Date().toISOString();
}

const NODE_TYPES = new Set(['project', 'file', 'concept', 'person', 'decision', 'session', 'note']);

function slugify(label) {
  return String(label).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function sanitizePath(label) {
  return String(label).toLowerCase().trim().replace(/\\/g, '/');
}

function nodeIdFor(type, label) {
  const sanitized = type === 'file' || type === 'project' ? sanitizePath(label) : slugify(label);
  return `${type}:${sanitized}`;
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let loaded = null;
  if (fs.existsSync(STORE_FILE)) {
    try {
      loaded = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    } catch (err) {
      loaded = null;
    }
  }
  store = ensureDefaults(loaded || emptyStore());
  invalidateEdges();
  watchExternal();
  return store;
}

function getStore() {
  return store;
}

// Atomic write: temp file then rename over the real one.
// Flags reset only after the rename lands — a failed flush must leave us dirty
// so the flush is retried instead of silently dropping committed mutations.
function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!dirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    dbg(`saveNow: writing (notes=${Object.keys(store.notes).length}, nodes=${Object.keys(store.nodes).length})`);
    fs.writeFileSync(TMP_FILE, JSON.stringify(store)); // compact: vectors dominate the payload
    fs.renameSync(TMP_FILE, STORE_FILE);
  } catch (err) {
    dbg(`saveNow: FAILED: ${err.code} ${err.message}`);
    dirty = true;
    if (!closing) schedDirtySave(); // retry loop until it lands (dbg-tagged)
    return;
  }
  dirty = false;
  try {
    lastSavedMtime = fs.statSync(STORE_FILE).mtimeMs;
  } catch {
    lastSavedMtime = 0;
  }
  dbg('saveNow: flushed');
}

function saveDebounced() {
  schedDirtySave();
}

// Flush only if local mutations exist (used by short-lived MCP/CLI processes on exit).
function flushIfDirty() {
  if (dirty) saveNow();
}

// Exit path: stop the watchFile keepalive, flush pending writes, let stdout
// drain and the loop exit naturally (process.exitCode set by callers).
function closeForExit() {
  closing = true;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (watcher && watcher.unref) watcher.unref();
  flushIfDirty();
}
function upsertNode(type, label, meta) {
  if (!NODE_TYPES.has(type)) throw { code: 400, error: `unknown type: ${type}` };
  const hasMeta = !!meta && typeof meta === 'object' && Object.keys(meta).length > 0;
  const id = nodeIdFor(type, label);
  const existing = store.nodes[id];
  if (existing) {
    existing.label = label;
    if (hasMeta) existing.meta = meta;
    existing.updatedAt = nowIso();
    schedDirtySave();
    refreshEmbedding(id); // label/meta may have changed the embed text
    return existing;
  }
  const node = {
    id,
    type,
    label,
    meta: meta && typeof meta === 'object' ? meta : {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.nodes[id] = node;
  appendLog('node.create', id);
  schedDirtySave();
  refreshEmbedding(id);
  return node;
}

function deleteNode(id) {
  if (!store.nodes[id]) return false;
  delete store.nodes[id];
  invalidateEdges();
  store.edges = store.edges.filter((e) => e.source !== id && e.target !== id);
  for (const note of Object.values(store.notes)) {
    if (note.parent === id) note.parent = null;
  }
  embedSeq.delete(id);
  embedInflight.delete(id);
  appendLog('node.delete', id);
  schedDirtySave();
  return true;
}

function upsertEdge(source, target, type, weight) {
  source = ensureConceptNode(source);
  target = ensureConceptNode(target);
  invalidateEdges();
  const id = `edge:${source}::${target}::${type || 'related'}`;
  const existing = store.edges.find((e) => e.id === id);
  if (existing) {
    existing.type = type || 'related';
    if (weight != null) existing.weight = weight;
    schedDirtySave();
    return existing;
  }
  const edge = {
    id,
    source,
    target,
    type: type || 'related',
    weight: weight == null ? 1 : weight,
    meta: {},
    createdAt: nowIso(),
  };
  store.edges.push(edge);
  appendLog('edge.create', `${source} -> ${target}`);
  schedDirtySave();
  return edge;
}

// Auto-create missing endpoint as a concept node (normalized id); returns canonical id.
function ensureConceptNode(rawId) {
  const raw = String(rawId);
  if (store.nodes[raw]) return raw;
  const id = `concept:${slugify(raw)}`;
  if (!store.nodes[id]) {
    store.nodes[id] = {
      id,
      type: 'concept',
      label: raw,
      meta: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    refreshEmbedding(id);
  }
  return id;
}

function deleteEdge(id) {
  const i = store.edges.findIndex((e) => e.id === id);
  if (i === -1) return false;
  invalidateEdges();
  store.edges.splice(i, 1);
  schedDirtySave();
  return true;
}

function addNote(data) {
  const { text, parent, tags, model, session } = data || {};
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) throw new Error('note text required');
  const id = `note:${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex').slice(0, 3)}`;
  const note = {
    id,
    parent: parent || null,
    text: trimmed,
    tags: Array.isArray(tags) ? tags : [],
    model: model || 'unknown',
    session: session || null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.notes[id] = note;
  appendLog('note.create', `${note.id} (${note.model})`);
  schedDirtySave();
  // Note text feeds the parent node's embedding; keep it current.
  if (note.parent) refreshEmbedding(note.parent);
  return note;
}

function deleteNote(id) {
  const note = store.notes[id];
  if (!note) return false;
  const parent = note.parent;
  delete store.notes[id];
  appendLog('note.delete', id);
  schedDirtySave();
  if (parent) refreshEmbedding(parent); // note text left the parent's embed text
  return true;
}

function addSession(data) {
  const { model, agent, summary } = data || {};
  const id = `session:${model || 'unknown'}-${Date.now().toString(36)}`;
  const session = {
    id,
    model: model || 'unknown',
    agent: agent || null,
    startedAt: nowIso(),
    summary: summary || '',
  };
  store.sessions[id] = session;
  upsertNode('session', id, {});
  appendLog('session.create', `${id} (${session.model})`);
  return session;
}

function appendLog(action, detail) {
  store.log.push({ ts: nowIso(), action, detail });
  if (store.log.length > LOG_CAP) store.log.splice(0, store.log.length - LOG_CAP);
  schedDirtySave();
}

function resolveId(id) {
  if (id == null) return null;
  const raw = String(id);
  if (store.nodes[raw]) return store.nodes[raw].id;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch (err) {
    decoded = raw;
  }
  if (store.nodes[decoded]) return store.nodes[decoded].id;
  const lower = decoded.toLowerCase();
  for (const key of Object.keys(store.nodes)) {
    if (key.toLowerCase() === lower) return key;
  }
  return null;
}

// ponytail: embedding text = label + id + meta + one-hop neighbor labels +
// notes. Graph context gives bare-label nodes ("app.js") something to match a
// paraphrase against; the eval (eval/recall.js) is the judge of this recipe.
// Cap keeps one huge note from dominating the model's ~256-token window.
const EMBED_TEXT_CAP = 2000;
function nodeEmbedText(s, id) {
  const node = s.nodes[id];
  if (!node) return '';
  const parts = [node.label || '', node.id];
  const meta = node.meta || {};
  for (const k of Object.keys(meta)) parts.push(k, String(meta[k]));
  const linked = [];
  for (const e of s.edges) {
    const other = e.source === id ? e.target : e.target === id ? e.source : null;
    if (!other) continue;
    const on = s.nodes[other];
    if (on && on.label) linked.push(on.label);
    if (linked.length >= 20) break;
  }
  if (linked.length) parts.push('linked to', ...linked);
  let text = parts.join(' ');
  for (const n of Object.values(s.notes)) {
    if (text.length >= EMBED_TEXT_CAP) break;
    if (n.parent === id && n.text) text += ' ' + n.text;
  }
  return text.slice(0, EMBED_TEXT_CAP);
}

function embedHash(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

// Embedding engine is injected at startup (web/api + MCP entrypoints).
// Fire-and-forget vector refresh; no engine or model-not-ready = no-op and
// the startup backfill (or a later save) converges.
let embedEngine = null;
const embedSeq = new Map(); // id -> generation; late writes lose
const embedInflight = new Map(); // id -> promise; duplicate refreshes share it

// True when the node has no vector, a failed refresh, or text newer than the vector.
function needsEmbedding(id) {
  const n = store.nodes[id];
  if (!n) return false;
  const e = n.embedding;
  if (!e || !Array.isArray(e.v) || !e.v.length) return true;
  return !!e.stale || e.hash !== embedHash(nodeEmbedText(store, id));
}

function setEmbedEngine(engine) {
  embedEngine = engine; // { embed(text): Promise<float[]|null>, model }
}

function refreshEmbedding(id) {
  if (!embedEngine || !store.nodes[id]) return Promise.resolve(null);
  const text = nodeEmbedText(store, id);
  const hash = embedHash(text);
  const cur = store.nodes[id];
  const emb = cur.embedding;
  const running = embedInflight.get(id);
  if (running) return running; // same-id refresh already in flight
  if (emb && Array.isArray(emb.v) && emb.v.length && emb.hash === hash && !emb.stale) {
    return Promise.resolve(emb); // unchanged text: no inference, no rev bump
  }

  const seq = (embedSeq.get(id) || 0) + 1;
  embedSeq.set(id, seq);
  const markStale = () => {
    const c = store.nodes[id];
    if (!c || !c.embedding || !Array.isArray(c.embedding.v) || !c.embedding.v.length) return;
    if (!c.embedding.stale) {
      c.embedding.stale = true;
      schedDirtySave();
    }
  };
  const p = Promise.resolve().then(() => embedEngine.embed(text)).then((v) => {
    if (embedInflight.get(id) === p) embedInflight.delete(id);
    if (embedSeq.get(id) !== seq) return null;
    const c = store.nodes[id];
    if (!c) return null;
    if (!v || !v.length) {
      markStale(); // keep the last good vector, retry next staleness pass
      return null;
    }
    c.embedding = { model: embedEngine.model, dim: v.length, v, at: Date.now(), hash, stale: false };
    schedDirtySave();
    return c.embedding;
  }).catch(() => {
    if (embedInflight.get(id) === p) embedInflight.delete(id);
    if (embedSeq.get(id) === seq) markStale();
    return null;
  });
  embedInflight.set(id, p);
  return p;
}

// --- deterministic 3D layout (see server/src/layout.js) ---------------------
// Cached in store.json under `layout`; recomputed only when the layout-hash
// (node ids + vector hashes + union graph) changes. Sync for small graphs,
// background for large ones so the request loop never stalls.
const layout = require('./layout');
let layoutInflight = false;

function layoutReady(storeObj) {
  if (layoutInflight) return null;
  const s = storeObj || store;
  const vec = {};
  for (const id of Object.keys(s.nodes).sort()) {
    const e = s.nodes[id].embedding;
    if (e && Array.isArray(e.v) && e.v.length) vec[id] = { hash: e.hash, v: e.v };
  }
  const links = layout.buildLinks(s.nodes, vec, s.edges);
  const hash = layout.layoutHashStore(vec, links);
  if (s.layout && s.layout.hash === hash) {
    return { hash, positions: s.layout.positions, links: s.layout.links, status: 'ready' };
  }
  return { targetHash: hash };
}

function ensureLayout() {
  const s = store;
  const ready = layoutReady(s);
  if (!ready || ready.status === 'ready') return ready; // up to date (or inflight)
  const { targetHash } = ready;
  const n = Object.keys(s.nodes).length;
  if (n > 400) {
    // Background: /api/layout still answers with the previous map + status
    // stale; the next poll (embeddings/UI poll every 5s) picks up the result.
    if (layoutInflight) return ready;
    layoutInflight = true;
    setImmediate(() => {
      try {
        computeAndStoreLayout(s, targetHash);
      } finally {
        layoutInflight = false;
      }
    });
    return ready;
  }
  return computeAndStoreLayout(s, targetHash);
}

function computeAndStoreLayout(s, expectedHash) {
  // rebuild inputs (state may have moved since the hash was taken)
  const ready = layoutReady(s);
  if (ready && ready.status === 'ready') return ready;
  const vec = {};
  for (const id of Object.keys(s.nodes).sort()) {
    const e = s.nodes[id].embedding;
    if (e && Array.isArray(e.v) && e.v.length) vec[id] = { hash: e.hash, v: e.v };
  }
  const links = layout.buildLinks(s.nodes, vec, s.edges);
  const ids = Object.keys(s.nodes).sort();
  const { hash, positions } = layout.computeLayout(ids, links, vec);
  if (hash !== expectedHash) return layoutReady(s); // raced with a write; next poll retries
  s.layout.hash = hash;
  s.layout.positions = positions;
  s.layout.links = links;
  schedDirtySave();
  appendLog('layout', { nodes: ids.length, links: links.length });
  return { hash, positions, links, status: 'ready' };
}

function getLayoutStatus(storeObj) {
  const s = storeObj || store;
  const h = s.layout ? s.layout.hash : null;
  const ready = layoutReady(s);
  if (!ready || ready.targetHash) return { status: layoutInflight ? 'computing' : 'stale', hash: h };
  return { status: 'ready', hash: h, positions: s.layout.positions, links: s.layout.links };
}

// --- provenance: where a node came from -------------------------------------
// Models and sessions that touched the node, derived from attached notes
// (model/session fields). Deterministic: notes-count desc, then name asc.
function nodeOrigin(id) {
  const s = store;
  const models = new Map();
  const sessions = new Map();
  for (const n of Object.values(s.notes)) {
    if (n.parent !== id) continue;
    if (n.model) models.set(n.model, (models.get(n.model) || 0) + 1);
    if (!n.session) continue;
    const sess = s.sessions[n.session];
    const cur = sessions.get(n.session) || {
      id: n.session,
      model: sess ? sess.model : undefined,
      agent: sess ? sess.agent : undefined,
      startedAt: sess ? sess.startedAt : undefined,
      notes: 0,
    };
    cur.notes++;
    if (n.model && !cur.model) cur.model = n.model; // notes carry the model even when the session row is gone
    sessions.set(n.session, cur);
  }
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    models: [...models].sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))
      .map(([model, notes]) => ({ model, notes })),
    sessions: [...sessions.values()].sort((a, b) => b.notes - a.notes || byName(a.id, b.id)),
  };
}

module.exports = {
  setEmbedEngine,
  load,
  getStore,
  saveDebounced,
  saveNow,
  flushIfDirty,
  closeForExit,
  upsertNode,
  deleteNode,
  upsertEdge,
  deleteEdge,
  addNote,
  deleteNote,
  addSession,
  appendLog,
  resolveId,
  edgesOf,
  nodeEmbedText,
  needsEmbedding,
  refreshEmbedding,
  ensureLayout,
  getLayoutStatus,
  nodeOrigin,
};
