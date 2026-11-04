/* memHub app controller: graph, sidebar, search, modals, toasts. */
(function () {
  'use strict';

  // Crash surfacing: an uncaught init error otherwise looks like "the page is dead".
  window.addEventListener('error', (e) => {
    let b = document.getElementById('err-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'err-banner';
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#f87171;color:#0b0e14;padding:6px 10px;font-size:12px;font-family:ui-monospace,monospace';
      (document.body || document.documentElement).appendChild(b);
    }
    b.textContent = 'JS error: ' + (e.message || e.error) + ' @ ' + (e.filename || '?') + ':' + (e.lineno || '?');
  });

  const TYPE_COLORS = {
    project: '#a78bfa',
    file: '#60a5fa',
    concept: '#f472b6',
    person: '#fbbf24',
    decision: '#34d399',
    session: '#f87171',
    note: '#94a3b8',
  };
  const TYPES = Object.keys(TYPE_COLORS);

  const $ = (id) => document.getElementById(id);
  let graphData = { nodes: [], edges: [] };
  let selectedNodeId = null;
  let forceGraph = null;
  let sidebarPin = false;
  let recents = [];
  try { recents = JSON.parse(localStorage.getItem('memhub-recents') || '[]'); if (!Array.isArray(recents)) recents = []; } catch { recents = []; }

  /* ---------- fetch + toast ---------- */
  async function api(path, opts) {
    const res = await fetch(path, opts);
    let body = {};
    try { body = await res.json(); } catch { body = {}; }
    if (!res.ok) {
      const msg = body.error || `HTTP ${res.status}`;
      toast(`Error: ${msg}`, true);
      throw new Error(msg);
    }
    return body;
  }

  function toast(msg, isError) {
    const box = $('toasts');
    while (box.children.length >= 5) box.firstChild.remove();
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function bindRow(el, fn) {
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.addEventListener('click', fn);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); }
    });
  }

  /* ---------- graph ---------- */
  let lastGraphJson = '';
  async function loadGraph(quiet) {
    const res = await fetch('/api/graph');
    if (!res.ok) {
      if (!quiet) toast(`Error: HTTP ${res.status}`, true);
      throw new Error(`HTTP ${res.status}`);
    }
    const text = await res.text();
    if (text === lastGraphJson) return;
    lastGraphJson = text;
    graphData = JSON.parse(text);
    $('graph-empty').classList.toggle('hidden', graphData.nodes.length > 0);
    forceGraph.setData(graphData);
    forceGraph.setFilter(visibleTypes());
    if (selectedNodeId && !graphData.nodes.find((n) => n.id === selectedNodeId)) {
      selectedNodeId = null;
      renderSidebar();
    }
  }

  /* ---------- server layout (deterministic 3D seed + union graph) ---------- */
  let lastLayoutHash = undefined; // undefined = never fetched

  async function loadLayout() {
    try {
      const res = await fetch('/api/layout');
      if (!res.ok) return;
      const data = await res.json();
      const hash = data.hash || null;
      if (hash === lastLayoutHash) return;
      lastLayoutHash = hash;
      if (data.status === 'ready') forceGraph.setServerLayout(data);
    } catch {}
  }

  function visibleTypes() {
    return TYPES.filter((t) => {
      const cb = document.querySelector(`#type-filters input[value="${t}"]`);
      return cb && cb.checked;
    });
  }

  async function selectNode(id) {
    selectedNodeId = id;
    if (id) pushRecent(id);
    location.hash = id ? '#' + encodeURIComponent(id) : '';
    if (id) {
      try {
        const detail = await api(`/api/node/${encodeURIComponent(id)}`);
        if (selectedNodeId !== id) return; // a later selection won the race
        renderSidebar(detail);
      } catch {
        if (selectedNodeId !== id) return;
        selectedNodeId = null;
        renderSidebar();
      }
    } else {
      renderSidebar();
    }
    forceGraph.select(id);
    forceGraph.setFilter(visibleTypes());
  }

  /* ---------- recents trail ---------- */
  function renderRecents() {
    const box = $('recents');
    const chips = recents
      .map((id) => {
        const n = graphData.nodes.find((x) => x.id === id);
        return n ? `<span class="chip-mini" data-id="${esc(id)}" tabindex="0" role="button">${esc(n.label)}</span>` : null;
      })
      .filter(Boolean);
    box.innerHTML = chips.join('');
    box.classList.toggle('hidden', chips.length === 0);
    box.querySelectorAll('.chip-mini').forEach((el) => bindRow(el, () => selectNode(el.dataset.id)));
  }

  function pushRecent(id) {
    recents = [id, ...recents.filter((x) => x !== id)].slice(0, 7);
    localStorage.setItem('memhub-recents', JSON.stringify(recents));
    renderRecents();
  }

  /* ---------- sidebar ---------- */
  function chip(type) {
    return `<span class="chip" style="background:${TYPE_COLORS[type] || '#8b949e'}">${esc(type)}</span>`;
  }

  function relDate(iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 90) return 'just now';
    if (diff < 3600) return Math.round(diff / 60) + 'm ago';
    if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
    return new Date(iso).toLocaleDateString();
  }

  function renderSidebar(detail) {
    const sb = $('sidebar');
    const body = $('sidebar-body');
    if (!selectedNodeId) {
      if (!sidebarPin) {
        sb.classList.remove('open'); // nothing selected, not pinned: slide out
        return;
      }
      sb.classList.add('open');
      body.innerHTML = '<section><h3>Pinned panel</h3><p style="color:var(--muted);font-size:12px">Click a node to inspect it. Double-click to focus its neighborhood.</p></section>';
      return;
    }
    sb.classList.add('open');
    if (!detail) return; // bare call: keep existing content
    body.dataset.id = detail.node.id;
    const { node, edges, neighbors, notes } = detail;
    const metaRows = Object.entries(node.meta || {})
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`)
      .join('');
    const nbRows = (neighbors || [])
      .map((n) => `<div class="row" data-id="${esc(n.id)}"><span class="swatch" style="width:8px;height:8px;border-radius:50%;background:${TYPE_COLORS[n.type] || '#8b949e'}"></span><span class="label">${esc(n.label)}</span><span class="nb-type">${esc(n.type)}</span></div>`)
      .join('') || '<p style="color:var(--muted);font-size:12px">No connections yet.</p>';
    const noteRows = (notes || []).slice().reverse()
      .map((n) => `
        <div class="note">
          <div class="note-text">${esc(n.text)}</div>
          <div class="note-meta">
            <span>${esc(n.model)}</span>
            ${(n.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
            <span>${relDate(n.createdAt)}</span>
            <button class="note-del" data-note="${esc(n.id)}">delete</button>
          </div>
        </div>`)
      .join('') || '<p style="color:var(--muted);font-size:12px">No notes attached.</p>';
    const savedModel = localStorage.getItem('memhub-model') || '';
    const origin = detail.origin || {};
    const originChips = (origin.models || [])
      .map((m) => `<span class="chip origin">${esc(m.model)}<b>${m.notes}</b></span>`)
      .join('');
    const originSessions = (origin.sessions || [])
      .filter((s) => s.notes > 0)
      .map((s) => `<div class="origin-session"><span class="chip">${esc(s.agent || s.model || s.id)}</span><span class="origin-meta">${relDate(s.startedAt || s.id)} · ${s.notes} note${s.notes === 1 ? '' : 's'}</span></div>`)
      .join('');
    const originSection = (originChips || originSessions)
      ? `<section><h3>Origin</h3>${originChips ? `<div class="origin-models">${originChips}</div>` : ''}${originSessions || ''}</section>` : '';
    body.innerHTML = `
      <section>
        <h2>${esc(node.label)}</h2>
        <div style="margin-bottom:6px">${chip(node.type)}</div>
        <div class="id">${esc(node.id)}</div>
        <div style="color:var(--muted);font-size:11px">updated ${relDate(node.updatedAt)}</div>
      </section>
      ${originSection}
      ${metaRows ? `<section><h3>Meta</h3><table class="meta-table">${metaRows}</table></section>` : ''}
      <section><h3>Connections (${(neighbors || []).length})</h3><div class="nb-list">${nbRows}</div></section>
      <section>
        <h3>Notes (${(notes || []).length})</h3>
        <div class="notes">${noteRows}</div>
        <div class="note-form">
          <textarea id="note-text" placeholder="Attach a note to this node..."></textarea>
          <input id="note-tags" placeholder="tags, comma, separated" />
          <input id="note-model" placeholder="your model / agent name" value="${esc(savedModel)}" />
          <button class="btn primary" id="add-note-btn" style="width:100%">Save note</button>
        </div>
      </section>
      <section><button class="btn danger" id="del-node-btn" style="width:100%">Delete node</button></section>`;

    body.querySelectorAll('.nb-list .row').forEach((r) => bindRow(r, () => selectNode(r.dataset.id)));
    body.querySelectorAll('.note-del').forEach((b) =>
      b.addEventListener('click', async () => {
        await api(`/api/notes/${encodeURIComponent(b.dataset.note)}`, { method: 'DELETE' });
        toast('Note deleted');
        selectNode(selectedNodeId);
      }));
    $('add-note-btn').addEventListener('click', async () => {
      const text = $('note-text').value.trim();
      if (!text) return toast('Note text is empty', true);
      const model = $('note-model').value.trim() || 'unknown';
      localStorage.setItem('memhub-model', model);
      await api('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          parent: selectedNodeId,
          tags: $('note-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
          model,
        }),
      });
      toast('Note saved');
      selectNode(selectedNodeId);
    });
    $('del-node-btn').addEventListener('click', async () => {
      if (!confirm(`Delete node "${node.label}" and its ${edges.length} connections? Notes are kept.`)) return;
      await api(`/api/node/${encodeURIComponent(selectedNodeId)}`, { method: 'DELETE' });
      toast('Node deleted');
      loadGraph();
      selectNode(null);
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- search ---------- */
  let searchTimer = null;
  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $('search-input').value.trim();
      const box = $('search-results');
      if (q.length < 2) { box.classList.add('hidden'); return; }
      const { results } = await api(`/api/search?q=${encodeURIComponent(q)}&limit=10`);
      box.innerHTML = results.length
        ? results.map((r) => `<div class="row" data-id="${esc(r.id)}"><span>${esc(r.label)}</span><span style="font-size:10px;color:var(--muted)">${esc(r.type)}</span><span class="score">${r.score}</span></div>`).join('')
        : '<div class="row" style="color:var(--muted)">No matches</div>';
      box.classList.remove('hidden');
      box.querySelectorAll('.row[data-id]').forEach((r) =>
        bindRow(r, () => { box.classList.add('hidden'); selectNode(r.dataset.id); }));
    }, 250);
  }

  /* ---------- modals ---------- */
  function openModal(html) {
    const ov = $('modal-overlay');
    ov.innerHTML = `<div class="modal">${html}</div>`;
    ov.classList.remove('hidden');
    return ov.querySelector('.modal');
  }
  function closeModal() {
    const ov = $('modal-overlay');
    ov.classList.add('hidden');
    ov.innerHTML = '';
  }

  function modalMetaParsed(raw) {
    const meta = {};
    for (const part of raw.split(',')) {
      const kv = part.split('=');
      if (kv.length >= 2 && kv[0].trim()) meta[kv[0].trim()] = kv.slice(1).join('=').trim();
    }
    return meta;
  }

  function modalAddNode() {
    const m = openModal(`
      <h2>Create node</h2>
      <div class="field"><label>Type</label>
        <select id="m-type">${TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}</select></div>
      <div class="field"><label>Label</label><input id="m-label" placeholder="e.g. auth-service decision" /></div>
      <div class="field"><label>Meta (key=value, comma separated)</label><input id="m-meta" placeholder="status=planned, owner=allen" /></div>
      <div class="modal-actions">
        <button class="btn" id="m-cancel">Cancel</button>
        <button class="btn primary" id="m-save">Create</button>
      </div>`);
    m.querySelector('#m-cancel').addEventListener('click', closeModal);
    m.querySelector('#m-label').focus();
    m.querySelector('#m-save').addEventListener('click', async () => {
      const label = m.querySelector('#m-label').value.trim();
      if (!label) return toast('Label required', true);
      const node = (await api('/api/node', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: m.querySelector('#m-type').value,
          label,
          meta: modalMetaParsed(m.querySelector('#m-meta').value),
        }),
      })).node;
      closeModal();
      toast(`Node created: ${node.id}`);
      await loadGraph();
      selectNode(node.id);
    });
  }

  async function modalStats() {
    const s = await api('/api/stats');
    const boxes = [['nodes', s.nodes], ['edges', s.edges], ['notes', s.notes]]
      .map(([lbl, n]) => `<div class="stat-box"><div class="num">${n}</div><div class="lbl">${lbl}</div></div>`).join('');
    const byType = Object.entries(s.byType || {}).map(([t, n]) => `<span>${esc(t)}: <b>${n}</b></span>`).join(' &nbsp; ');
    const rows = (s.topConnected || [])
      .map((r) => `<tr class="clickable" data-id="${esc(r.id)}"><td>${esc(r.label)}</td><td>${esc(r.type)}</td><td>${r.degree}</td></tr>`).join('');
    const m = openModal(`
      <h2>Graph statistics</h2>
      <div class="stats-grid">${boxes}</div>
      <div style="margin-bottom:14px;font-size:12px;color:var(--muted)">${byType}</div>
      <table class="data"><thead><tr><th>Most connected</th><th>type</th><th>degree</th></tr></thead><tbody>${rows}</tbody></table>`);
    m.querySelectorAll('tr.clickable').forEach((r) =>
      bindRow(r, () => { closeModal(); selectNode(r.dataset.id); }));
  }

  async function modalLog() {
    const { log } = await api('/api/log?limit=50');
    const rows = log.slice().reverse()
      .map((l) => `<div class="row"><span class="ts">${new Date(l.ts).toLocaleTimeString()}</span><span class="action">${esc(l.action)}</span><span class="detail">${esc(l.detail || '')}</span></div>`)
      .join('') || '<p style="color:var(--muted);font-size:12px">No activity yet.</p>';
    openModal(`<h2>Activity log</h2><div class="log-list">${rows}</div>`);
  }

  /* ---------- init ---------- */
  function init() {
    forceGraph = new window.ForceGraph($('graph-3d'), {
      onSelect: (node) => selectNode(node ? node.id : null),
      onFocus: async (node) => {
        const r = await api(`/api/query/${encodeURIComponent(node.id)}?hops=2`);
        forceGraph.focusNeighborhood(r.subgraph, node.id);
        selectNode(node.id);
      },
    });

    $('type-filters').innerHTML = TYPES.map((t) =>
      `<label><input type="checkbox" value="${t}" checked /><span style="color:${TYPE_COLORS[t]}">${t}</span></label>`).join('');
    $('type-filters').addEventListener('change', () => forceGraph.setFilter(visibleTypes()));

    $('search-input').addEventListener('input', onSearchInput);
    $('search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.target.value = ''; $('search-results').classList.add('hidden'); }
    });
    document.addEventListener('click', (e) => {
      const sw = $('search-wrap');
      if (!sw || !sw.contains(e.target)) $('search-results').classList.add('hidden');
    });

    $('add-node-btn').addEventListener('click', modalAddNode);
    $('modal-overlay').addEventListener('click', (e) => { if (e.target === $('modal-overlay')) closeModal(); });
    $('stats-btn').addEventListener('click', modalStats);
    $('log-btn').addEventListener('click', modalLog);
    $('backup-btn').addEventListener('click', async () => {
      const r = await api('/api/backup', { method: 'POST' });
      toast(`Backup written: ${r.file}`);
    });
    $('sidebar-toggle').addEventListener('click', () => {
      sidebarPin = !sidebarPin;
      $('sidebar-toggle').title = sidebarPin ? 'Unpin panel' : 'Pin panel open';
      renderSidebar(); // open/close decided by pin + selection
    });
    $('sidebar-close').addEventListener('click', () => selectNode(null));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const hadModal = !$('modal-overlay').classList.contains('hidden');
        closeModal();
        if (!hadModal) selectNode(null); // close the popup panel
      }
      const ae = document.activeElement;
      if (e.key === '/' && !(ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName))) {
        e.preventDefault();
        $('search-input').focus();
      }
    });

    pollHealth();
    setInterval(pollHealth, 15000);
    loadLayout();
    setInterval(loadLayout, 30000); // ready layout replaces the random seed; hash change = fresh map
    loadGraph().then(() => {
      renderRecents(); // label the persisted ids now that graphData is loaded
      const hid = location.hash.slice(1);
      if (hid) selectNode(decodeURIComponent(hid));
    });
    // token-savings bar: server ledger populated by budgeted recall calls
    pollTokens();
    setInterval(pollTokens, 5000);
    setInterval(async () => {
      if (document.hidden) return;
      try {
        await loadGraph(true);
        const id = selectedNodeId;
        if (!id) return;
        const sidebar = $('sidebar');
        if (!sidebar.classList.contains('open')) return; // panel closed: leave closed
        if (sidebar.contains(document.activeElement)) return; // any input focused: don't wipe typing
        const ta = $('note-text');
        if (ta && ta.value.trim()) return;                    // typed but blurred: same
        const res = await fetch(`/api/node/${encodeURIComponent(id)}`);
        if (!res.ok) return;
        const detail = await res.json();
        if (selectedNodeId !== id) return;
        renderSidebar(detail);
      } catch {}
    }, 5000);
  }

  async function pollHealth() {
    try {
      await fetch('/api/health');
      $('conn-dot').className = 'dot on';
      $('conn-dot').title = 'connected';
    } catch {
      $('conn-dot').className = 'dot off';
      $('conn-dot').title = 'offline';
    }
  }

  // --- token savings bar ---
  // Session key rides in sessionStorage so each browser tab is its own bar
  // bucket; agent sessions (MCP/HTTP recall `session`) form their own groups.
  function sessionKey() {
    let k = null;
    try {
      k = sessionStorage.getItem('memhub-session');
      if (!k) {
        k = 'web:' + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem('memhub-session', k);
      }
    } catch { k = 'web:ephemeral'; }
    return k;
  }

  function fmtTok(n) {
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n < 1000) return String(Math.round(n));
    if (n < 1000000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return (n / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M';
  }

  async function pollTokens() {
    try {
      const r = await fetch('/api/tokens');
      if (!r.ok) return;
      const t = await r.json();
      const key = sessionKey();
      const mine = (t.sessions && t.sessions[key]) || { calls: 0, used: 0, saved: 0 };
      const all = (t.all && typeof t.all === 'object' && t.all.calls != null) ? t.all : { calls: 0, used: 0, saved: 0 };
      const sessions = Object.keys((t && t.sessions) || {}).length - (mine.calls ? 1 : 0);
      const pct = (mine.saved + mine.used) > 0 ? Math.round((mine.saved / (mine.saved + mine.used)) * 100) : 0;
      $('token-bar-fill').style.width = pct + '%';
      const label = fmtTok(mine.saved) + '/' + fmtTok(mine.used + mine.saved) + ' tok saved';
      $('token-bar-label').textContent = label;
      const tips = Object.entries(t.sessions || {})
        .sort((a, b) => b[1].saved - a[1].saved)
        .slice(0, 5)
        .map(([k, v]) => `${k}: ${fmtTok(v.saved)} saved / ${fmtTok(v.used)} spent (${v.calls} recalls)`);
      $('token-bar').title =
        `memHub token ledger (${all.calls} budgeted recalls, ${fmtTok(all.saved)} tokens saved overall)\n` +
        (tips.length ? tips.join('\n') : 'no budgeted recall calls yet');
      $('token-bar-label').dataset.sessions = String(sessions);
    } catch { /* server down: bar keeps last value */ }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
