# Orchestrator delta — experiment runbook

Drives the experiments from `.claude/plans/you-keep-saying-like-deep-journal.md`. The branch + binary are built once; you flip env vars between runs.

## One-time setup

```bash
git fetch
git checkout investigate/orchestrator-delta-experiments
npm run release
```

The launchable binary is:

```
/home/onomojo/Work/sandstorm-desktop/release/sandstorm-desktop-0.1.0-linux.AppImage
```

(Equivalent: `/home/onomojo/Work/sandstorm-desktop/release/linux-unpacked/sandstorm-desktop` — the unpacked variant. Use whichever you prefer.)

Telemetry sink (rows are appended; tagged by `experiment` field):

```
~/.config/sandstorm-desktop/sandstorm-desktop-token-telemetry.jsonl
```

---

## Canonical scenario (paste this exact message every run)

> Take a look at stack 250. We have a stack up and running. I paused it because we have some token issues going on. We're trying to solve. I'm curious what the status of that stack is and whether or not it was finished working. If it's not, let's go ahead and fire up the stack again. We'll start the stack again and resume wherever it left off. We don't want to tear down the stack. We want to pick up where it left off.

---

## Per-run loop

For every experiment below:

1. **Fully quit any running instance** of Sandstorm Desktop first (otherwise the running session keeps its old env vars).
2. Copy-paste the launch command for the experiment into a fresh terminal.
3. Wait for the app window. Open the `project-3` tab.
4. Paste the canonical scenario message above. Hit send.
5. Wait for the response to fully complete (one final assistant message).
6. Quit the app. Tell me **"experiment N done"**.

Between runs you can leave the JSONL alone — each row is tagged with the `experiment` label so I can match them up.

---

## Run order (do them in this order)

### 1. Experiment 1 — current baseline (no env tweaks beyond telemetry)

```bash
SANDSTORM_TOKEN_TELEMETRY=1 \
SANDSTORM_TOKEN_TELEMETRY_EXPERIMENT=exp1-baseline \
"/home/onomojo/Work/sandstorm-desktop/release/sandstorm-desktop-0.1.0-linux.AppImage"
```

Establishes the reproducible baseline against current `main` behavior. Should land near the ~283K / 16-sub-call shape we saw before.

### 2. Experiment 4 — remove the MCP surface (tests your CLI→MCP hypothesis)

```bash
SANDSTORM_TOKEN_TELEMETRY=1 \
SANDSTORM_TOKEN_TELEMETRY_EXPERIMENT=exp4-no-mcp \
SANDSTORM_EXP_NO_MCP=1 \
"/home/onomojo/Work/sandstorm-desktop/release/sandstorm-desktop-0.1.0-linux.AppImage"
```

The Sandstorm MCP tools disappear from the orchestrator's surface entirely. The model has only `Bash, Read, Grep, Glob` plus the existing `SANDSTORM_OUTER.md`. To do stack work it must use the `sandstorm` CLI via Bash.

**The most direct test of "we used to have everything in CLI scripts and moved to MCP."** If sub_turn_count and total tokens both drop, that's the answer.

### 3. Experiment 3 — remove SANDSTORM_OUTER.md (tests your "restrictive philosophy" hypothesis)

```bash
SANDSTORM_TOKEN_TELEMETRY=1 \
SANDSTORM_TOKEN_TELEMETRY_EXPERIMENT=exp3-no-system-prompt \
SANDSTORM_EXP_NO_SYSTEM_PROMPT=1 \
"/home/onomojo/Work/sandstorm-desktop/release/sandstorm-desktop-0.1.0-linux.AppImage"
```

Default Claude Code system prompt loads instead of `SANDSTORM_OUTER.md`. MCP tools still available. If this drops cost dramatically, the "restrictions cause roundabout work" hypothesis is the lever.

### 4. Experiment 2 — re-enable Agent / Task tools

```bash
SANDSTORM_TOKEN_TELEMETRY=1 \
SANDSTORM_TOKEN_TELEMETRY_EXPERIMENT=exp2-agent-enabled \
SANDSTORM_EXP_ENABLE_AGENT=1 \
"/home/onomojo/Work/sandstorm-desktop/release/sandstorm-desktop-0.1.0-linux.AppImage"
```

