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
    fs.writeFileSync(TMP_FILE, JSON.stringify(store, null, 2));
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
  return node;
}

function deleteNode(id) {
  if (!store.nodes[id]) return false;
  delete store.nodes[id];
  store.edges = store.edges.filter((e) => e.source !== id && e.target !== id);
  for (const note of Object.values(store.notes)) {
    if (note.parent === id) note.parent = null;
  }
  appendLog('node.delete', id);
  schedDirtySave();
  return true;
}

function upsertEdge(source, target, type, weight) {
  source = ensureConceptNode(source);
  target = ensureConceptNode(target);
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
  }
  return id;
}

function deleteEdge(id) {
  const i = store.edges.findIndex((e) => e.id === id);
  if (i === -1) return false;
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
  return note;
}

function deleteNote(id) {
  if (!store.notes[id]) return false;
  delete store.notes[id];
  appendLog('note.delete', id);
  schedDirtySave();
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

module.exports = {
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
};
