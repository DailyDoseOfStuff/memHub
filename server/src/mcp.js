'use strict';

const store = require('./store');
const graph = require('./graph');

store.load();

const TOOLS = [
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

function getNode(id) {
  const s = store.getStore();
  const nid = store.resolveId(id) || id;
  const node = s.nodes[nid];
  if (!node) throw new Error('node not found');
  const edges = [];
  const neighborIds = new Set();
  for (const e of s.edges) {
    if (e.source === nid) {
      edges.push(e);
      neighborIds.add(e.target);
    } else if (e.target === nid) {
      edges.push(e);
      neighborIds.add(e.source);
    }
  }
  return {
    node,
    edges,
    neighbors: [...neighborIds].map((x) => s.nodes[x]).filter(Boolean),
    notes: Object.values(s.notes).filter((n) => n.parent === nid),
  };
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
  memhub_save_note: (args) => store.addNote(args),
  memhub_find_nodes: (args) => graph.search(args.query, args.limit),
  memhub_get_node: (args) => getNode(args.id),
  memhub_create_node: (args) => store.upsertNode(args.type, args.label, args.meta),
  memhub_link_nodes: (args) => store.upsertEdge(args.source, args.target, args.type, args.weight),
  memhub_neighborhood: (args) => graph.neighbors(args.id, args.hops),
  memhub_stats: () => graph.stats(),
  memhub_list_notes: (args) => listNotes(args),
  memhub_backup: () => graph.makeBackupFile(),
};

function respond(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function callTool(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('tools/call requires params {name, arguments}');
  }
  const def = TOOL_BY_NAME[params.name];
  if (!def) throw new Error(`unknown tool: ${String(params.name)}`);
  const args = params.arguments == null ? {} : params.arguments;
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
  for (const key of def.inputSchema.required) {
    if (args[key] === undefined || args[key] === null) throw new Error(`missing required argument: ${key}`);
  }
  return { content: [{ type: 'text', text: JSON.stringify(HANDLERS[def.name](args)) }] };
}

function handleRequest(body) {
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
      result = callTool(body.params);
    } catch (err) {
      const msg = err && err.message ? err.message : err && err.error ? err.error : String(err);
      result = { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true };
    }
    respond({ jsonrpc: '2.0', id: body.id, result });
    return;
  }
  if (hasId) respond({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
}

function handleLine(line) {
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
  handleRequest(body);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    handleLine(line);
    idx = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  if (buffer.trim()) handleLine(buffer);
  buffer = '';
  // Natural drain: watcher unref'd, pending stdout flushed, then exitCode 0.
  store.closeForExit();
  process.exitCode = 0;
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store.closeForExit();
    process.exit(0); // stdin may still be open; a bare exitCode would leave a zombie
  });
}
