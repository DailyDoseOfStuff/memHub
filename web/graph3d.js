/* memHub 3D context universe. Same constructor contract as the old 2D graph
   (onSelect, onFocus, setData, setFilter, select, focusNeighborhood).

   Similarity links join each node to its mutual top-k cosine neighbours; real
   edges join the same graph. Weighted label propagation over that union graph
   assigns communities, one colour per group.
   ponytail: O(N^2) kNN pass; fine to ~2k nodes, switch to HNSW beyond that. */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const MIN_COS = 0.35, KNN_K = 6, MAX_SIM_NODES = 2000;
  const COORDS = ['x', 'y', 'z', 'vx', 'vy', 'vz'];
  const TYPE = { project: '#a78bfa', file: '#60a5fa', concept: '#f472b6', person: '#fbbf24', decision: '#34d399', session: '#f87171', note: '#94a3b8' };
  const idOf = (x) => (x && typeof x === 'object' ? x.id : x);
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escLabel = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const communityColor = (i) => `hsl(${((i * 137.508) % 360).toFixed(2)},68%,62%)`;

  // ---- vector math ----
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / Math.sqrt(na * nb) : 0; // vectors are rounded, not exactly unit
  }

  function entriesOf(input) {
    if (input instanceof Map) return [...input.entries()];
    if (Array.isArray(input)) {
      return input.map((e) => {
        if (Array.isArray(e)) return e;
        return e && typeof e === 'object' ? [e.id, e.embedding ? e.embedding.v : e.v] : null;
      }).filter(Boolean);
    }
    return input && typeof input === 'object' ? Object.entries(input) : [];
  }

  function vectorOf(v) {
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.v)) return v.v;
    return v && v.embedding && Array.isArray(v.embedding.v) ? v.embedding.v : null;
  }

  // Mutual top-k: keep a pair only when each side ranks the other in its top-k.
  function mutualKnn(vectors, k, minCos) {
    if (k && typeof k === 'object') { minCos = k.minCos != null ? k.minCos : k.threshold; k = k.k; }
    k = Number.isFinite(k) && k > 0 ? Math.floor(k) : KNN_K;
    minCos = typeof minCos === 'number' ? minCos : MIN_COS;
    const entries = entriesOf(vectors).map(([id, v]) => [String(id), vectorOf(v)])
      .filter(([id, v]) => id && v && v.length).slice(0, MAX_SIM_NODES);
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

  // Weighted label propagation. Real edges weigh 1, sim links weigh cosine.
  // Deterministic: sorted ids, current label wins ties, groups numbered by
  // first occurrence in sorted id order.
  function communities(nodes, links) {
    const ids = [...new Set((nodes || []).map((n) => (typeof n === 'string' ? n : n && n.id)).filter(Boolean))].sort();
    const known = new Set(ids), adj = new Map(ids.map((id) => [id, new Map()]));
    for (const l of links || []) {
      const a = idOf(l.source !== undefined ? l.source : l[0]);
      const b = idOf(l.target !== undefined ? l.target : l[1]);
      if (a === b || !known.has(a) || !known.has(b)) continue;
      const w = (l && typeof l === 'object' && (l.sim || l.weight)) || 1;
      const am = adj.get(a), bm = adj.get(b);
      am.set(b, (am.get(b) || 0) + w);
      bm.set(a, (bm.get(a) || 0) + w);
    }
    const label = new Map(ids.map((id) => [id, id]));
    for (let round = 0; round < 24; round++) {
      let changed = false;
      for (const id of ids) {
        const tally = new Map();
        for (const [nb, w] of adj.get(id)) { const lab = label.get(nb); tally.set(lab, (tally.get(lab) || 0) + w); }
        const cur = label.get(id);
        let best = cur, bestW = tally.get(cur) || 0;
        for (const lab of [...tally.keys()].sort()) {
          const w = tally.get(lab);
          if (w > bestW) { best = lab; bestW = w; }
        }
        if (best !== cur) { label.set(id, best); changed = true; }
      }
      if (!changed) break;
    }
    const counts = new Map(), groups = new Map(), remap = new Map();
    for (const id of ids) { const lab = label.get(id); counts.set(lab, (counts.get(lab) || 0) + 1); }
    let gi = 0;
    for (const id of ids) {
      const lab = label.get(id);
      if ((counts.get(lab) || 0) < 2) { groups.set(id, -1); continue; } // singleton = type colour
      if (!remap.has(lab)) remap.set(lab, gi++);
      groups.set(id, remap.get(lab));
    }
    return groups;
  }

  class ForceGraph {
    constructor(container, handlers) {
      this.handlers = handlers || {};
      this._full = { nodes: [], edges: [] };
      this._nodesById = new Map();
      this._vec = {}; this._rev = undefined; this._req = 0;
      this._cache = null; this._pending = null; this._timer = null; this._tries = 0;
      this._clickTimer = null; this._lastClickId = null;
      this.visibleTypes = null; this.focusedIds = null; this.selectedId = null;
      this._container = container;

      this.kg = new root.ForceGraph3D(container);
      this.kg.backgroundColor('#05070c').showNavInfo(false)
        .nodeRelSize(4.4)
        .nodeVal((n) => 2.2 + Math.sqrt(n._deg || 0) * 1.1)
        .nodeColor((n) => n._color || '#8b949e')
        .nodeLabel((n) => `${escLabel(n.label)} [${escLabel(n.type)}]`)
        .linkColor((l) => (l.sim ? 'rgba(140,122,255,0.55)' : 'rgba(170,184,204,0.30)'))
        .linkWidth((l) => (l.sim ? Math.max(0.3, l.sim * 2.4) : 0.3))
        .linkOpacity(0.75)
        .onNodeClick((node) => {
          if (this._clickTimer && this._lastClickId === node.id) {
            clearTimeout(this._clickTimer);
            this._clickTimer = null;
            this._lastClickId = null;
            if (this.handlers.onFocus) this.handlers.onFocus(node);
            return;
          }
          if (this._clickTimer) clearTimeout(this._clickTimer);
          this._lastClickId = node.id;
          this._clickTimer = setTimeout(() => {
            this._clickTimer = null;
            if (this.handlers.onSelect) this.handlers.onSelect(node);
          }, 260); // defer select so a double-click can become focus
        })
        .onBackgroundClick(() => {
          if (this._clickTimer) { clearTimeout(this._clickTimer); this._clickTimer = null; }
          this._lastClickId = null;
          this.focusedIds = null;
          this._applyVisibility();
          if (this.handlers.onSelect) this.handlers.onSelect(null);
        })
        .onEngineStop(() => { if (this._pending && this._seek(this._pending)) this._pending = null; });

      container.style.cursor = 'grab';
      // ambient drift until the user grabs the scene; slower than hand orbit
      try {
        const ctl = this.kg.controls();
        if (ctl && typeof ctl.addEventListener === 'function') {
          ctl.autoRotate = true;
          ctl.autoRotateSpeed = 0.35;
          ctl.addEventListener('start', () => { ctl.autoRotate = false; });
        }
      } catch {}
      this._resize = () => this.kg.width(container.clientWidth || 1).height(container.clientHeight || 1);
      this._resize();
      this._sv = null; // server layout: { hash, positions, links }
      if (typeof root.ResizeObserver !== 'undefined') {
        this._observer = new root.ResizeObserver(this._resize);
        this._observer.observe(container);
      }
    }

    setData(graphData) {
      this._full = graphData || { nodes: [], edges: [] };
      // a snapshot swap invalidates a pending deferred click on a vanished node
      if (this._clickTimer) { clearTimeout(this._clickTimer); this._clickTimer = null; }
      this._lastClickId = null;
      const rev = this._full.embedRev || 0;
      if (rev !== this._rev) {
        if (rev) {
          const req = ++this._req;
          root.fetch('/api/embeddings').then((r) => (r.ok ? r.json() : null)).then((body) => {
            if (!body || req !== this._req || (this._full.embedRev || 0) !== rev) return;
            this._rev = rev; // only a successful fetch advances the rev; failures retry next poll
            this._vec = body.vectors || {}; this._cache = null; this._render();
          }).catch(() => {});
        } else { this._rev = rev; this._vec = {}; this._cache = null; }
      }
      this._render();
    }

    setFilter(types) {
      this.visibleTypes = types;
      this._applyVisibility(); // visibility only: no reheat, no graphData rebuild
    }

    // Server-computed deterministic layout (GET /api/layout): seeds browser
    // coords for fresh nodes and replaces the client kNN pass when fresh.
    setServerLayout(data) {
      if (!data) return;
      this._sv = data;
      this._cache = null;
      this._render();
    }

    select(id) {
      this.selectedId = id || null;
      if (!id) return;
      if (this._seek(id)) { this._pending = null; return; }
      this._retry(id); // coords may not exist until the layout settles
    }

    focusNeighborhood(subgraph, centerId) {
      this.focusedIds = subgraph && Array.isArray(subgraph.nodes) ? new Set(subgraph.nodes.map((n) => idOf(n))) : null;
      this._applyVisibility();
      this.select(centerId);
    }

    _render() {
      const data = this._full || { nodes: [], edges: [] };
      const nodesIn = data.nodes || [], edgesIn = data.edges || [];
      const ids = nodesIn.map((n) => n.id).sort(), eids = edgesIn.map((e) => e.id).sort();
      const nodeSet = new Set(ids);
      const key = `${this._rev || 0}|${ids.join(',')}|${eids.join(',')}`;
      if (!this._cache || this._cache.key !== key) {
        const seen = new Set(), links = [];
        const nodeSetLinks = new Set(ids); // same as nodeSet
        // Server layout is authoritative when fresh: it cannot race a data
        // change because its links were hashed for exactly this node/edge set.
        let usedServer = false;
        if (this._sv && Array.isArray(this._sv.links)) {
          usedServer = true;
          for (const l of this._sv.links) {
            if (!nodeSetLinks.has(l.source) || !nodeSetLinks.has(l.target)) { usedServer = false; break; }
          }
        }
        if (usedServer) {
          for (const l of this._sv.links) {
            links.push(l.real ? { source: l.source, target: l.target, sim: 0 }
              : { source: l.source, target: l.target, sim: l.w || l.sim || 1 });
          }
        } else {
        for (const e of edgesIn) {
          const s = idOf(e.source), t = idOf(e.target);
          if (!s || !t || !nodeSet.has(s) || !nodeSet.has(t)) continue;
          const a = s < t ? s : t, b = s < t ? t : s, pair = a + '\u0000' + b;
          if (seen.has(pair)) continue; // real edge wins, one link per pair
          seen.add(pair);
          links.push({ source: a, target: b, sim: 0 });
        }
        const vec = {};
        for (const id of Object.keys(this._vec || {})) {
          if (nodeSet.has(id)) vec[id] = this._vec[id];
        }
        for (const l of mutualKnn(vec, KNN_K, MIN_COS)) {
          if (!nodeSet.has(l.source) || !nodeSet.has(l.target)) continue;
          const pair = l.source + '\u0000' + l.target;
          if (seen.has(pair)) continue;
          seen.add(pair);
          links.push({ source: l.source, target: l.target, sim: l.sim });
        }
        }
        const degree = new Map();
        for (const l of links) {
          degree.set(l.source, (degree.get(l.source) || 0) + 1);
          degree.set(l.target, (degree.get(l.target) || 0) + 1);
        }
        this._cache = { key, links, groups: communities(nodesIn, links), degree };
      }
      const cache = this._cache, prev = this._nodesById, sv = this._sv;
      const nodes = nodesIn.map((src) => {
        const n = { ...src }, old = prev.get(n.id);
        if (old) for (const p of COORDS) if (old[p] !== undefined) n[p] = old[p];
        if (!old && n.x === undefined && sv && sv.positions && sv.positions[n.id]) {
          n.x = sv.positions[n.id][0];
          n.y = sv.positions[n.id][1];
          n.z = sv.positions[n.id][2];
        }
        n._deg = cache.degree.get(n.id) || 0;
        const g = cache.groups.get(n.id);
        n._color = g >= 0 ? communityColor(g) : TYPE[n.type] || '#8b949e';
        return n;
      });
      this._nodesById = new Map(nodes.map((n) => [n.id, n]));
      const links = cache.links.map((l) => ({ source: l.source, target: l.target, sim: l.sim }));
      this.kg.graphData({ nodes, links }); // fresh link objects: d3 mutates source/target to refs
      this.kg.refresh(); // re-evaluate accessors after data/filter changes
      this._applyVisibility();
    }

    _applyVisibility() {
      const nodes = this._nodesById, types = this.visibleTypes, focus = this.focusedIds;
      const visible = (id) => { const n = nodes.get(id); return !!n && (!types || types.includes(n.type)) && (!focus || focus.has(id)); };
      this.kg.nodeVisibility((n) => visible(n.id));
      this.kg.linkVisibility((l) => visible(idOf(l.source)) && visible(idOf(l.target)));
      this.kg.refresh();
    }

    _seek(id) {
      const n = this._nodesById.get(id);
      if (!n || !Number.isFinite(n.x) || !Number.isFinite(n.y) || !Number.isFinite(n.z)) return false;
      this.kg.cameraPosition({ x: n.x, y: n.y, z: n.z + 180 }, n, 700);
      return true;
    }

    _retry(id) {
      this._pending = id; this._tries = 0;
      if (this._timer) clearTimeout(this._timer);
      const tick = () => {
        this._timer = null;
        if (this._pending !== id) return;
        if (this._seek(id) || ++this._tries > 20) { this._pending = null; return; }
        this._timer = setTimeout(tick, 200);
      };
      this._timer = setTimeout(tick, 200); // first try after layout has a beat
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { cosine, mutualKnn, communities };
  if (typeof window !== 'undefined') window.ForceGraph = ForceGraph;
})();
