# memHub - Cross-Model Memory & Knowledge Graph Hub

A local web app + API that lets ANY AI model (Claude Code, opencode, Antigravity, Cursor, any MCP client) share one persistent memory: a knowledge graph of projects, files, concepts, decisions, and sessions, PLUS freeform context notes. Renders as an interactive Obsidian-style graph web UI.

## Architecture

- **server/** - Node.js. Core is dependency-free built-ins (http, fs, crypto); the optional embedding layer uses `@xenova/transformers` (MiniLM-L6-v2, local, offline after first download). Node >= 22.12 (or 24) required.
  - `server/src/index.js` - HTTP server, port **4777**, binds 127.0.0.1. Entry point. Imports all route modules.
  - `server/src/store.js` - data layer. All reads/writes go through it. Persists to `server/data/store.json` (atomic write: temp file + rename). Debounced (250ms). Data model:
    ```js
    {
      version: 1,
      nodes: { [id]: Node },   // Node = { id, type, label, meta: {}, createdAt, updatedAt }
      edges: [ Edge ],         // Edge = { id, source, target, type, weight, meta: {}, createdAt }
      notes: { [id]: Note },   // Note = { id, parent: null|nodeId, text, tags: [], model, session, createdAt, updatedAt }
      sessions: { [id]: Session } // Session = { id, model, agent, startedAt, summary }
      log: [ {ts, action, detail} ]  // capped at 500 entries, newest last
      layout: { hash, positions: { [id]: [x,y,z] }, links: [ {source,target,w,real?,sim?} ] }
    }
    ```
  - Node types: `project`, `file`, `concept`, `person`, `decision`, `session`, `note`.
  - IDs: `type:sanitized-label` e.g. `file:C:\proj\src\app.js` â†’ deterministic; concept nodes use `concept:auth-system` (slugified).
  - `server/src/api.js` - REST routes. All JSON. See "API contract" below.
  - `server/src/graph.js` - graph algorithms: neighbors(id, hops), search(q), stats(), backup().
  - `server/src/static.js` - serves `web/` files with correct MIME types, path traversal protected.
  - `server/src/mcp.js` - MCP server over stdio (JSON-RPC 2.0, newline-delimited). Exposes the same ops as the API as MCP tools. Started via `node server/src/mcp.js`.
- **web/** - vanilla JS SPA, no build step, no CDN. Files:
  - `web/index.html`, `web/app.js`, `web/graph3d.js`, `web/style.css` (dark theme), `web/vendor/3d-force-graph.min.js` (pinned UMD build, three bundled)
  - Graph view: 3D force universe on WebGL. Similarity links come from stored MiniLM embeddings (mutual top-6, cosine floor 0.35); real edges always render. Communities via weighted label propagation colour the clusters. Type filters and neighbourhood focus use node/link visibility (no relayout). Positions persist across the 5s poll. Click selects, double-click 2-hop focus, orbit/zoom/pinch, hover label, 5s live poll. Search box.
  - Detail popup: floating panel slides in from the right on node select (graph stays centered underneath); Ã- closes, Esc deselects, hamburger pins panel open; recents strip (localStorage) over the graph for fast hopping.
  - Notes panel: notes for selected node; form to add note (text + tags + model); notes shown timeline-style.
  - Top bar: search input, node-type filter checkboxes, add-node button, backup button, stats button.
- **client/** - CLI wrapper. `client/memHub.ps1` (PowerShell 5.1 compatible) and `client/README.md`.
- **INTEGRATION.md** - how to wire MCP into Claude Code / opencode / Antigravity / Cursor / Codex (JSON snippets edited per-user later).
- Root: `memHub/package.json` with `"start": "node server/src/index.js"`, `"mcp": "node server/src/mcp.js"`.

## API contract (exact paths & payloads -å¬ç€ agents: DO NOT DEVIATE)

Base: `http://127.0.0.1:4777`. All responses JSON. CORS: `Access-Control-Allow-Origin: *`, handle OPTIONS with 204.

External consumers (do NOT remove endpoints these use):
- `ai-harness` (C:\Users\Allen\not-hentai\ai-harness, src/memHub.rs): `GET /api/health`, `POST /api/node` (expects idempotent upsert, reads `node.id`), `GET /api/query/:id?hops=2` (reads `center` + `subgraph.nodes[].{id,label,type}`), `GET /api/notes?parent=` (reads `notes[].{id,text,model,createdAt}`), `POST /api/notes`, `GET /api/search?q&limit` (reads `results[].{id,label,type,score}`), `POST /api/sessions`, `DELETE /api/notes/:id`, `DELETE /api/node/:id`. Its web dashboard fetches `GET /api/graph` from the browser (needs the CORS wildcard).

- `GET /api/health` â†’ `{ ok: true, version, counts: { nodes, edges, notes, sessions } }`
- `GET /api/graph` â†’ `{ nodes: [Node], edges: [Edge], notes: [Note], embedRev }` (full graph + notes for the 3D UI; nodes are stripped of `embedding`; `embedRev` changes whenever any vector changes)
- `GET /api/embeddings` â†’ `{ status: { status, model, dim, error }, rev, dim, vectors: { [nodeId]: [384 floats] } }` (only nodes with vectors; when the engine is ready, missing/stale nodes are refreshed in the background)
- `GET /api/embed/status` â†’ `{ status: loading|ready|failed, model, dim, error }`
- `GET /api/stats` â†’ `{ nodes, edges, notes, byType: {project: n, ...}, topConnected: [ {id, label, type, degree} x10 ] }`
- `GET /api/layout` â†’ `{ rev, status: ready|stale, hash, positions: { [nodeId]: [x,y,z] }, links: [ {source,target,w,real?,sim?} ] }` - deterministic 3D context map (see DESIGN). hash = sha1 over node ids + vector hashes + union graph; same data -> same coordinates, always. `status: stale` means the hash changed after the stored layout was computed (or a >400-node background recompute is inflight) and the served positions/links are the previous snapshot; re-poll handles it. The union graph mirrors the browser: real edges (`real:1`, `w` = edge weight or 1) + mutual top-6 cosine similarity links (â‰¥ 0.35, `sim` = cosine) over cached MiniLM vectors, pair-deduped, real edge wins.
- `GET /api/node/:id` â†’ `{ node, edges: [edges involving id], neighbors: [Node], notes: [Note], origin }` - id must be URL-encoded by caller. `origin` = provenance (where the node's context came from): `{ models: [ { model, notes } ], sessions: [ { id, model, agent, startedAt, notes } ] }`, derived from attached notes' `model`/`session` fields, notes-count desc then name asc.
- `POST /api/node` body `{ type, label, meta? }` â†’ `{ node }` (id derived deterministically; upsert: existing id updates label; `meta` is replaced ONLY when a non-empty object is provided - omitted or `{}` keeps the existing meta; createdAt preserved; `type` must be one of project|file|concept|person|decision|session|note, else 400)
- `DELETE /api/node/:id` â†’ `{ deleted: true }`, 404 `{error}` if missing (also removes incident edges and detaches notes)
- `POST /api/edge` body `{ source, target, type?, weight? }` â†’ `{ edge }` (both nodes must exist or are auto-created as type `concept` by re-slugging the id; edge id derived `edge:${source}::${target}::${type}`, `type` defaults to `related`; upsert)
- `DELETE /api/edge/:id` (id = The same derivation, URL-encoded) â†’ `{ deleted: true }` - idempotent, 200 even if id never existed
- `POST /api/notes` body `{ text, parent?, tags?, model?, session? }` â†’ `{ note }` (parent may be a node id, or omitted; non-array `tags` silently becomes `[]`)
- `GET /api/notes?parent=<id>&q=<text>&tag=<t>` â†’ `{ notes: [Note] }` (filters optional, combinable)
- `DELETE /api/notes/:id` â†’ `{ deleted: true }` - idempotent, 200 even if id never existed
- `POST /api/sessions` body `{ model, agent?, summary? }` â†’ `{ session }` (id: `session:<model>-<timestamp>`; also creates a `session` node whose label is the session id â†’ node id `session:session-<model>-<timestamp>`; no session edges; logged as `session.create`)
- `GET /api/recall?q=<query>&limit=10&session=<id>` → when `budget` is ABSENT: `{ mode, results: [ {id,label,type,score} ] }` (unchanged, ranking only). When `budget=<tokens>` (200-100000) is PRESENT: `{ mode, ranking, nodes: [ { node, notes: [ {text,tags,model,createdAt} ], neighbors: [ {id,label} ] } ], tokens: { used, notesDropped, dupesDropped, nodesDropped, full, saved, savedPct } }` - ranked results assembled into a token-budgeted context payload (see "Token budget" below). `session` (optional) tags the call in the token-savings ledger; `tokens.full`/`saved`/`savedPct` compare the spend to what an un-budgeted recall of the same hits would have shipped.
- `GET /api/search?q=<query>&limit=10` â†’ `{ results: [ {id, label, type, score} ] }` - token match on label, meta, and attached-note text; score tiers: label word exact +100 / prefix +80 / substring +60, meta word +20, note-hit +40 first / +10 extra, degree +1, recency +10/+5, full-label exact +1000. Coercions: `limit` parsed as int (â‰¥1, default 10, no max); empty/whitespace `q` â†’ `[]`.
- `GET /api/query/:id?hops=2` â†’ `{ center, subgraph: { nodes: [Node], edges: [Edge] } }` - BFS neighborhood. `hops` clamped to 1-5; missing/invalid â†’ 2.
- `POST /api/backup` â†’ `{ ok, file: "<ABSOLUTE path to server/data/backup-<ISO>.json>" }` (full copy, NOT debounced, writes immediately)
- `GET /api/log?limit=50` â†’ `{ log: [...] }` (capped at 500 entries, oldest evicted)
- `GET /api/tokens` â†’ `{ all: { calls, used, saved }, sessions: { <id>: { calls, used, saved, lastAt } } }` - token-savings ledger, recorded only by budgeted recall calls (HTTP `?session=` / MCP `session` arg; bucket defaults to `mcp`/`default` when absent). Persisted in store.json, survives restarts. Web UI renders it as the savings bar.

## MCP contract (tools exposed by server/src/mcp.js)

MCP protocol: JSON-RPC 2.0 over stdio, newline-delimited JSON. Respond to `initialize` with `protocolVersion: "2024-11-05"`, `capabilities: { tools: {} }`. Respond to `tools/list`, `tools/call` (params `{name, arguments}` â†’ `{ content: [{type:"text", text:"<json-stringified>"}] }`). Respond with JSON-RPC error `-32601` for unknown method, `-32700` for parse errors, `-32600` for non-object request bodies. Tool errors return a normal result with `isError: true`. Notifications (no `id` field) get NO response.

Tools (thin wrappers over store/graph - each returns the same JSON as the REST counterpart):
1. `memHub_recall` args `{ query: string, limit?: number, budget?: number, session?: string }` - one-call context recall: top nodes with notes + neighbor labels. Without `budget`: array of full-fat node blocks (legacy shape). With `budget` (200-100000 tokens): `{ nodes: [...], tokens: { used, notesDropped, dupesDropped, nodesDropped, full, saved, savedPct } }` - rank-ordered fill to the budget, near-duplicate notes deduped payload-wide (word-set Jaccard >= 0.8), meta/updatedAt stripped past rank 1, word/sentence-boundary truncation with `...(+N chars)` markers, neighbor labels deduped. `session` (optional) groups the call in the token-savings ledger (default bucket `mcp`).
2. `memHub_save_note` args `{ text: string, parent?: string, tags?: string[], model?: string, session?: string }`
3. `memHub_find_nodes` args `{ query: string, limit?: number }`
4. `memHub_get_node` args `{ id: string }` (response includes `origin` provenance, same shape as REST)
5. `memHub_create_node` args `{ type: string, label: string, meta?: object }`
6. `memHub_link_nodes` args `{ source: string, target: string, type?: string, weight?: number }`
7. `memHub_neighborhood` args `{ id: string, hops?: number }`
8. `memHub_stats` args `{}` (empty ok)
9. `memHub_list_notes` args `{ parent?: string, q?: string, tag?: string }`
10. `memHub_backup` args `{}`

The MCP server imports store/graph DIRECTLY (same process, no HTTP needed) - so it works even if the web server isn't running.

## Style rules
- Core stays dependency-free (Node built-ins). The only runtime dependency is `@xenova/transformers`, used solely by the optional embedding layer in `server/src/embed.js`. No build step. No frameworks. No TypeScript. Node 24 (>=22.12) / modern browsers only, so ES2024 is fine.
- Comments: minimal, only where non-obvious.
- All files end with newline. 2-space indent. Single quotes in JS.
- Passwords/keys: none. Everything local-only (127.0.0.1).

## Deterministic 3D layout (design)
`server/src/layout.js` computes THE 3D context map, pure + dependency-free:
1. Union graph via `buildLinks()`: real edges (weight 1) + mutual top-6 cosine kNN over cached vectors (floor 0.35) - same construction as `web/graph3d.js`, pair-deduped, real edge wins.
2. Hash (`layoutHashStore`): sha1 over sorted node ids + per-node embedding hashes + the union graph. Any text edit that changes vectors or links changes the hash.
3. `computeLayout(ids, links)`: mulberry32 PRNG seeded from hash of node ids + links; Box-Muller spread on an R0 = 70·cbrt(N) shell; then 250 fixed relaxation iterations (pairwise repulsion f = 25000/d, capped steps, spring pull to per-link rest length L: real edges 60, sim links 130â†’60 by cosine strength, weak origin gravity). Positions are rounded to 0.1.
Same data -> same coordinates across sessions, processes, agents. Browser (`setServerLayout`) seeds fresh nodes with served positions and skips its client kNN when the server layout is fresh; live-dragged nodes keep their in-session coords across the 5s poll. >400-node recomputes run in `setImmediate` background; `/api/layout` serves the previous map with `status: stale` until they land.

## Token budget (design)
`graph.recallContext(hits, { budget })` turns ranked hits into a context payload that fits an approximate token cap. Techniques and their tradeoff:
1. **Rank-then-fill** (LongLLMLingua question-aware keep): top hit survives whole, later hits shrink or vanish - highest value-per-token first.
2. **Redundancy prune** (MMR-lite): word-set Jaccard >= 0.8 notes are near-duplicates; only the first survives. Long paraphrases of the same fact cost ~0 tokens extra.
3. **Metadata strip**: past rank 1 the block keeps id/label/type only - meta is fat JSON and rarely load-bearing; legacy (no budget) keeps everything.
4. **Honest truncation**: cuts at word/sentence boundary and appends `...(+N chars)` - the model knows it read a prefix, not a summary.
5. **Label dedupe**: a neighbor label seen once never emits again - repeated names are pure cost.
Budget estimate is `chars/4` (engine-agnostic, dependency-free). `tokens.used` in the reply makes the spend observable; callers can log drift between 4/char and their real tokenizer without changing the contract.

**Savings accounting**: every budgeted recall also prices the same hits un-budgeted (`tokens.full`, same chars/4 estimate) and reports `tokens.saved` = full - used, plus `savedPct`. Each of these calls appends to the ledger at `store.tokens` (via `GET /api/tokens`), grouped by the caller's `session` bucket, so any agent or the web UI bar can show "tokens saved this session" without any extra instrumentation from the caller.
