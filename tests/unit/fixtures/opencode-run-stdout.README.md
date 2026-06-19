# opencode-run-stdout.ndjson — Provenance

Captured from `opencode-ai@1.17.7` via Ollama (openai-compatible, model `qwen3-coder-next`).

Command:
```
opencode run --format json --dangerously-skip-permissions "<prompt>" 2>&1
```

Capture date: 2026-06-18.

## Contents (6 lines)

| # | `type` | Notes |
|---|--------|-------|
| 1 | `step_start` | `part.type: "step-start"` |
| 2 | `tool_use` | `part.tool: "bash"`, `part.state.status: "error"` — a valid envelope sample for a tool call that failed schema validation |
| 3 | `step_finish` | `part.tokens.input: 4096`, `part.tokens.output: 24`, `part.tokens.cache.write: 0`, `part.tokens.cache.read: 0` |
| 4 | `step_start` | `part.type: "step-start"` |
| 5 | `text` | `part.text`: model response text |
| 6 | `step_finish` | `part.tokens.input: 4096`, `part.tokens.output: 110`, `part.tokens.cache.write: 0`, `part.tokens.cache.read: 0` |

## Schema notes

Each line: `{ "type": <t>, "timestamp": N, "sessionID": "…", "part": { … } }`

- `text` events: text content is at `.part.text` (NOT `.content`)
- `tool_use` events: tool name is at `.part.tool` (NOT `.name`); state at `.part.state.status` / `.part.state.input` / `.part.state.error`
- `step_finish` events: no `.result` field; tokens at `.part.tokens.input` / `.part.tokens.output`; cache at `.part.tokens.cache.write` / `.part.tokens.cache.read`
- `step_start` events: no visible content; ignored by parser

The `tool_use` line (line 2) has `state.status=error` — this is a valid sample of an error envelope produced by the bash tool receiving invalid arguments. Note: no top-level `type="error"` line was captured in this run; the error envelope shape for that case is unverified.