Adds `Agent` + all `Task*` tools to the allowlist so the orchestrator can delegate analysis to in-process sub-agents (the way fresh Claude Code naturally does). Everything else stays the same.

### 5. Experiment 5 — strip it all (the "be normal Claude Code with sandstorm CLI" run)

```bash
SANDSTORM_TOKEN_TELEMETRY=1 \
SANDSTORM_TOKEN_TELEMETRY_EXPERIMENT=exp5-strip-all \
SANDSTORM_EXP_ENABLE_AGENT=1 \
SANDSTORM_EXP_NO_SYSTEM_PROMPT=1 \
SANDSTORM_EXP_NO_MCP=1 \
"/home/onomojo/Work/sandstorm-desktop/release/sandstorm-desktop-0.1.0-linux.AppImage"
```

No SANDSTORM_OUTER.md, no MCP, expanded allowlist with Agent + Task. The closest thing to "fresh Claude Code, but it lives inside the Electron app." If this is comparable to the fresh-claude baseline (Experiment 6), the bespoke orchestrator concept may be replaceable wholesale by a thin wrapper.

### 6. Experiment 7 — Experiment 5 plus memory / CLAUDE.md austerity

Two extra commands before launching, two after — they swap your project context files aside, then restore them.

**Before launch:**

```bash
mv /home/onomojo/Work/sandstorm-desktop/CLAUDE.md \
   /home/onomojo/Work/sandstorm-desktop/CLAUDE.md.bak
mv ~/.claude/projects/-home-onomojo-Work-sandstorm-desktop/memory \
   ~/.claude/projects/-home-onomojo-Work-sandstorm-desktop/memory.bak
```

**Launch:**

```bash
SANDSTORM_TOKEN_TELEMETRY=1 \
SANDSTORM_TOKEN_TELEMETRY_EXPERIMENT=exp7-austerity \
SANDSTORM_EXP_ENABLE_AGENT=1 \
SANDSTORM_EXP_NO_SYSTEM_PROMPT=1 \
SANDSTORM_EXP_NO_MCP=1 \
"/home/onomojo/Work/sandstorm-desktop/release/sandstorm-desktop-0.1.0-linux.AppImage"
```

**After the run, restore (don't skip — your memory is in the .bak path):**

```bash
mv /home/onomojo/Work/sandstorm-desktop/CLAUDE.md.bak \
   /home/onomojo/Work/sandstorm-desktop/CLAUDE.md
mv ~/.claude/projects/-home-onomojo-Work-sandstorm-desktop/memory.bak \
   ~/.claude/projects/-home-onomojo-Work-sandstorm-desktop/memory
```

---

## Experiment 6 — Fresh Claude Code (I run this, no user action)

External baseline via a raw `claude -p` subprocess against the project, parsing the stream-json `type:"result"` usage block. I'll do this in parallel with your runs and merge the result into the analysis table.

---

## Raw API-request capture (#299)

When telemetry is not enough — you want to see exactly what bytes the CLI is sending to `api.anthropic.com` — set this env var on the app launch:

```bash
SANDSTORM_RAW_REQUEST_CAPTURE=1 \
"/home/onomojo/Work/sandstorm-desktop/release/sandstorm-desktop-0.1.0-linux.AppImage"
```

A localhost HTTP proxy is stood up per tab; the child `claude` process is pointed at it via `ANTHROPIC_BASE_URL`. Every outbound request body is dumped (headers redacted) under:

```
~/.config/sandstorm-desktop/raw-api-capture/<sessionStartIso>/
```

Analyze with:

```bash
node scripts/analyze-raw-capture.mjs \
  ~/.config/sandstorm-desktop/raw-api-capture/<sessionStartIso>
```

The script prints a per-request summary table, a system-prompt composition breakdown (with the skill-catalog system-reminder flagged explicitly), tool-schema inventory, and net byte deltas between adjacent requests. Clean up the capture dir manually after — no rotation.
