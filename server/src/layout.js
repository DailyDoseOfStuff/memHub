'use strict';

// Server-side 3D context layout. Pure, deterministic, dependency-free.
//
// The browser force-simates its own layout, but its seed is random each
// reload, so the "map" never matches between agents or sessions. This module
// computes THE map: union graph (real edges + mutual-kNN similarity links)
// hashed -> deterministic seed -> fixed iteration force relaxation in 3D.
// Same data -> same coordinates, whatever process computes it. Agents can
// read positions straight off GET /api/layout.

const crypto = require('crypto');

const KNN_K = 6;
const MIN_COS = 0.35;
const MAX_NODES = 2000; // O(N^2) kNN pass; beyond this only real edges link
const ITERS = 250;

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0; // vectors are rounded, not exactly unit
}

const idOf = (x) => (x && typeof x === 'object' ? x.id : x);
const vecOf = (v) => (Array.isArray(v) ? v : (v && Array.isArray(v.v) ? v.v : null));

// Mutual top-k: keep a pair only when each side ranks the other in its top-k.
// Mirrors web/graph3d.js so server and browser agree on the union graph.
function mutualKnn(vectors, opts) {
  const o = opts || {};
  const k = Number.isFinite(o.k) && o.k > 0 ? Math.floor(o.k) : KNN_K;
  const minCos = typeof o.minCos === 'number' ? o.minCos : MIN_COS;
  const maxNodes = o.maxNodes || MAX_NODES;
  const entries = Object.entries(vectors || {})
    .map(([id, v]) => [String(id), vecOf(v)])
    .filter(([id, v]) => id && v && v.length)
    .slice(0, maxNodes);
  const vecById = new Map(entries), top = new Map();
  for (let i = 0; i < entries.length; i++) {
    const cand = [];
    for (let j = 0; j < entries.length; j++) {
      if (i === j) continue;
      const c = cosine(entries[i][1], entries[j][1]);
      if (c >= minCos) cand.push({ id: entries[j][0], c });
    }
    // top-k per id, ties by id so runs are reproducible
    cand.sort((a, b) => b.c - a.c || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    top.set(entries[i][0], new Set(cand.slice(0, k).map((x) => x.id)));
  }
  const out = [], seen = new Set();
  for (const [id, set] of top) {
    for (const other of set) {
      const back = top.get(other);
      if (!back || !back.has(id)) continue;
      const a = id < other ? id : other, b = id < other ? other : id;
      const key = a + '\u0000' + b;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ source: a, target: b, sim: cosine(vecById.get(a), vecById.get(b)) });
    }
  }
  return out.sort((x, y) => (x.source < y.source ? -1 : x.source > y.source ? 1 : x.target < y.target ? -1 : 1));
}

// Union graph, sorted, pair-deduped. Real edges first (w = edge weight or 1),
// sim links fill any remaining pairs (w = cosine).
function buildLinks(nodes, vectors, edges, opts) {
  const nodeSet = new Set(Object.keys(nodes || {}));
  const links = [], seen = new Set();
  const pair = (a, b) => (a < b ? a + '\u0000' + b : b + '\u0000' + a);
  for (const e of edges || []) {
    const s = idOf(e && e.source), t = idOf(e && e.target);
    if (!s || !t || s === t || !nodeSet.has(s) || !nodeSet.has(t)) continue;
    const key = pair(s, t);
    if (seen.has(key)) continue; // one link per pair; first (real) edge wins
    seen.add(key);
    const w = typeof e.weight === 'number' && e.weight > 0 ? e.weight : 1;
    links.push({ source: s < t ? s : t, target: s < t ? t : s, w, real: 1 });
  }
  const ids = [...nodeSet].sort();
  for (const l of mutualKnn(vectors, opts)) {
    if (!nodeSet.has(l.source) || !nodeSet.has(l.target)) continue;
    const key = pair(l.source, l.target);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: l.source, target: l.target, w: l.sim, sim: l.sim });
  }
  links.sort((x, y) =>
    (x.source < y.source ? -1 : x.source > y.source ? 1 :
      x.target < y.target ? -1 : x.target > y.target ? 1 : (y.w || 0) - (x.w || 0)));
  return links;
}

