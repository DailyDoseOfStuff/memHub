# MemHub CLI

`memhub.ps1` is a small PowerShell client for the MemHub knowledge-graph server. It is a thin wrapper over the same REST API the web UI uses, so anything saved through the CLI shows up instantly in the web UI and in every model's MCP session.

## Prerequisites

- Node 24 for the server. Zero npm dependencies, no build step.
- Start the server: `cd memhub` then `npm start` -- serves the web UI and REST API at `http://127.0.0.1:4777`.
- Windows PowerShell 5.1 or later (ships with Windows). Run the script from anywhere: `powershell -ExecutionPolicy Bypass -File .\client\memhub.ps1 ...` or dot-run it in a session that allows scripts.

Base URL override:

```
$env:MEMHUB_URL = 'http://127.0.0.1:4777'
.\memhub.ps1 stats
```

## Commands

### notes

Save a freeform note. `-Tags` takes a comma-separated list, `-Model` records which model wrote it, `-Parent` attaches it to a node id. POSTs to `/api/notes`.

```
.\memhub.ps1 notes "Chose SQLite over Postgres" -Model "claude-opus-4" -Tags decision,database
.\memhub.ps1 notes "Try paginated graph fetch next" -Parent project:memhub -Model "gpt-5"
```

### find

Search labels and note text. GET `/api/search?q=`. Output is `score  label  [type]  id`.

```
.\memhub.ps1 find "auth"
```

### node

Show one node: info, neighbors, note count. GET `/api/node/:id` (id is URL-encoded automatically).

```
.\memhub.ps1 node concept:auth-system
```

### link

Create an edge between two node ids (missing endpoints are auto-created as `concept` nodes). POST `/api/edge`.

```
.\memhub.ps1 link project:memhub concept:auth-system -Type relates-to
```

### add

Create (or upsert) a node from a type + label. Valid types: `project`, `file`, `concept`, `person`, `decision`, `session`, `note`. POST `/api/node`.

```
.\memhub.ps1 add project "memhub"
.\memhub.ps1 add decision "Use SQLite over Postgres"
```

### stats

Counts by type plus a top-connected table. GET `/api/stats`.

```
.\memhub.ps1 stats
```

### hops

BFS neighborhood of a node, depth defaults to 2. GET `/api/query/:id?hops=n`.

```
.\memhub.ps1 hops project:memhub 3
```

### backup

Write an immediate full copy of the store. POST `/api/backup`. Prints the backup file path.

```
.\memhub.ps1 backup
```

### help

No args, `help`, or `-Help` prints usage.

```
.\memhub.ps1
.\memhub.ps1 -Help
```

If the server is not running, HTTP calls fail with:

```
MemHub server not running at http://127.0.0.1:4777 — start it: npm start (in memhub/)
```
