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
      for (const e of s.edges) {
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

function search(q, limit) {
  const s = store.getStore();
  const query = String(q == null ? '' : q).trim();
  if (!query) return [];
  const ql = query.toLowerCase();
  const noteHit = new Set();
  for (const n of Object.values(s.notes)) {
    if (n.parent != null && String(n.text || '').toLowerCase().includes(ql)) noteHit.add(n.parent);
  }
  const results = [];
  for (const node of Object.values(s.nodes)) {
    const label = String(node.label || '');
    const ll = label.toLowerCase();
    let score = 0;
    if (ll === ql) score += 100;
    else if (ll.startsWith(ql)) score += 80;
    else if (ll.includes(ql)) score += 60;
    if (noteHit.has(node.id)) score += 40;
    if (score > 0) results.push({ id: node.id, label, type: node.type, score });
  }
  results.sort((a, b) => b.score - a.score || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return results.slice(0, clampLimit(limit));
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

module.exports = { neighbors, search, stats, makeBackupFile };
