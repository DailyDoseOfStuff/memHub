# memHub â€” Cross-Model Memory & Knowledge Graph Hub

A local web app + API that lets ANY AI model (Claude Code, opencode, Antigravity, Cursor, any MCP client) share one persistent memory: a knowledge graph of projects, files, concepts, decisions, and sessions, PLUS freeform context notes. Renders as an interactive Obsidian-style graph web UI.

## Architecture

- **server/** â€” Node.js, ZERO npm dependencies (Node 24 built-ins only: http, fs, crypto).
  - `server/src/index.js` â€” HTTP server, port **4777**, binds 127.0.0.1. Entry point. Imports all route modules.
  - `server/src/store.js` â€” data layer. All reads/writes go through it. Persists to `server/data/store.json` (atomic write: temp file + rename). Debounced (250ms). Data model:
    ```js
    {
      version: 1,
      nodes: { [id]: Node },   // Node = { id, type, label, meta: {}, createdAt, updatedAt }
      edges: [ Edge ],         // Edge = { id, source, target, type, weight, meta: {}, createdAt }
      notes: { [id]: Note },   // Note = { id, parent: null|nodeId, text, tags: [], model, session, createdAt, updatedAt }
      sessions: { [id]: Session } // Session = { id, model, agent, startedAt, summary }
      log: [ {ts, action, detail} ]  // capped at 500 entries, newest last
    }
    ```
  - Node types: `project`, `file`, `concept`, `person`, `decision`, `session`, `note`.
  - IDs: `type:sanitized-label` e.g. `file:C:\proj\src\app.js` â†’ deterministic; concept nodes use `concept:auth-system` (slugified).
  - `server/src/api.js` â€” REST routes. All JSON. See "API contract" below.
  - `server/src/graph.js` â€” graph algorithms: neighbors(id, hops), search(q), stats(), backup().
  - `server/src/static.js` â€” serves `web/` files with correct MIME types, path traversal protected.
  - `server/src/mcp.js` â€” MCP server over stdio (JSON-RPC 2.0, newline-delimited). Exposes the same ops as the API as MCP tools. Started via `node server/src/mcp.js`.
- **web/** â€” vanilla JS SPA, no build step, no CDN. Files:
  - `web/index.html`, `web/app.js`, `web/graph.js`, `web/style.css` (dark Obsidian-like theme)
  - Graph view: SVG force-directed layout, live physics in JS (repulsion + spring + gravity; alpha decays Ã—0.975/frame from 1.0 on first load / 0.35 on data change until <0.01 â‰ˆ 180/40 frames). Pan/zoom (cursor-anchored wheel), drag pins nodes, click to select, double-click 2-hop focus, hover highlight, note satellites, 5s live poll. Search box.
  - Detail popup: floating panel slides in from the right on node select (graph stays centered underneath); Ã— closes, Esc deselects, hamburger pins panel open; recents strip (localStorage) over the graph for fast hopping.
  - Notes panel: notes for selected node; form to add note (text + tags + model); notes shown timeline-style.
  - Top bar: search input, node-type filter checkboxes, add-node button, backup button, stats button.
- **client/** â€” CLI wrapper. `client/memHub.ps1` (PowerShell 5.1 compatible) and `client/README.md`.
- **INTEGRATION.md** â€” how to wire MCP into Claude Code / opencode / Antigravity / Cursor / Codex (JSON snippets edited per-user later).
- Root: `memHub/package.json` with `"start": "node server/src/index.js"`, `"mcp": "node server/src/mcp.js"`.

## API contract (exact paths & payloads â€”å¬ç€ agents: DO NOT DEVIATE)

Base: `http://127.0.0.1:4777`. All responses JSON. CORS: `Access-Control-Allow-Origin: *`, handle OPTIONS with 204.

External consumers (do NOT remove endpoints these use):
- `ai-harness` (C:\Users\Allen\not-hentai\ai-harness, src/memHub.rs): `GET /api/health`, `POST /api/node` (expects idempotent upsert, reads `node.id`), `GET /api/query/:id?hops=2` (reads `center` + `subgraph.nodes[].{id,label,type}`), `GET /api/notes?parent=` (reads `notes[].{id,text,model,createdAt}`), `POST /api/notes`, `GET /api/search?q&limit` (reads `results[].{id,label,type,score}`), `POST /api/sessions`, `DELETE /api/notes/:id`, `DELETE /api/node/:id`. Its web dashboard fetches `GET /api/graph` from the browser (needs the CORS wildcard).

- `GET /api/health` â†’ `{ ok: true, version, counts: { nodes, edges, notes, sessions } }`
- `GET /api/graph` â†’ `{ nodes: [Node], edges: [Edge], notes: [Note] }` (full graph + notes for the animated UI)
- `GET /api/stats` â†’ `{ nodes, edges, notes, byType: {project: n, ...}, topConnected: [ {id, label, type, degree} x10 ] }`
- `GET /api/node/:id` â†’ `{ node, edges: [edges involving id], neighbors: [Node], notes: [Note] }` â€” id must be URL-encoded by caller.
- `POST /api/node` body `{ type, label, meta? }` â†’ `{ node }` (id derived deterministically; upsert: existing id updates label; `meta` is replaced ONLY when a non-empty object is provided â€” omitted or `{}` keeps the existing meta; createdAt preserved; `type` must be one of project|file|concept|person|decision|session|note, else 400)
- `DELETE /api/node/:id` â†’ `{ deleted: true }`, 404 `{error}` if missing (also removes incident edges and detaches notes)
- `POST /api/edge` body `{ source, target, type?, weight? }` â†’ `{ edge }` (both nodes must exist or are auto-created as type `concept` by re-slugging the id; edge id derived `edge:${source}::${target}::${type}`, `type` defaults to `related`; upsert)
- `DELETE /api/edge/:id` (id = The same derivation, URL-encoded) â†’ `{ deleted: true }` â€” idempotent, 200 even if id never existed
- `POST /api/notes` body `{ text, parent?, tags?, model?, session? }` â†’ `{ note }` (parent may be a node id, or omitted; non-array `tags` silently becomes `[]`)
- `GET /api/notes?parent=<id>&q=<text>&tag=<t>` â†’ `{ notes: [Note] }` (filters optional, combinable)
- `DELETE /api/notes/:id` â†’ `{ deleted: true }` â€” idempotent, 200 even if id never existed
- `POST /api/sessions` body `{ model, agent?, summary? }` â†’ `{ session }` (id: `session:<model>-<timestamp>`; also creates a `session` node whose label is the session id â†’ node id `session:session-<model>-<timestamp>`; no session edges; logged as `session.create`)
- `GET /api/search?q=<query>&limit=10` â†’ `{ results: [ {id, label, type, score} ] }` â€” substring match on label + note text, score = simple relevance. Coercions: `limit` parsed as int (â‰¥1, default 10, no max); empty/whitespace `q` â†’ `[]`.
- `GET /api/query/:id?hops=2` â†’ `{ center, subgraph: { nodes: [Node], edges: [Edge] } }` â€” BFS neighborhood. `hops` clamped to 1-5; missing/invalid â†’ 2.
- `POST /api/backup` â†’ `{ ok, file: "<ABSOLUTE path to server/data/backup-<ISO>.json>" }` (full copy, NOT debounced, writes immediately)
- `GET /api/log?limit=50` â†’ `{ log: [...] }` (capped at 500 entries, oldest evicted)

## MCP contract (tools exposed by server/src/mcp.js)

MCP protocol: JSON-RPC 2.0 over stdio, newline-delimited JSON. Respond to `initialize` with `protocolVersion: "2024-11-05"`, `capabilities: { tools: {} }`. Respond to `tools/list`, `tools/call` (params `{name, arguments}` â†’ `{ content: [{type:"text", text:"<json-stringified>"}] }`). Respond with JSON-RPC error `-32601` for unknown method, `-32700` for parse errors, `-32600` for non-object request bodies. Tool errors return a normal result with `isError: true`. Notifications (no `id` field) get NO response.

Tools (thin wrappers over store/graph â€” each returns the same JSON as the REST counterpart):
1. `memHub_save_note` args `{ text: string, parent?: string, tags?: string[], model?: string, session?: string }`
2. `memHub_find_nodes` args `{ query: string, limit?: number }`
3. `memHub_get_node` args `{ id: string }`
4. `memHub_create_node` args `{ type: string, label: string, meta?: object }`
5. `memHub_link_nodes` args `{ source: string, target: string, type?: string, weight?: number }`
6. `memHub_neighborhood` args `{ id: string, hops?: number }`
7. `memHub_stats` args `{}` (empty ok)
8. `memHub_list_notes` args `{ parent?: string, q?: string, tag?: string }`
9. `memHub_backup` args `{}`

The MCP server imports store/graph DIRECTLY (same process, no HTTP needed) â€” so it works even if the web server isn't running.

## Style rules
- No npm dependencies. No build step. No frameworks. No TypeScript. Node 24 / modern browsers only, so ES2024 is fine.
- Comments: minimal, only where non-obvious.
- All files end with newline. 2-space indent. Single quotes in JS.
- Passwords/keys: none. Everything local-only (127.0.0.1).
