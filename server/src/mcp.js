'use strict';

const store = require('./store');
const graph = require('./graph');

store.load();

const TOOLS = [
  {
    name: 'memhub_recall',
    description:
      'Context recall in one call: top nodes matching a natural-language query, each with attached notes (most recent first) and neighbor labels. Use this at session start to load relevant memory.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to remember. Plain words; order does not matter.' },
        limit: { type: 'number', description: 'Max nodes returned (default 5, max 20).' },
        budget: { type: 'number', description: 'Optional approximate token cap for the returned context (200-100000). Rank-ordered fill: top hit kept whole, near-duplicate notes deduped, meta stripped, word-boundary truncation with char markers. Use to keep the reply inside a small context allowance.' },
        session: { type: 'string', description: 'Optional session id so the token-savings bar (GET /api/tokens, web UI) groups this call under your session.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memhub_save_note',
    description: 'Save a freeform memory/context note. Optionally attach to a node id.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Note body.' },
        parent: { type: 'string', description: 'Optional node id to attach the note to.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags.' },
        model: { type: 'string', description: 'Model/agent that wrote the note.' },
        session: { type: 'string', description: 'Session id the note belongs to.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memhub_find_nodes',
    description: 'Search nodes by label/notes relevance.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text.' },
        limit: { type: 'number', description: 'Max results (default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memhub_get_node',
    description: 'Get node details, edges, neighbors, notes.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Node id.' } },
      required: ['id'],
    },
  },
  {
    name: 'memhub_create_node',
    description: 'Create or update a node. type: project|file|concept|person|decision|session|note.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'project|file|concept|person|decision|session|note.' },
        label: { type: 'string', description: 'Human label.' },
        meta: { type: 'object', description: 'Optional key/value metadata.' },
      },
      required: ['type', 'label'],
    },
  },
  {
    name: 'memhub_link_nodes',
    description: 'Create/update an edge between nodes (auto-creates missing nodes as concepts).',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source node id.' },
        target: { type: 'string', description: 'Target node id.' },
        type: { type: 'string', description: 'Edge type.' },
        weight: { type: 'number', description: 'Edge weight.' },
      },
      required: ['source', 'target'],
    },
  },
  {
    name: 'memhub_neighborhood',
    description: 'BFS subgraph around a node.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Center node id.' },
        hops: { type: 'number', description: 'BFS depth 1-5 (default 2).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memhub_stats',
    description: 'Counts + most-connected nodes.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'memhub_list_notes',
    description: 'Search/list notes with filters.',
    inputSchema: {
      type: 'object',
      properties: {
        parent: { type: 'string', description: 'Only notes attached to this node id.' },
        q: { type: 'string', description: 'Text filter.' },
        tag: { type: 'string', description: 'Exact tag filter.' },
      },
      required: [],
    },
  },
  {
    name: 'memhub_backup',
    description: 'Write full backup JSON to server/data/.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

function publicNode(node) {
  const copy = { ...node };
  delete copy.embedding;
  return copy;
}

function getNode(id) {
  const s = store.getStore();
  const nid = store.resolveId(id) || id;
  const node = s.nodes[nid];
  if (!node) throw new Error('node not found');
  const edges = store.edgesOf(nid);
  const neighborIds = new Set();
  for (const e of edges) {
    neighborIds.add(e.source);
    neighborIds.add(e.target);
  }
  neighborIds.delete(nid);
  return {
    node: publicNode(node),
    edges,
    neighbors: [...neighborIds].map((x) => s.nodes[x]).filter(Boolean).map(publicNode),
    notes: Object.values(s.notes).filter((n) => n.parent === nid),
    origin: store.nodeOrigin(nid),
  };
}

// Note text cap for recall output. ponytail: 4000 chars per note keeps one
// note from blowing the agent's context window; raise the cap if summaries
// get longer, or filter by tag before recalling.
const RECALL_NOTE_CAP = 4000;

function recall(args) {
  const budget = args.budget != null && Number(args.budget) > 0 ? Math.floor(Number(args.budget)) : null;
  const session = typeof args.session === 'string' && args.session.trim() ? args.session.trim() : 'mcp';
  return recallOrder(args).then((hits) => {
    if (budget) return graph.recallContext(hits, { budget, session });
    // legacy fat payload (full schema contract; RECALL_NOTE_CAP applied)
    const s = store.getStore();
    return hits.map((hit) => {
      const nid = hit.id;
      const neighborIds = new Set();
      for (const e of store.edgesOf(nid)) {
        neighborIds.add(e.source);
        neighborIds.add(e.target);
      }
      neighborIds.delete(nid);
      const node = s.nodes[nid];
      const notes = Object.values(s.notes)
        .filter((n) => n.parent === nid)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .map((n) => ({
          text: n.text.length > RECALL_NOTE_CAP ? n.text.slice(0, RECALL_NOTE_CAP) + `... (+${n.text.length - RECALL_NOTE_CAP} chars)` : n.text,
          tags: n.tags || [],
          model: n.model,
          createdAt: n.createdAt,
        }));
      return {
        node: { id: node.id, type: node.type, label: node.label, meta: node.meta || {}, updatedAt: node.updatedAt },
        notes,
        neighbors: [...neighborIds].map((x) => (s.nodes[x] ? { id: x, label: s.nodes[x].label } : { id: x })),
      };
    });
  });
}

// Prefer the running web server's hybrid (semantic+token) ranking; fall back
// to local token search when the server is not up. MCP stays model-free.
async function recallOrder(args) {
  const k = Math.max(1, Math.min(20, Number(args.limit) || 5));
  const q = String(args.query == null ? '' : args.query);
  try {
    const url = `http://127.0.0.1:${process.env.MEMHUB_PORT || 4777}/api/recall?q=${encodeURIComponent(q)}&limit=${k}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(800) });
    if (res.ok) {
      const body = await res.json();
      if (body && Array.isArray(body.results) && body.results.length) {
        // map hits back onto current store nodes (ids may be stale after edits)
        const hits = body.results.map((r) => ({ id: r.id, label: r.label, type: r.type })).filter((r) => store.getStore().nodes[r.id]);
        if (hits.length) return hits;
      }
    }
  } catch {
    // server down or slow: local fallback below
  }
  return graph.search(q, k);
}

function listNotes(args) {
  const s = store.getStore();
  const ql = args.q ? String(args.q).toLowerCase() : null;
  return Object.values(s.notes).filter((n) => {
    if (args.parent && n.parent !== args.parent) return false;
    if (args.tag && !(Array.isArray(n.tags) && n.tags.includes(args.tag))) return false;
    if (ql && !String(n.text || '').toLowerCase().includes(ql)) return false;
    return true;
  });
}

const HANDLERS = {
  memhub_recall: (args) => recall(args),
  memhub_save_note: (args) => store.addNote(args),
  memhub_find_nodes: (args) => graph.search(args.query, args.limit),
  memhub_get_node: (args) => getNode(args.id),
  memhub_create_node: (args) => publicNode(store.upsertNode(args.type, args.label, args.meta)),
  memhub_link_nodes: (args) => store.upsertEdge(args.source, args.target, args.type, args.weight),
  memhub_neighborhood: (args) => {
    const r = graph.neighbors(args.id, args.hops);
    return { center: r.center, subgraph: { nodes: r.subgraph.nodes.map(publicNode), edges: r.subgraph.edges } };
  },
  memhub_stats: () => graph.stats(),
  memhub_list_notes: (args) => listNotes(args),
  memhub_backup: () => graph.makeBackupFile(),
};

function respond(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function callTool(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return Promise.reject(new Error('tools/call requires params {name, arguments}'));
  }
  const def = TOOL_BY_NAME[params.name];
  if (!def) return Promise.reject(new Error(`unknown tool: ${String(params.name)}`));
  const args = params.arguments == null ? {} : params.arguments;
  if (typeof args !== 'object' || Array.isArray(args)) return Promise.reject(new Error('arguments must be an object'));
  for (const key of def.inputSchema.required) {
    if (args[key] === undefined || args[key] === null) return Promise.reject(new Error(`missing required argument: ${key}`));
  }
  return Promise.resolve(HANDLERS[def.name](args)).then((value) => ({
    content: [{ type: 'text', text: JSON.stringify(value) }],
  }));
}

async function handleRequest(body) {
  // Notifications (no id property) never get a response.
  const hasId = Object.prototype.hasOwnProperty.call(body, 'id');
  if (body.method === 'initialize') {
    if (hasId) {
      respond({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'memhub', version: '1.0.0' },
        },
      });
    }
    return;
  }
  if (body.method === 'tools/list') {
    if (hasId) respond({ jsonrpc: '2.0', id: body.id, result: { tools: TOOLS } });
    return;
  }
  if (body.method === 'tools/call') {
    if (!hasId) return;
    let result;
    try {
      result = await callTool(body.params);
    } catch (err) {
      const msg = err && err.message ? err.message : err && err.error ? err.error : String(err);
      result = { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true };
    }
    respond({ jsonrpc: '2.0', id: body.id, result });
    return;
  }
  if (hasId) respond({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
}

async function handleLine(line) {
  const text = line.trim();
  if (!text) return;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    respond({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  await handleRequest(body);
}

// Requests are handled strictly in arrival order, even when a handler awaits
// I/O (recall may call the local web server).
let queue = Promise.resolve();
function enqueue(fn) {
  queue = queue.then(fn).catch(() => {});
  return queue;
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    enqueue(() => handleLine(line));
    idx = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  enqueue(async () => {
    if (buffer.trim()) await handleLine(buffer);
    buffer = '';
    // Natural drain: watcher unref'd, pending stdout flushed, then exitCode 0.
    store.closeForExit();
    process.exitCode = 0;
  });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.closeForExit();
    process.exit(0); // stdin may still be open; a bare exitCode would leave a zombie
  });
}
