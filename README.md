# memHub

Cross-model memory and knowledge-graph hub for AI coding agents. One shared brain
for Claude Code, opencode, Codex, Antigravity, Cursor, or any MCP client - with a 3D
interactive universe web UI - everything local. Core is dependency-free; the
semantic layer adds one optional local embedding package. Apache-2.0.

```
AI models --(MCP stdio)-- mcp.js --.
                                     +-- store.json  <-- the one shared memory file
browser --(HTTP :4777)-- api.js --'
        (Obsidian-style graph UI)         +-- server/data/store.json
```

## Install everywhere (marketplace / installer)

**Claude Code - plugin marketplace** (this repo IS the marketplace):

```powershell
claude plugin marketplace add DailyDoseOfStuff/memHub
claude plugin install memhub@memhub-marketplace
```

Gives every Claude Code session the 10 memHub MCP tools, the shared-brain skill
(`memhub-protocol`: recall before building, save decisions with origin), and the
`/remember <text>` command.

**Everything else - one installer** (Codex CLI, Cursor, opencode; also repairs Claude
Code's native `claude mcp` wiring if the marketplace path is unavailable):

```powershell
git clone https://github.com/DailyDoseOfStuff/memHub
cd memHub
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Idempotent, PowerShell 5.1 compatible. Skippable per tool: `-SkipCodex`,
`-SkipCursor`, `-SkipOpCode`, `-SkipClaude`. Full per-tool JSON snippets:
[INTEGRATION.md](INTEGRATION.md).

Then start the universe (server is optional; MCP tools work without it):

```powershell
docker compose up -d --build    # or: npm start
```

## Quickstart

```powershell
cd C:\Users\Allen\not-hentai\memHub
npm install        # once: local embedding model runtime (first run downloads ~23MB, then offline)
npm start          # web UI + REST API on http://127.0.0.1:4777
npm test           # 46-test e2e suite (own port + temp data dir, offline-safe)
```

Open http://127.0.0.1:4777 - a 3D universe of everything your models remember.
Semantically close context clusters into colour-coded groups; real edges always
render. Click a node for its notes and neighbours; double-click to focus its
2-hop neighbourhood; drag to orbit, wheel to zoom; `/` to search; `+ Node` to add.

## Docker (the container way)

Same `npm start` behavior, but isolated: web UI + API + embedding model run in one container; the data dir is bind-mounted so agent-side MCP (which stays on the host) shares the exact same memory file.

**Setup**

```powershell
cd C:\Users\Allen\not-hentai\memhub
# stop any host npm start first - the container takes port 4777
docker compose up -d --build     # first run: builds memhub:latest (~1-2 min)
docker compose logs -f memhub    # watch
docker compose down              # stop
```

Open http://127.0.0.1:4777 - same universe, now in its own container.

- **Ports**: published to `127.0.0.1:4777` only (loopback, the app has no auth - never port-forward it).
- **Data**: `./server/data` on the host IS the container's `/data`. store.json, backups, `llm-cache` (the ~23MB model download) all persist there across container rebuilds. No volume dance.
- **MCP agents**: unchanged. Claude Code / opencode / Cursor / Antigravity keep running `server\src\mcp.js` as a host process; the container's filesystem watcher converges with them in ~2s. Verified both directions.
- **Embedded model**: works inside the container (`/api/embed/status` -> `ready`). onnxruntime-node needs glibc, that's why the image is `node:24-slim` and NOT alpine.
- **Auto-start on reboot**: `restart: unless-stopped` is set; start Docker Desktop (Settings -> General -> Start when you log in) and memHub comes back with it.
- **Env knobs**: `MEMHUB_NO_EMBED=1` in docker-compose.yml to run vector-less; `MEMHUB_PORT` if you must move the host port (change the publish map, not CMD).

**Host standalone (the old way)** still works: `npm start`. Run one or the other, never both - they fight over 4777.

## Inter-model usage (the point)

Connect each tool to the same MCP server (they all read/write `server/data/store.json`):

- **Claude Code**: `claude mcp add memHub -- node "C:\Users\Allen\not-hentai\memHub\server\src\mcp.js"`
- **opencode**: `mcp` block in `~/.config/opencode/opencode.json` (already added - see below)
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
| `memHub_recall` | `query, limit?, budget?` | One-call context recall: matched nodes + their notes + neighbours. `budget` (tokens) caps the payload: rank-ordered fill, near-duplicate notes deduped, meta stripped, truncation marked `...(+N chars)` |
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

## Universal project import (all of not-hentai)

`tools/import.js` scans a folder tree and builds the interconnection web:

```powershell
node tools\import.js C:\Users\Allen\not-hentai            # full scan, commits
node tools\import.js C:\Users\Allen\not-hentai --dry-run  # preview
node tools\import.js <root> --max-files 20                # deeper per-project
```

- One `project:` node per top-level directory, `meta.path` points at the folder.
- Key files (README, package manifests, a few src files; default 12, `--max-files` to change) become `file:` nodes with `contains` edges; file ids encode the full relative path.
- The README head is stored as a `project-importer` note on the project, so embeddings cluster related projects in the 3D universe.
- Projects sharing >= 3 distinctive summary words get a weighted `related` edge; weaker legacy related edges are pruned on re-run.
- Idempotent: re-run anytime, updates in place, never duplicates.

## REST API

Same surface over HTTP (CORS *, local only): see [CONTRACT.md](CONTRACT.md).
Highlights: `GET /api/graph`, `GET /api/node/:id`, `POST /api/node`,
`POST /api/edge`, `POST /api/notes`, `GET /api/notes?q=&tag=`,
`GET /api/search?q=`, `GET /api/query/:id?hops=2`, `POST /api/backup`,
`GET /api/log`, `POST /api/sessions`.

## Design notes

- **Semantic layer.** `server/src/embed.js` runs MiniLM-L6-v2 (`all-MiniLM-L6-v2`, Apache-2.0, 384-d) locally through `@xenova/transformers`. Vectors are computed on node/note writes, cached in `server/data/llm-cache`, and never leave the machine. Missing/stale vectors are backfilled in the background (startup + 60s sweeps). Set `MEMHUB_NO_EMBED=1` to run fully without the model (vector-less; the UI then uses real edges + type colours).
- **Deterministic 3D map.** `server/src/layout.js` turns the union graph into stable 3D coordinates (seeded PRNG + 250 fixed iterations, hash-checked): same data always produces the same universe, so the map is one place agents and sessions agree on. Served via `GET /api/layout`, persisted under `layout` in `store.json`, and used by the browser to seed node positions and re-use the server's union graph. See the DESIGN section in [CONTRACT.md](CONTRACT.md).
- **3D math.** Similarity = cosine over stored vectors; mutual top-6 neighbours above 0.35 become soft springs. Communities come from weighted label propagation over the union of real edges (weight 1) and similarity links (weight = cosine), so semantic clusters and hand-made structure share one layout. `web/vendor/3d-force-graph.min.js` is a pinned UMD build (three bundled) - no build step, no CDN.
- **Zero dependencies (core).** Node built-ins only for store/API/MCP; the embedding model package is the single optional add-on.
- **Env vars:** `MEMHUB_PORT` (default 4777), `MEMHUB_DATA` (default `server/data`, used by tests), `MEMHUB_DEBUG` (stderr trace, tagged with pid), `MEMHUB_NO_EMBED=1` (disable embeddings). Client reads `MEMHUB_URL` for a remote hub. Node >= 22.12 (or 24) required.
- **One shared file** (`server/data/store.json`) - MCP processes and the web
  server are separate OS processes; a filesystem watcher keeps them coherent
  (~500ms), and writes are atomic (temp file + rename) with debounced saves.
- **IDs are deterministic**: `concept:auth-system`, `file:c:/proj/src/app.js` -
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
  server/src/layout.js   deterministic 3D positions (server-computed map)
  server/src/embed.js    local MiniLM embeddings (optional semantic layer)
  server/src/mcp.js      MCP stdio server (JSON-RPC 2.0)
  web/                   3D universe SPA (vanilla, no build; vendored 3D lib)
  client/                PowerShell CLI
  CONTRACT.md            exact data model + API spec
  INTEGRATION.md         per-tool MCP setup
```
