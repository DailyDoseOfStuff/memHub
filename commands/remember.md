---
description: Save a one-line memory into the shared memHub brain
argument-hint: <what to remember> (optional: --parent node:id)
allowed-tools: mcp__memhub__memhub_save_note
---

Save the given text as a note in the shared memory so every agent across sessions and models can recall it.

Run exactly:

```
mcp__memhub__memhub_save_note(text=\"$ARGUMENTS\", model=\"claude-code\", tags=[\"user\"])
```

If the text mentions an existing project, topic or file, try attaching it: first `memhub_find_nodes` on the most distinctive noun, then re-run the save with `parent` set to the best node id. Keep the note distilled (decision/fact/state), never a transcript.
