# memHub

Cross-model memory and knowledge-graph hub for AI coding agents. One shared brain
for Claude Code, opencode, Antigravity, Cursor, or any MCP client â€” with an
Obsidian-style graph web UI â€” everything local, zero npm dependencies.

```
AI models â”€â”€(MCP stdio)â”€â”€ mcp.js â”€â”€â”
                                   â”œâ”€â”€ store.json  <-- the one shared memory file
browser  â”€â”€(HTTP :4777)â”€â”€ api.js â”€â”€â”˜        |
         (Obsidian-style graph UI)          +-- server/data/store.json
```

## Quickstart

```powershell
cd C:\Users\Allen\not-hentai\memHub
npm start          # web UI + REST API on http://127.0.0.1:4777
npm test           # 32-test e2e suite (own port + temp data dir, safe to run while server is up)
```

Open http://127.0.0.1:4777 â€” force-directed graph of everything your models
remember. Click a node to see its notes and neighbors; type in the search bar;
`+ Node` to add anything; drag nodes; wheel to zoom.

## Inter-model usage (the point)

Connect each tool to the same MCP server (they all read/write `server/data/store.json`):

- **Claude Code**: `claude mcp add memHub -- node "C:\Users\Allen\not-hentai\memHub\server\src\mcp.js"`
- **opencode**: `mcp` block in `~/.config/opencode/opencode.json` (already added â€” see below)
- **Antigravity**: `mcpServers` in `~/.gemini/settings.json` (already added)
- **Cursor**: `~/.cursor/mcp.json` (already added)

Full details and JSON blocks: [INTEGRATION.md](INTEGRATION.md).

After that, context flows between models:

```
opencode session:  memHub_save_note("DB schema locked: users+v2 ids", tags:["decision"], model:"opencode")
                   memHub_link_nodes("project:myapp", "concept:user-schema")
Claude Code session:  memHub_neighborhood("project:myapp") -> sees the schema decision
                      memHub_find_nodes("user schema") -> finds it, builds on it
Antigravity:          same store, same graph, same notes
You in the browser:   watch it all accumulate live
```

## MCP tools (what models get)

| Tool | Args | Purpose |
|---|---|---|
| `memHub_save_note` | `text, parent?, tags?, model?, session?` | Store a memory/fact/decision |
| `memHub_find_nodes` | `query, limit?` | Search the graph by label/notes |
| `memHub_get_node` | `id` | Full node: edges, neighbors, notes |
| `memHub_create_node` | `type, label, meta?` | project/file/concept/person/decision/session |
| `memHub_link_nodes` | `source, target, type?, weight?` | Connect things (auto-creates missing nodes) |
| `memHub_neighborhood` | `id, hops?` | BFS subgraph around a node |
| `memHub_stats` | `{}` | Counts + most-connected nodes |
| `memHub_list_notes` | `parent?, q?, tag?` | Search notes |
| `memHub_backup` | `{}` | Full backup to `server/data/` |

## CLI (humans / scripted agents)

```powershell
.\client\memHub.ps1 stats
.\client\memHub.ps1 notes "Chose SQLite over Postgres" -Model claude-opus-4 -Tags decision
.\client\memHub.ps1 find "auth"
.\client\memHub.ps1 link project:myapp concept:auth -Type depends-on
.\client\memHub.ps1 hops project:myapp 2
.\client\memHub.ps1 backup
```

## REST API

Same surface over HTTP (CORS *, local only): see [CONTRACT.md](CONTRACT.md).
Highlights: `GET /api/graph`, `GET /api/node/:id`, `POST /api/node`,
`POST /api/edge`, `POST /api/notes`, `GET /api/notes?q=&tag=`,
`GET /api/search?q=`, `GET /api/query/:id?hops=2`, `POST /api/backup`,
`GET /api/log`, `POST /api/sessions`.

## Design notes

- **Zero dependencies.** Node 22+ built-ins only. No build step. No framework.
- **Env vars:** `memHub_PORT` (default 4777), `memHub_DATA` (default `server/data`, used by tests), `memHub_DEBUG` (stderr trace, tagged with pid). Client reads `memHub_URL` for a remote hub.
- **One shared file** (`server/data/store.json`) â€” MCP processes and the web
  server are separate OS processes; a filesystem watcher keeps them coherent
  (~500ms), and writes are atomic (temp file + rename) with debounced saves.
- **IDs are deterministic**: `concept:auth-system`, `file:c:/proj/src/app.js` â€”
  re-adding the same thing updates it instead of duplicating it.
- **Windows PowerShell 5.1 compatible** CLI.
- **Local-only by design**: binds 127.0.0.1, no auth. Do not port-forward it.

## Layout

```
memHub/
  server/src/index.js    HTTP entry (port 4777)
  server/src/api.js      REST routes
  server/src/static.js   static file serving (no traversal)
  server/src/store.js    data layer + persistence + cross-process coherence
  server/src/graph.js    search / BFS / stats / backup
  server/src/mcp.js      MCP stdio server (JSON-RPC 2.0)
  web/                   SPA graph UI (vanilla, no build)
  client/                PowerShell CLI
  CONTRACT.md            exact data model + API spec
  INTEGRATION.md         per-tool MCP setup
```
