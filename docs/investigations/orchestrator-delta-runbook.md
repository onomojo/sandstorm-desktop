# Orchestrator delta — experiment runbook

Drives the experiments from `.claude/plans/you-keep-saying-like-deep-journal.md`. Build this branch **once**, then flip env vars between runs. Rebuild only if you change code.

## Prerequisite

```bash
git fetch origin
git checkout investigate/orchestrator-delta-experiments
npm run build
```

The Electron app now honors four env vars (all default-off):

| env var | effect |
|---|---|
| `SANDSTORM_TOKEN_TELEMETRY=1` | enables JSONL telemetry sink |
| `SANDSTORM_TOKEN_TELEMETRY_EXPERIMENT=<label>` | tags every row with the given label so runs are groupable |
| `SANDSTORM_EXP_ENABLE_AGENT=1` | expands the `--tools` allowlist to include `Agent` and all `Task*` tools |
| `SANDSTORM_EXP_NO_SYSTEM_PROMPT=1` | skips passing `--system-prompt-file` (default Claude Code system prompt loads instead) |
| `SANDSTORM_EXP_NO_MCP=1` | skips passing `--mcp-config` (Sandstorm MCP tools disappear) |

**Canonical scenario (send exactly this message each run):**

> Take a look at stack 250. We have a stack up and running. I paused it because we have some token issues going on. We're trying to solve. I'm curious what the status of that stack is and whether or not it was finished working. If it's not, let's go ahead and fire up the stack again. We'll start the stack again and resume wherever it left off. We don't want to tear down the stack. We want to pick up where it left off.

Telemetry file: `~/.config/sandstorm-desktop/sandstorm-desktop-token-telemetry.jsonl` — lines are appended; the latest is what you want.

---

## Per-experiment launch commands

### Experiment 1 — Current baseline

```bash
SANDSTORM_TOKEN_TELEMETRY=1 \
SANDSTORM_TOKEN_TELEMETRY_EXPERIMENT=exp1-baseline \
./path/to/sandstorm-desktop
```

### Experiment 2 — Re-enable Agent/Task (tests H-A)

```bash
SANDSTORM_TOKEN_TELEMETRY=1 \
SANDSTORM_TOKEN_TELEMETRY_EXPERIMENT=exp2-agent-enabled \
SANDSTORM_EXP_ENABLE_AGENT=1 \
./path/to/sandstorm-desktop
```

### Experiment 3 — Remove SANDSTORM_OUTER.md (tests H-C)

```bash
SANDSTORM_TOKEN_TELEMETRY=1 \
SANDSTORM_TOKEN_TELEMETRY_EXPERIMENT=exp3-no-system-prompt \
SANDSTORM_EXP_NO_SYSTEM_PROMPT=1 \
./path/to/sandstorm-desktop
```

### Experiment 4 — Remove MCP surface (tests H-B, **priority**)

```bash
SANDSTORM_TOKEN_TELEMETRY=1 \
SANDSTORM_TOKEN_TELEMETRY_EXPERIMENT=exp4-no-mcp \
SANDSTORM_EXP_NO_MCP=1 \
./path/to/sandstorm-desktop
```

### Experiment 5 — Strip it all

```bash
SANDSTORM_TOKEN_TELEMETRY=1 \
SANDSTORM_TOKEN_TELEMETRY_EXPERIMENT=exp5-strip-all \
SANDSTORM_EXP_ENABLE_AGENT=1 \
SANDSTORM_EXP_NO_SYSTEM_PROMPT=1 \
SANDSTORM_EXP_NO_MCP=1 \
./path/to/sandstorm-desktop
```

### Experiment 7 — Memory / CLAUDE.md austerity

Same env vars as Experiment 5. Before launching, move the context files aside:

```bash
mv CLAUDE.md CLAUDE.md.bak
mv ~/.claude/projects/-home-onomojo-Work-sandstorm-desktop/memory \
   ~/.claude/projects/-home-onomojo-Work-sandstorm-desktop/memory.bak

# Run the app as in Experiment 5 (but with EXPERIMENT=exp7-austerity)

# Restore after
mv CLAUDE.md.bak CLAUDE.md
mv ~/.claude/projects/-home-onomojo-Work-sandstorm-desktop/memory.bak \
   ~/.claude/projects/-home-onomojo-Work-sandstorm-desktop/memory
```

---

## Per-run procedure

1. Launch the app with the env vars for the experiment you're running (above).
2. Open the project-3 tab.
3. Paste the canonical scenario message. Hit send.
4. Wait for the response.
5. Close the app (or just switch to a new shell) — the new row is already in the JSONL.
6. Tell me the experiment finished; I'll read the JSONL and compute the deltas.

Expected user time per experiment: ~2 minutes. Most of that is waiting for the orchestrator to finish its tool chain.

---

## Experiment 6 — Fresh Claude Code (I run this, no user action)

External baseline via a raw `claude -p` subprocess in the project directory, parsing the stream-json `type:"result"` usage block. Output lands in `docs/investigations/orchestrator-delta-exp6.json` for comparison.
