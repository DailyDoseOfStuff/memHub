# memHub Integration - Plug Into AI Tools

## Overview

memHub gives any AI model one shared, persistent memory: a knowledge graph of projects, files, concepts, decisions, and sessions, plus freeform notes. Models reach it over MCP stdio; humans reach it through a web UI and REST API. Both paths read and write the same store, so everyone sees the same memory.

```
+---------------------------------------------------------------+
| AI models: Claude Code, opencode, Cursor, Antigravity,        |
| any MCP client                                                |
+-------------------------------+-------------------------------+
                                | stdio: JSON-RPC 2.0, newline-delimited
                                v
+---------------------------------------------------------------+
| server/src/mcp.js  --  MCP tools (memHub_save_note, ...)      |
+-------------------------------+-------------------------------+
                                | direct import, no HTTP
                                v
+---------------------------------------------------------------+
| server/src/store.js                                           |
|   persists to server/data/store.json (the one shared file;    |
|   atomic temp-file + rename, debounced ~250ms)                |
+-------------------------------^-------------------------------+
                                | direct import, no HTTP
+-------------------------------+-------------------------------+
| server/src/api.js  --  REST routes on 127.0.0.1:4777          |
+-------------------------------^-------------------------------+
                                | http, JSON (CORS open)
+-------------------------------+-------------------------------+
| browser: web/ SPA (Obsidian-style graph, notes panel)         |
| http://127.0.0.1:4777                                         |
+---------------------------------------------------------------+
```

Tools exposed over MCP (each returns the same JSON as its REST counterpart):

- `memhub_recall` `{ query, limit? }` - one call at session start: top matched nodes, each with attached notes and neighbor labels
- `memHub_save_note` `{ text, parent?, tags?, model?, session? }`
- `memHub_find_nodes` `{ query, limit? }`
- `memHub_get_node` `{ id }`
- `memHub_create_node` `{ type, label, meta? }`
- `memHub_link_nodes` `{ source, target, type?, weight? }`
- `memHub_neighborhood` `{ id, hops? }`
- `memHub_stats` `{}`
- `memHub_list_notes` `{ parent?, q?, tag? }`
- `memHub_backup` `{}`

## Shared memory principle

The MCP server (`server/src/mcp.js`) and the web server (`server/src/api.js`) both go through `server/src/store.js`, which persists everything to `server/data/store.json`. There is no separate database and no sync step: a note saved during one model's MCP session is instantly in the same file the web UI reads, and visible to every other model's next MCP call. Because `mcp.js` imports the store directly, MCP tools work even when the web server is not running; the web UI and REST API do need `npm start`.

## Claude Code

One-time setup:

```
claude mcp add memHub -- node "C:\Users\Allen\not-hentai\memHub\server\src\mcp.js"
```

Alternative: declare it in `.mcp.json` (project scope):

```json
{
  "mcpServers": {
    "memHub": {
      "command": "node",
      "args": ["C:\\Users\\Allen\\not-hentai\\memHub\\server\\src\\mcp.js"]
    }
  }
}
```

## opencode

In `opencode.json`:

```json
{
  "mcp": {
    "memHub": {
      "type": "local",
      "command": ["node", "C:\\Users\\Allen\\not-hentai\\memHub\\server\\src\\mcp.js"]
    }
  }
}
```

Note the backslash escaping: Windows paths in JSON must use `\\` double backslashes.

## Cursor

In `~/.cursor/mcp.json` (standard `mcpServers` shape):

```json
{
  "mcpServers": {
    "memHub": {
      "command": "node",
      "args": ["C:\\Users\\Allen\\not-hentai\\memHub\\server\\src\\mcp.js"]
    }
  }
}
```

## Antigravity / Wing / any MCP client

Any MCP client that configures stdio servers with the standard `mcpServers` shape works the same way:

```json
{
  "mcpServers": {
    "memHub": {
      "command": "node",
      "args": ["C:\\Users\\Allen\\not-hentai\\memHub\\server\\src\\mcp.js"]
    }
  }
}
```

Restart the client after editing its config. If the client cannot find `node` on PATH, use the full path to `node.exe` in `command`/`args`.

## Starting the web UI

```
cd C:\Users\Allen\not-hentai\memHub
npm start
```

Then open `http://127.0.0.1:4777`. The UI reads and writes the same store that every MCP session uses; there is no login and the server binds to localhost only.

## Agent usage pattern (recommended)

1. Session start - call `memhub_recall` with the project/task words: one response carries matched nodes, their notes, and neighbour labels.
2. Discovered facts - save them with `memHub_save_note` (pass your model name as `model`; set `parent` to attach the note to a node), then `memHub_link_nodes` to connect the concepts involved.
3. Decisions - save a note with tags `["decision"]` and link it to the project node.
4. Before big changes - run `memHub_neighborhood` on the project node (2 hops) to check what is connected to what.

## Notes

- Everything is local-only: `127.0.0.1:4777`, no authentication. Do not expose it to the network (no port forwarding, no public reverse proxy).
- Backups: `POST /api/backup`, or `.\client\memHub.ps1 backup` from the `memHub/` folder. Writes an immediate full copy to `server/data/backup-<ISO>.json`.
- The MCP server talks to the store directly, so MCP tools work even when the web server is not running.
