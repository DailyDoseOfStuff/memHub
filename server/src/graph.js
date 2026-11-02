'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');

function clampHops(hops) {
  const n = Math.floor(Number(hops == null ? 2 : hops));
  return Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : 2;
}

function clampLimit(limit) {
  const n = Math.floor(Number(limit == null ? 10 : limit));
  return Number.isFinite(n) && n >= 1 ? n : 10;
}

function neighbors(id, hops) {
  const s = store.getStore();
  if (!s.nodes[id]) throw new Error('node not found');
  const visited = new Set([id]);
  let frontier = [id];
  for (let depth = clampHops(hops); depth > 0; depth--) {
    const next = [];
    for (const nid of frontier) {
      for (const e of store.edgesOf(nid)) {
        const other = e.source === nid ? e.target : e.target === nid ? e.source : null;
        if (other && !visited.has(other)) {
          visited.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return {
    center: id,
    subgraph: {
      nodes: [...visited].map((nid) => s.nodes[nid]).filter(Boolean),
      edges: s.edges.filter((e) => visited.has(e.source) && visited.has(e.target)),
    },
  };
}

// Token relevance search. Each query word scores nodes on:
//   label exact word +100 / prefix +80 / substring +60
//   meta value contains word +20
//   attached-note text contains word +40 first, +10 per extra note
//   +1 per edge (degree), recency bump: <24h +10, <7d +5
//   full-label match of the whole query +1000 (always ranks first)
// ponytail: linear scan per query; if a store ever grows past ~10k nodes,
// swap in an inverted index over label/meta/note text instead.
function search(q, limit) {
  const s = store.getStore();
  const query = String(q == null ? '' : q).trim();
  if (!query) return [];
  const ql = query.toLowerCase();
  const words = ql.split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return [];

  // word -> how many notes mention it, per parent node
  const noteHits = new Map(); // parentId -> { word: count }
  for (const n of Object.values(s.notes)) {
    if (n.parent == null) continue;
    const text = String(n.text || '').toLowerCase();
    if (!text) continue;
    let m = noteHits.get(n.parent);
    if (!m) noteHits.set(n.parent, (m = {}));
    for (const w of words) {
      if (text.includes(w)) m[w] = (m[w] || 0) + 1;
    }
  }

  const degree = new Map();
  for (const e of s.edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  const now = Date.now();

  const results = [];
  for (const node of Object.values(s.nodes)) {
    const ll = String(node.label || '').toLowerCase();
    let score = 0;
    for (const w of words) {
      if (ll === w) score += 100;
      else if (ll.startsWith(w)) score += 80;
      else if (ll.includes(w)) score += 60;
    }
    if (ll === ql) score += 1000;
    const metaText = node.meta && typeof node.meta === 'object' ? JSON.stringify(node.meta).toLowerCase() : '';
    if (metaText) {
      for (const w of words) {
        if (metaText.includes(w)) score += 20;
      }
    }
    const hits = noteHits.get(node.id);
    if (hits) {
      let first = false;
      for (const w of words) {
        if (hits[w]) {
          if (!first) {
            score += 40;
            first = true;
          } else score += 10;
        }
      }
    }
    score += degree.get(node.id) || 0;
    const ts = Date.parse(node.updatedAt || node.createdAt || '') || 0;
    const age = ts ? now - ts : Infinity;
    if (age < 86400000) score += 10;
    else if (age < 7 * 86400000) score += 5;
    if (score > 0) results.push({ id: node.id, label: node.label, type: node.type, score });
  }
  results.sort((a, b) => b.score - a.score || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return results.slice(0, clampLimit(limit));
}

// Hybrid recall for agents: token search (exact/name hits) blended with
// embedding cosine (paraphrase hits). Falls back to token-only when the
// embedder is unavailable or no node has a vector yet.
// ponytail: 0.6 semantic / 0.4 lexical is a hand-tuned prior; the eval script
// (eval/recall.js) is the knob - retune only against that golden set.
async function recall(q, limit, embedFn) {
  const k = clampLimit(limit);
  const token = search(q, k);
  if (!embedFn) return { mode: 'token', results: token };
  let qv = null;
  try {
    qv = await embedFn(String(q == null ? '' : q));
  } catch {
    qv = null;
  }
  if (!qv || !qv.length) return { mode: 'token', results: token };

  const s = store.getStore();
  const tokenById = new Map(token.map((r) => [r.id, r]));
  const maxTok = Math.max(1, ...token.map((r) => r.score));
  const merged = [];
  for (const n of Object.values(s.nodes)) {
    const v = n.embedding && n.embedding.v;
    if (!Array.isArray(v) || v.length !== qv.length) continue;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < qv.length; i++) {
      dot += qv[i] * v[i];
      na += qv[i] * qv[i];
      nb += v[i] * v[i];
    }
    const cos = dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
    const t = tokenById.get(n.id);
    const lex = t ? t.score / maxTok : 0;
    const exact = t && t.score >= 1000 ? 2 : 0; // exact label always outranks
    const score = exact + 0.6 * ((cos + 1) / 2) + 0.4 * lex;
    merged.push({ id: n.id, label: n.label, type: n.type, score: Math.round(score * 1000) / 1000, cos: Math.round(cos * 1000) / 1000 });
  }
  // token hits with no vector yet stay reachable, ranked below vector hits
  for (const t of token) {
    if (merged.some((m) => m.id === t.id)) continue;
    merged.push({ ...t, score: Math.round(0.4 * (t.score / maxTok) * 0.5 * 1000) / 1000, cos: null });
  }
  merged.sort((a, b) => b.score - a.score || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return { mode: 'semantic', results: merged.slice(0, k) };
}

// ---------------------------------------------------------------------------
// Token-efficient recall assembly (agent-facing one-call payload).
//
// Techniques, in evidence order (LongLLMLingua question-aware keep-to-budget,
// contextual compression, MMR redundancy pruning):
//   1. rank-then-fill: hits arrive ranked, fill the budget in rank order,
//      top hit always survives whole;
//   2. near-duplicate notes are dropped payload-wide (word-set Jaccard) -
//      repeated text is the biggest silent token sink;
//   3. budget mode strips meta/updatedAt, keeps id/label/type only;
//   4. truncation is word/sentence boundary + explicit `...(+N chars)` marker
//      so the model knows it saw a prefix;
//   5. neighbor labels reranked/deduped, then cut to the remaining budget;
//   6. ~4 chars/token estimate - dependency-free, close enough for budgeting.
// Without budget: legacy full-fat payload, unchanged (back-compat).
// ---------------------------------------------------------------------------
const CHAR_TOKEN = 4; // ~4 chars per token for engine-agnostic estimation
const MIN_BUDGET = 200;
const MAX_BUDGET = 100000;
const NOTE_SOFT_CAP = 1400; // per-note char cap inside budget mode
const DEDUPE_JACCARD = 0.8;

const estTokens = (s) => Math.ceil(String(s || '').length / CHAR_TOKEN);

// Word/sentence-boundary cut that never lies: the marker says exactly how
// many chars it ate. Empty result when even a sentence head doesn't fit.
function sliceForBudget(text, maxChars) {
  const t = String(text || '');
  if (t.length <= maxChars) return { text: t, cut: null };
  if (maxChars <= 80) return { text: '', cut: t.length };
  const head = t.slice(0, maxChars);
  const dot = head.lastIndexOf('. ');
  const brk = dot >= maxChars * 0.5 ? head.slice(0, dot + 1) : head.slice(0, head.lastIndexOf(' '));
  const out = brk.trim().length > 0 ? brk : head.trim();
  return { text: `${out} ...(+${t.length - out.length} chars)`, cut: t.length - out.length };
}

function wordSet(s) {
  return new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function neighborIdList(nid) {
  const ids = new Set();
  for (const e of store.edgesOf(nid)) {
    ids.add(e.source);
    ids.add(e.target);
  }
  ids.delete(nid);
  return ids;
}

const notesForNode = (s, nid) => Object.values(s.notes)
  .filter((n) => n.parent === nid)
  .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

function fullNodeBlock(s, nid, node) {
  return {
    node: { id: node.id, type: node.type, label: node.label, meta: node.meta || {}, updatedAt: node.updatedAt },
    notes: notesForNode(s, nid).map((n) => ({
      text: n.text.length > 4000 ? n.text.slice(0, 4000) + `... (+${n.text.length - 4000} chars)` : n.text,
      tags: n.tags || [],
      model: n.model,
      createdAt: n.createdAt,
    })),
    neighbors: [...neighborIdList(nid)].map((x) => (s.nodes[x] ? { id: x, label: s.nodes[x].label } : { id: x })),
  };
}

// Approx serialized cost: JSON keys/braces overhead + text + per-item costs.
function blockCost(block, seenLabels) {
  let t = 16;
  for (const n of block.notes) t += estTokens(n.text) + 14; // tags/model/date overhead
  for (const nb of block.neighbors) {
    if (seenLabels && seenLabels.has(nb.label)) continue;
    t += estTokens(nb.label) + 4;
  }
  return t;
}

// Greedily shrink a block to a token ceiling. Returns false when nothing fits.
function fitBlock(block, maxTokens, stats) {
  if (maxTokens < 120) return false;
  let toks = maxTokens;
  while (block.notes.length > 1 && estTokens(block.notes[block.notes.length - 1].text) + 14 > toks - 16) {
    block.notes.pop();
    stats.notesDropped++;
  }
  if (block.notes.length === 1) {
    const last = block.notes[0];
    if (estTokens(last.text) + 14 > toks - 16) {
      const sl = sliceForBudget(last.text.replace(/ \.\.\.\(\+\d+ chars\)$/, ''), Math.max(0, (toks - 32) * CHAR_TOKEN));
      if (!sl.text || !sl.text.trim()) { block.notes.pop(); stats.notesDropped++; }
      else last.text = sl.text;
    }
  }
  if (!block.notes.length) {
    headerOnlyFit(block, toks, null);
    return blockCost(block) <= toks;
  }
  const spent = 16 + block.notes.reduce((a, n) => a + estTokens(n.text) + 14, 0);
  const keep = [];
  let left = spent;
  for (const nb of block.neighbors) {
    const c = estTokens(nb.label) + 4;
    if (left + c <= toks) { keep.push(nb); left += c; }
  }
  block.neighbors = keep;
  return spent <= toks;
}

function recallContext(hits, opts) {
  const s = store.getStore();
  const budgetRaw = opts && opts.budget != null ? Math.floor(Number(opts.budget)) : null;
  const out = [];
  const stats = { used: 0, notesDropped: 0, dupesDropped: 0, nodesDropped: 0 };

  if (budgetRaw == null) {
    for (const hit of hits || []) {
      const node = s.nodes[hit && hit.id];
      if (node) out.push(fullNodeBlock(s, hit.id, node));
    }
    return { nodes: out, tokens: null };
  }

  const budget = Math.max(MIN_BUDGET, Math.min(MAX_BUDGET, budgetRaw));
  const seenWordSets = [];
  const seenLabels = new Set();
  let first = true;

  for (const hit of hits || []) {
    const nid = hit && hit.id;
    const node = s.nodes[nid];
    if (!node) continue;

    const block = {
      node: first
        ? { id: node.id, type: node.type, label: node.label, meta: node.meta || {}, updatedAt: node.updatedAt }
        : { id: node.id, type: node.type, label: node.label }, // meta stripped past rank 1
      notes: notesForNode(s, nid).map((n) => {
        const sl = sliceForBudget(n.text, NOTE_SOFT_CAP);
        return { text: sl.text, tags: n.tags || [], model: n.model, createdAt: n.createdAt };
      }),
      neighbors: [...neighborIdList(nid)].filter((x) => s.nodes[x]).map((x) => ({ id: x, label: s.nodes[x].label })),
    };

    // payload-wide redundancy prune (MMR-lite)
    const kept = [];
    for (const n of block.notes) {
      const ws = wordSet(n.text);
      if (seenWordSets.some((w) => jaccard(w, ws) >= DEDUPE_JACCARD)) { stats.dupesDropped++; continue; }
      seenWordSets.push(ws);
      kept.push(n);
    }
    block.notes = kept;

    const remaining = budget - stats.used;
    if (first) {
      // top hit keeps its freshest notes; over-budget notes get sliced off
      while (block.notes.length > 1 && blockCost(block, seenLabels) > budget) {
        block.notes.pop();
        stats.notesDropped++;
      }
      if (block.notes.length === 1 && blockCost(block, seenLabels) > budget) {
        const last = block.notes[0];
        const sl = sliceForBudget(last.text.replace(/ \.\.\.\(\+\d+ chars\)$/, ''), Math.max(0, (budget - 40) * CHAR_TOKEN));
        if (!sl.text) { block.notes.pop(); stats.notesDropped++; }
        else last.text = sl.text;
      }
      if (!block.notes.length) { headerOnlyFit(block, remaining, seenLabels); }
      dedupeLabels(block, seenLabels);
      stats.used += blockCost(block, seenLabels);
      out.push(block);
    } else if (blockCost(block, seenLabels) <= remaining) {
      dedupeLabels(block, seenLabels);
      stats.used += blockCost(block, seenLabels);
      out.push(block);
    } else {
      const before = block.notes.length;
      const fit = fitBlock(block, remaining, stats);
      if (fit) {
        dedupeLabels(block, seenLabels);
        stats.used += blockCost(block, seenLabels);
        stats.nodesDropped += 0;
        out.push(block);
      } else {
        stats.nodesDropped++;
        stats.notesDropped += before;
      }
    }
    first = false;
  }
  return { nodes: out, tokens: stats };
}

// When even the top note can't fit, the block degrades to header + neighbors
// (labels are the cheapest meaning-per-token in the payload).
function headerOnlyFit(block, remaining, seenLabels) {
  block.notes = [];
  const keep = [];
  let spent = 16;
  for (const nb of block.neighbors) {
    if (seenLabels && seenLabels.has(nb.label)) continue;
    const c = estTokens(nb.label) + 4;
    if (spent + c <= remaining) { keep.push(nb); spent += c; }
  }
  block.neighbors = keep;
}

// Mark labels already emitted; later blocks keep only fresh labels
// (a label seen twice costs extra tokens for zero new context).
function dedupeLabels(block, seenLabels) {
  if (!seenLabels) return;
  block.neighbors = block.neighbors.filter((nb) => {
    if (seenLabels.has(nb.label)) return false;
    seenLabels.add(nb.label);
    return true;
  });
}

function stats() {
  const s = store.getStore();
  const byType = {};
  for (const n of Object.values(s.nodes)) byType[n.type] = (byType[n.type] || 0) + 1;
  const degree = new Map();
  for (const e of s.edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  const topConnected = Object.values(s.nodes)
    .map((n) => ({ id: n.id, label: n.label, type: n.type, degree: degree.get(n.id) || 0 }))
    .sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 10);
  return {
    nodes: Object.keys(s.nodes).length,
    edges: s.edges.length,
    notes: Object.keys(s.notes).length,
    byType,
    topConnected,
  };
}

function makeBackupFile() {
  const dir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `backup-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(store.getStore(), null, 2));
  return { ok: true, file };
}

module.exports = { neighbors, search, recall, recallContext, stats, makeBackupFile };

