---
name: memhub-protocol
description: Use this skill whenever starting work on a project that lives under the user's project folder, when the user references a "shared memory", "memHub", or asks to remember/recall decisions across agents, or when finishing a session with decisions worth persisting. Teaches the memHub MCP tool protocol and the recall-first workflow.
---

# memHub protocol: shared memory across agents

memHub is the user's shared brain. Claude Code, opencode, Codex, Cursor, and any MCP client all read/write the same memory graph (`server/data/store.json`). Work as one of many writers: do not duplicate what another model already knows.

## Session start: recall FIRST

Before assuming anything about project state, recall:

```
memhub_recall { query: "<project name + topic words>", budget: 1500, session: "<short session id>" }
```

Budget keeps the reply inside a token allowance (rank-ordered fill, near-duplicate notes deduped, truncation marked `...(+N chars)`). Omit `budget` for the full payload when the context window is roomy. The `session` id feeds the token-savings bar (`GET /api/tokens`, shown in the web UI) — pick something stable like the task name.

If the project is not yet in the graph, offer:

```
node tools/import.js <project root>     # then recall again
```

## During work: capture decisions and context

Store things another agent (or the user, tomorrow) will need. Prefer attaching to a node so the 3D universe clusters and provenance ("Origin") stay meaningful:

```
memhub_save_note { text: "<fact/decision>", parent: "<node id>", tags: ["decision"], model: "claude-opus-4-6", session: "<session id if known>" }
```

Create missing concept nodes instead of free-floating notes:

```
memhub_create_node { type: "concept", label: "auth rate limiter" }
memhub_link_nodes { source: "project:myapp", target: "concept:auth-rate-limiter" }
```

Node types: `project`, `file`, `concept`, `person`, `decision`, `session`, `note`. Ids are deterministic (`project:memhub`, `file:c:/…/app.js`), so `memhub_save_note`/`memhub_find_nodes` accepts either an id or plain text ids you can infer from labels.

## Session end: handoff note

Write one handoff note when work leaves anything unfinished:

```
memhub_save_note { text: "<what is done><what is next><landmines>", parent: "project:<slug>", tags: ["handoff"], model: "claude-opus-4-6" }
```

## Do not

- Do not dump chat logs or whole file contents into notes. Notes are distilled decisions, summaries, state — not transcripts.
- Do not restate what the neighborhood already holds; `memhub_neighborhood`/`memhub_get_node` shows current context first.
- Never write secrets/keys into the store.
- The web UI + REST live at http://127.0.0.1:4777 (Docker: `docker compose up -d`). MCP (this one) is stdio and works even when the server is down; hybrid semantic recall needs the server up.
