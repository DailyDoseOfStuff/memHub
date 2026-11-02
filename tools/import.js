'use strict';

// Universal project importer for memHub: scans a folder tree (default: all of
// not-hentai), upserts a project node per top-level directory, file nodes for
// key files, "contains" edges, README summary notes (these feed embeddings, so
// the 3D universe clusters related projects), and "related" edges between
// projects that share distinctive vocabulary. Idempotent: re-run anytime, it
// updates in place instead of duplicating.
//
// Usage:
//   node tools/import.js                       # C:\Users\Allen\not-hentai
//   node tools/import.js <root> [--max-files N] [--dry-run]
//
// Requires the web server (container or host) on 127.0.0.1:4777.

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || 'C:\\Users\\Allen\\not-hentai';
const args = process.argv.slice(3);
const DRY = args.includes('--dry-run');
let maxFiles = 12;
const mfIdx = args.indexOf('--max-files');
if (mfIdx >= 0 && args[mfIdx + 1]) maxFiles = Math.max(0, parseInt(args[mfIdx + 1], 10) || 12);

const BASE = process.env.MEMHUB_URL || 'http://127.0.0.1:4777';
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.github', 'dist', 'build', 'out', 'target', 'bin',
  'obj', 'vendor', '__pycache__', '.venv', 'venv', '.next', 'coverage', 'assets',
  '.cache', 'site-packages', 'data', 'backup',
]);
const README_NAMES = new Set(['readme.md', 'readme.txt', 'readme']);
const PKG_NAMES = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'cargo.toml', 'go.mod']);

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const ok = res.ok;
  if (!ok && res.status !== 404 && res.status !== 400) {
    throw new Error(`${method} ${p} -> ${res.status}`);
  }
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const slugNodes = new Map(); // label-lower -> node id (per this run)
const vocab = new Map(); // project id -> Set of distinctive words

function tokenize(s) {
  return new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
}

function listKeyFiles(dir) {
  const out = [];
  const top = fs.readdirSync(dir, { withFileTypes: true });
  let dirs = [];
  for (const e of top) {
    if (e.isFile() && (README_NAMES.has(e.name.toLowerCase()) || PKG_NAMES.has(e.name.toLowerCase()))) {
      out.push(path.join(dir, e.name));
      if (out.length >= maxFiles) return out;
    } else if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
      dirs.push(e.name);
    }
  }
  // one src-ish level: sample a handful of real files
  for (const d of ['src', 'app', 'server', 'web', 'lib', 'src'].filter((x) => dirs.includes(x))) {
    let sub;
    try { sub = fs.readdirSync(path.join(dir, d), { withFileTypes: true }); } catch { continue; }
    for (const e of sub) {
      if (e.isFile() && /\.(js|ts|py|rs|cs|html|css|json|md)$/i.test(e.name)) {
        out.push(path.join(dir, d, e.name));
        if (out.length >= maxFiles) return out;
      }
    }
  }
  return out;
}

function readmeSummary(dir) {
  for (const name of ['README.md', 'readme.md', 'README.txt', 'readme.txt', 'README']) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) {
      try {
        let t = fs.readFileSync(f, 'utf8').replace(/\r/g, '').slice(0, 900);
        return t; // captured parent note grows the node's embedding
      } catch { }
    }
  }
  return null;
}

(async () => {
  const top = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory());
  const results = [];
  for (const entry of top) {
    const dir = path.join(ROOT, entry.name);
    const slug = entry.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const id = `project:${slug}`;
    const summary = readmeSummary(dir);

    if (DRY) {
      console.log(`[dry] ${id} files=${listKeyFiles(dir).length} summary=${summary ? 'yes' : 'no'}`);
      continue;
    }

    const meta = { path: dir.replace(/\\\\/g, '\\') };
    const up = await api('POST', '/api/node', { type: 'project', label: entry.name, meta });
    const node = up.json.node;
    if (!node) { console.error(`skip ${entry.name}: ${JSON.stringify(up.json)}`); continue; }
    slugNodes.set(entry.name.toLowerCase(), node.id);
    if (summary) {
      // token set for the "related" pass; drop the 50 most common English-ish tokens cheaply? ponytail: overlap of rare words only, >= 2 shared
      vocab.set(node.id, tokenize(entry.name + ' ' + summary));
    }
    // README note (feeds embeddings). Avoid duplicates: compare normalized
    // heads, not raw text - otherwise `includes` misses on newlines.
    if (summary) {
      const probe = summary.replace(/\s+/g, ' ').trim().slice(0, 60);
      const existing = await api('GET', `/api/notes?parent=${encodeURIComponent(node.id)}`);
      const dupe = (existing.json.notes || []).some((n) =>
        String(n.text || '').replace(/\s+/g, ' ').slice(0, 60) === probe);
      if (!dupe) {
        await api('POST', '/api/notes', { text: summary, parent: node.id, model: 'project-importer', tags: ['import', 'readme'] });
      }
    }
    // key file nodes + contains edges. File ids encode the FULL path
    // (contract: id = sanitized path) - basename ids collide project-wide.
    let filesAdded = 0;
    for (const f of listKeyFiles(dir)) {
      const rel = f.slice(ROOT.length).replace(/^[\\/]/, '').replace(/\\/g, '/').toLowerCase();
      const fu = await api('POST', '/api/node', { type: 'file', label: rel, meta: { path: f } });
      if (!fu.json.node) continue;
      await api('POST', '/api/edge', { source: node.id, target: fu.json.node.id, type: 'contains' });
      filesAdded++;
    }
    results.push({ id: node.id, label: entry.name, files: filesAdded, summary: !!summary });
    console.log(`${node.id}  files:${filesAdded} summary:${summary ? 'y' : 'n'}`);
  }

  // related pass: >= MIN_SHARED rare-word overlaps between project summaries.
  // Prior runs can leave weaker edges behind; prune anything that no longer
  // qualifies so the web converges clean across re-runs.
  const MIN_SHARED = 3;
  const seen = new Set();
  const ids = [...vocab.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      let shared = 0;
      for (const w of vocab.get(a)) if (vocab.get(b).has(w)) shared++;
      if (shared < MIN_SHARED) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const source = a < b ? a : b, target = a < b ? b : a;
      const weight = Math.min(1, shared / 12);
      const e = await api('POST', '/api/edge', { source, target, type: 'related', weight });
      if (e.status === 200) console.log(`related: ${source.replace('project:', '')} <-> ${target.replace('project:', '')} (w=${weight.toFixed(2)}, shared=${shared})`);
    }
  }
  // prune related edges that no longer qualify (e.g. earlier, looser runs)
  const graph = await api('GET', '/api/graph');
  let pruned = 0;
  for (const e of graph.json.edges || []) {
    if (e.type !== 'related') continue;
    const key = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
    if (!seen.has(key)) {
      const del = await api('DELETE', `/api/edge/${encodeURIComponent(e.id)}`);
      if (del.status === 200) { pruned++; console.log(`pruned weak: ${e.source.replace('project:', '')} <-> ${e.target.replace('project:', '')}`); }
    }
  }

  const stats = await api('GET', '/api/stats');
  console.log(`\nstore now: ${stats.json.nodes} nodes, ${stats.json.edges} edges, ${stats.json.notes} notes`);
  console.log(`imported: ${results.length} projects, kept ${seen.size} related, pruned ${pruned} (${DRY ? 'dry run' : 'committed'})`);
})().catch((e) => { console.error('import failed:', e.message); process.exit(1); });