// Data fingerprint for the layout cache: node id set, per-node vector hashes
// when present, and the union graph. Vector text edits change the links, which
// changes the hash, which evaluates a fresh layout.
function layoutHashStore(nodeVectors, links) {
  const ids = Object.keys(nodeVectors).sort();
  const payload = JSON.stringify({
    ids,
    vh: ids.map((id) => (nodeVectors[id] && nodeVectors[id].hash) || null),
    links,
    iters: ITERS,
  });
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

// mulberry32, seeded from a hash buffer -> same seed, same universe.
function prng(seedBuf) {
  let a = seedBuf.readUInt32LE(0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- force relaxation -------------------------------------------------------
const REP = 25000;   // pairwise repulsion magnitude (f = REP / d^2)
const GRAV = 0.02;   // pull toward origin (keeps far floaters from drifting)
const SPRING = 0.08; // link stiffness

// Link rest length: real edges (w=1) pull tight at 60; sim links stretch
// inversely with cosine strength (0.35 -> 130, 1.0 -> 60).
function restLength(l) {
  const w = Math.max(0, Math.min(1, l.w || 0));
  return l.real ? 60 : 130 - 70 * Math.max(0, (w - MIN_COS) / (1 - MIN_COS));
}

// ids: sorted array; links: from buildLinks. Returns { hash, positions }
// where positions maps id -> [x, y, z] (1-decimal rounded).
function computeLayout(ids, links, nodeVectors) {
  const n = ids.length;
  const hash = layoutHashStore(nodeVectors || {}, links);
  const positions = {};
  if (!n) return { hash, positions };

  const pr = prng(crypto.createHash('sha1')
    .update(JSON.stringify([ids, links, ITERS])).digest());
  const R0 = 70 * Math.cbrt(n);
  const pos = new Map();
  for (const id of ids) {
    // Box-Muller gaussian on a sphere-ish shell: deterministic per node
    const u1 = pr() || 1e-9, u2 = pr(), u3 = pr(), u4 = pr();
    const r = Math.sqrt(-2 * Math.log(u1)) % R0 + R0 * 0.3;
    pos.set(id, [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u3), R0 * (u4 * 2 - 1)]);
  }

  const byId = new Map(ids.map((id, i) => [id, i]));
  const arr = ids.map((id) => pos.get(id));
  const disp = new Float64Array(n * 3);
  const linksIdx = [];
  for (const l of links) {
    const a = byId.get(l.source), b = byId.get(l.target);
    if (a === undefined || b === undefined) continue;
    linksIdx.push([a, b, restLength(l)]);
  }
  for (let it = 0; it < ITERS; it++) {
    disp.fill(0);
    const maxStep = 60 * (1 - it / ITERS) + 3;
    // repulsion (all pairs)
    for (let i = 0; i < n; i++) {
      const pi = i * 3;
      for (let j = i + 1; j < n; j++) {
        const pj = j * 3;
        const dx = arr[i][0] - arr[j][0], dy = arr[i][1] - arr[j][1], dz = arr[i][2] - arr[j][2];
        const d2 = dx * dx + dy * dy + dz * dz;
        const d = Math.sqrt(d2) || 1;
        const f = Math.min(REP / d2, maxStep) / d; // direction-scaled, step-capped
        disp[pi] += dx * f; disp[pi + 1] += dy * f; disp[pi + 2] += dz * f;
        disp[pj] -= dx * f; disp[pj + 1] -= dy * f; disp[pj + 2] -= dz * f;
      }
    }
    // springs
    for (const [a, b, L] of linksIdx) {
      const pa = a * 3, pb = b * 3;
      const dx = arr[b][0] - arr[a][0], dy = arr[b][1] - arr[a][1], dz = arr[b][2] - arr[a][2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const f = SPRING * (d - L) / d;
      disp[pa] += dx * f; disp[pa + 1] += dy * f; disp[pa + 2] += dz * f;
      disp[pb] -= dx * f; disp[pb + 1] -= dy * f; disp[pb + 2] -= dz * f;
    }
    // gravity + integrate (move in-place inside arr for speed)
    for (let i = 0; i < n; i++) {
      const p = i * 3, a = arr[i];
      a[0] += clampStep(disp[p], maxStep) - a[0] * GRAV;
      a[1] += clampStep(disp[p + 1], maxStep) - a[1] * GRAV;
      a[2] += clampStep(disp[p + 2], maxStep) - a[2] * GRAV;
    }
  }
  for (let i = 0; i < n; i++) {
    positions[ids[i]] = arr[i].map((v) => Math.round(v * 10) / 10);
  }
  return { hash, positions };
}

function clampStep(v, max) {
  return v > max ? max : v < -max ? -max : v;
}

module.exports = {
  KNN_K,
  MIN_COS,
  MAX_NODES,
  ITERS,
  cosine,
  mutualKnn,
  buildLinks,
  layoutHashStore,
  computeLayout,
};
