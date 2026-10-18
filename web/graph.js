/* ForceGraph: live-animated SVG force layout with pan/zoom, hover, select, note satellites. */
(function () {
  'use strict';

  const TYPE_COLORS = {
    project: '#a78bfa',
    file: '#60a5fa',
    concept: '#f472b6',
    person: '#fbbf24',
    decision: '#34d399',
    session: '#f87171',
    note: '#94a3b8',
  };

  const REPULSION = 2600;
  const SPRING_LEN = 90;
  const SPRING_K = 0.04;
  const GRAVITY = 0.03;
  const DAMPING = 0.85;

  window.ForceGraph = class ForceGraph {
    constructor(svgEl, callbacks) {
      this.svg = svgEl;
      this.viewport = svgEl.querySelector('#graph-viewport');
      this.onSelect = callbacks.onSelect || function () {};
      this.onFocus = callbacks.onFocus || function () {};
      this.nodes = [];
      this.edges = [];
      this.byDegree = new Map();
      this.notesByParent = new Map();
      this.index = new Map();
      this.selectedId = null;
      this.visibleTypes = null;
      this.hoverId = null;
      this.focusSet = null;
      this.tf = { x: 0, y: 0, k: 1 };
      this.alpha = 0;
      this.raf = null;
      this.edgeEls = [];
      this.nodeEls = new Map();

      this._bindBackground();
      window.addEventListener('resize', () => this._layout());
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.alpha > 0.01) this._heat(this.alpha);
      });
    }

    setData(data) {
      const old = new Map(this.nodes.map((n) => [n.id, n]));
      const nodes = (data.nodes || []).map((n) => {
        const node = { ...n };
        const prev = old.get(node.id);
        if (prev) {
          node.x = prev.x;
          node.y = prev.y;
          node.fx = prev.fx;
          node.fy = prev.fy;
          node.pinned = prev.pinned;
        } else {
          node.x = (Math.random() - 0.5) * 400;
          node.y = (Math.random() - 0.5) * 400;
          node.fx = node.x;
          node.fy = node.y;
        }
        return node;
      });
      const index = new Map(nodes.map((n) => [n.id, n]));
      const edges = (data.edges || []).filter((e) => index.has(e.source) && index.has(e.target));
      const deg = new Map();
      for (const e of edges) {
        deg.set(e.source, (deg.get(e.source) || 0) + 1);
        deg.set(e.target, (deg.get(e.target) || 0) + 1);
      }
      const notesByParent = new Map();
      for (const note of data.notes || []) {
        if (!note.parent || !index.has(note.parent)) continue;
        if (!notesByParent.has(note.parent)) notesByParent.set(note.parent, []);
        notesByParent.get(note.parent).push(note);
      }
      const first = this.nodes.length === 0 && nodes.length > 0;
      this.nodes = nodes;
      this.edges = edges;
      this.byDegree = deg;
      this.notesByParent = notesByParent;
      this.index = index;
      if (first) this._fit();
      this._render();
      if (nodes.length) this._heat(first ? 1 : 0.35);
    }

    select(id) {
      this.selectedId = id;
      if (id) this._centerOn(id);
      this._layout();
      this._updateVis();
    }

    setFilter(visibleTypes) {
      this.visibleTypes = visibleTypes;
      this._updateVis();
    }

    focusNeighborhood(subgraph, centerId) {
      this.focusSet = new Set((subgraph.nodes || []).map((n) => n.id));
      this.select(centerId);
    }

    _heat(alpha) {
      this.alpha = Math.max(this.alpha || 0, alpha);
      if (this.raf == null) this.raf = requestAnimationFrame(() => this._frame());
    }

    _frame() {
      this.raf = null;
      this._tick(this.alpha);
      this.alpha *= 0.975;
      this._layout();
      if (this.nodes.length && this.alpha > 0.01 && !document.hidden) {
        this.raf = requestAnimationFrame(() => this._frame());
      }
    }

    _tick(alpha) {
      const nodes = this.nodes;
      const edges = this.edges;
      const disps = new Map();
      for (const n of nodes) disps.set(n.id, { x: 0, y: 0 });
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.01; }
          const f = REPULSION / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          disps.get(a.id).x += fx;
          disps.get(a.id).y += fy;
          disps.get(b.id).x -= fx;
          disps.get(b.id).y -= fy;
        }
      }
      for (const e of edges) {
        const a = this.index.get(e.source);
        const b = this.index.get(e.target);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = SPRING_K * (d - SPRING_LEN);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        disps.get(a.id).x += fx;
        disps.get(a.id).y += fy;
        disps.get(b.id).x -= fx;
        disps.get(b.id).y -= fy;
      }
      for (const n of nodes) {
        const d = disps.get(n.id);
        if (n.pinned) continue;
        n.x += d.x * DAMPING * alpha;
        n.y += d.y * DAMPING * alpha;
        n.x -= n.x * GRAVITY * alpha;
        n.y -= n.y * GRAVITY * alpha;
        n.fx = n.x;
        n.fy = n.y;
      }
    }

    _fit() {
      if (!this.nodes.length) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of this.nodes) {
        minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      }
      const w = this.svg.clientWidth || 800;
      const h = this.svg.clientHeight || 600;
      const gw = maxX - minX || 1;
      const gh = maxY - minY || 1;
      const k = Math.min(w / (gw + 120), h / (gh + 120), 2);
      this.tf.k = k;
      this.tf.x = w / 2 - (minX + gw / 2) * k;
      this.tf.y = h / 2 - (minY + gh / 2) * k;
    }

    _centerOn(id) {
      const n = this.nodes.find((x) => x.id === id);
      if (!n) return;
      const w = this.svg.clientWidth || 800;
      const h = this.svg.clientHeight || 600;
      this.tf.x = w / 2 - n.fx * this.tf.k;
      this.tf.y = h / 2 - n.fy * this.tf.k;
    }

    _screenToWorld(sx, sy) {
      const rect = this.svg.getBoundingClientRect();
      return { x: (sx - rect.left - this.tf.x) / this.tf.k, y: (sy - rect.top - this.tf.y) / this.tf.k };
    }

    _nodeRadius(node) {
      const deg = this.byDegree.get(node.id) || 0;
      return Math.min(16, 6 + Math.sqrt(deg) * 3);
    }

    /* Build DOM once per dataset. Positions and visibility update in place
       between frames — interval rebuilds would kill mousedown/click pairing. */
    _render() {
      const ns = 'http://www.w3.org/2000/svg';
      this.viewport.textContent = '';
      this.edgeEls = [];
      this.nodeEls = new Map();
      this.hoverId = null;
      this.focusSet = null; // stale focus from a previous snapshot must not dim the new one

      for (const e of this.edges) {
        const a = this.index.get(e.source);
        const b = this.index.get(e.target);
        if (!a || !b) continue;
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('stroke', '#334155');
        line.setAttribute('stroke-width', 1);
        this.viewport.appendChild(line);
        this.edgeEls.push({ el: line, e });
      }

      for (const n of this.nodes) {
        const g = document.createElementNS(ns, 'g');
        const radius = this._nodeRadius(n);
        const circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('r', radius);
        circle.setAttribute('fill', TYPE_COLORS[n.type] || '#8b949e');
        circle.setAttribute('cursor', 'pointer');
        const label = document.createElementNS(ns, 'text');
        label.textContent = String(n.label || n.id).length > 28
          ? String(n.label || n.id).slice(0, 27) + '…'
          : String(n.label || n.id);
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('y', radius + 12);
        label.setAttribute('fill', '#94a3b8');
        label.setAttribute('font-size', '10');
        label.setAttribute('pointer-events', 'none');
        g.appendChild(circle);
        g.appendChild(label);
        const nodeNotes = this.notesByParent.get(n.id);
        if (nodeNotes) {
          nodeNotes.slice(0, 12).forEach((note, i) => {
            const ang = i * 2.39996;
            const dist = radius + 13 + (i % 3) * 6;
            const nx = Math.cos(ang) * dist;
            const ny = Math.sin(ang) * dist;
            const link = document.createElementNS(ns, 'line');
            link.setAttribute('x1', 0);
            link.setAttribute('y1', 0);
            link.setAttribute('x2', nx);
            link.setAttribute('y2', ny);
            link.setAttribute('stroke', '#475569');
            link.setAttribute('stroke-dasharray', '2 2');
            link.setAttribute('stroke-width', 1);
            const dot = document.createElementNS(ns, 'circle');
            dot.setAttribute('cx', nx);
            dot.setAttribute('cy', ny);
            dot.setAttribute('r', 2.5);
            dot.setAttribute('fill', TYPE_COLORS.note);
            dot.setAttribute('cursor', 'pointer');
            const tip = document.createElementNS(ns, 'title');
            tip.textContent = `${note.model || 'unknown'}: ${String(note.text || '').slice(0, 140)}`;
            dot.appendChild(tip);
            g.appendChild(link);
            g.appendChild(dot);
          });
        }
        this.viewport.appendChild(g);
        this._bindNode(g, n);
        this.nodeEls.set(n.id, { g, n, circle, label });
      }

      this._layout();
      this._updateVis();
    }

    _layout() {
      this.viewport.setAttribute('transform', `translate(${this.tf.x},${this.tf.y}) scale(${this.tf.k})`);
      for (const { el, e } of this.edgeEls) {
        const a = this.index.get(e.source);
        const b = this.index.get(e.target);
        if (!a || !b) continue;
        el.setAttribute('x1', a.fx); el.setAttribute('y1', a.fy);
        el.setAttribute('x2', b.fx); el.setAttribute('y2', b.fy);
      }
      for (const { g, n } of this.nodeEls.values()) {
        g.setAttribute('transform', `translate(${n.fx},${n.fy})`);
      }
    }

    _updateVis() {
      const nb = new Set();
      if (this.hoverId || this.selectedId) {
        for (const e of this.edges) {
          if (e.source === this.hoverId || e.target === this.hoverId ||
              e.source === this.selectedId || e.target === this.selectedId) {
            nb.add(e.source); nb.add(e.target);
          }
        }
      }
      const dimMode = this.focusSet || nb.size > 0;
      for (const { el, e } of this.edgeEls) {
        const active = this.hoverId && (e.source === this.hoverId || e.target === this.hoverId);
        el.setAttribute('stroke', active ? '#7c6cf0' : '#334155');
        el.setAttribute('stroke-width', active ? 2 : 1);
        let opac = null;
        const inFocusSet = !this.focusSet || this.focusSet.has(e.source) || this.focusSet.has(e.target);
        if (!inFocusSet) opac = '0.1';
        else if (dimMode && !this.focusSet && !nb.has(e.source) && !nb.has(e.target)) opac = '0.2';
        this._setFade(el, opac);
      }
      for (const { g, n, circle, label } of this.nodeEls.values()) {
        circle.setAttribute('stroke', n.id === this.selectedId ? '#fff' : 'rgba(0,0,0,0.5)');
        circle.setAttribute('stroke-width', n.id === this.selectedId ? 2 : 1);
        label.setAttribute('fill', n.id === this.selectedId ? '#e2e8f0' : '#94a3b8');
        const typeHidden = this.visibleTypes && this.visibleTypes.length && !this.visibleTypes.includes(n.type);
        let opac = null;
        if (typeHidden) opac = '0.08';
        else if (this.focusSet && !this.focusSet.has(n.id)) opac = '0.1';
        else if (dimMode && !this.focusSet && !nb.has(n.id) && n.id !== this.hoverId && n.id !== this.selectedId) opac = '0.2';
        this._setFade(g, opac);
      }
    }
    _setFade(el, opac) {
      if (opac != null) {
        el.setAttribute('opacity', opac);
        el.style.pointerEvents = 'none';
      } else {
        el.removeAttribute('opacity');
        el.style.pointerEvents = '';
      }
    }

    _bindNode(g, node) {
      g.addEventListener('mouseenter', () => { this.hoverId = node.id; this._updateVis(); });
      g.addEventListener('mouseleave', () => { this.hoverId = null; this._updateVis(); });
      g.addEventListener('click', (ev) => { ev.stopPropagation(); this.onSelect(node); });
      g.addEventListener('dblclick', (ev) => { ev.stopPropagation(); this.onFocus(node); });
      g.addEventListener('mousedown', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        this._heat(0.5);
        const move = (e2) => {
          const w = this._screenToWorld(e2.clientX, e2.clientY);
          node.x = node.fx = w.x;
          node.y = node.fy = w.y;
          node.pinned = true;
          this._heat(0.4);
          this._layout();
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
    }

    _bindBackground() {
      const svg = this.svg;
      svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = svg.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const k = Math.min(4, Math.max(0.2, this.tf.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        this.tf.x = mx - ((mx - this.tf.x) / this.tf.k) * k;
        this.tf.y = my - ((my - this.tf.y) / this.tf.k) * k;
        this.tf.k = k;
        this._layout();
      }, { passive: false });
      svg.addEventListener('mousedown', (e) => {
        if (e.target !== svg) return;
        svg.classList.add('dragging');
        const sx = e.clientX;
        const sy = e.clientY;
        const ox = this.tf.x;
        const oy = this.tf.y;
        const move = (e2) => {
          this.tf.x = ox + (e2.clientX - sx);
          this.tf.y = oy + (e2.clientY - sy);
          this._layout();
        };
        const up = () => {
          svg.classList.remove('dragging');
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
      svg.addEventListener('click', () => { this.selectedId = null; this.onSelect(null); });
    }
  };
})();
