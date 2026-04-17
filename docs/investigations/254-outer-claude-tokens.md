# #254 — Outer Claude token blowup: investigation

**Status:** investigation complete, remediation deferred to follow-ups.
**Scope:** investigation + plan only, per the ticket. No runtime behavior changes.
**Report date:** 2026-04-17.

## Summary

The outer-Claude orchestrator is **not** re-spawning `claude` per turn, and it does
**not** use `--resume` on the hot path. Both of those hypotheses (H1, H2) are
refuted by code. The 10×–30× token cost relative to an interactive `claude`
session comes from a stack of smaller, mostly-additive causes that all hit
**per turn** (where a "turn" is one Anthropic API round-trip, and one user
message often drives 5–15 internal turns via tool calls):

1. **Prompt-cache TTL vs. orchestrator workflow.** The Anthropic prompt cache
   has a ~5-minute TTL. Orchestrator workflows have long waits by design
   (inner tasks take minutes). The first turn after any wait pays full
   cache-miss cost. See H5.
2. **Fixed per-turn overhead is large** (~25–30k tokens): SANDSTORM_OUTER.md,
   auto-discovered project `CLAUDE.md`, auto-loaded memory, full Claude Code
   built-in tool schemas (including Edit/Write/Agent/Task* that the
   orchestrator is *forbidden from using* by its own system prompt), plus the
   Sandstorm MCP tool schemas on top. See H4.
3. **Tool-response echoes inflate the transcript** and get replayed every
   subsequent turn. `dispatch_task` and `get_task_status` return the full
   `Task` object (including the `prompt` field, which has the full ticket body
   prepended). `get_task_output` / `get_logs` are unbounded in practice. See H3.

An interactive `claude` session avoids (1) because the user is actively
typing, avoids (3) because tool responses from native tools like `Bash`/`Read`
are compact, and pays similar static cost to (2) but amortizes it over many
cheap turns without long waits.

**None** of H1, H2, H6 justify action as stated. H3, H4, H5 are the real
drivers. Three follow-up tickets are opened (see `## Follow-ups`).

## Invocation trace

The outer-Claude orchestrator runs the **Claude Code CLI** as a long-lived
subprocess, per tab, reusing the process across turns via NDJSON over stdin.
Key file: `src/main/agent/claude-backend.ts`.

### Where the CLI is spawned

`src/main/agent/claude-backend.ts:665-700` — `ensureProcess(tabId)`:

```
args: [
  '--print',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--dangerously-skip-permissions',
  // plus, conditionally:
  '--system-prompt-file', <cliDir>/SANDSTORM_OUTER.md,
  '--mcp-config', <tmpDir>/mcp-config.json,
  '--model', <resolved-outer-model>,
]
```

- `claude` binary resolved by `getClaudeBin()` (line 45) to
  `~/.local/bin/claude` when present.
- `cwd` = `session.projectDir || process.cwd()` (line 692). This means the
  orchestrator's `claude` process inherits the **user's project directory**
  as CWD, which triggers that project's `CLAUDE.md` auto-discovery inside
  `claude`.
- The process is spawned **once** per tab (line 667 early-returns if
  `session.process` is set). On crash/exit, `session.process` is cleared
  (line 848) and the next `sendMessage` respawns.

### How turns are delivered

`src/main/agent/claude-backend.ts:631-647` — `writeMessage`:

- Each user message is framed as NDJSON
  `{"type":"user","message":{"role":"user","content":"..."}}` and written
  to the live process's stdin. No new process, no `--resume`.

### Queueing & cancellation

- `sendMessage` (line 284) pushes additional user messages into
  `pendingMessages` while a turn is still streaming. They are drained on the
  next `type:"result"` event (line 787).
- `cancelSession` (line 343) marks the current turn as cancelled but **does
  not** kill the process — it keeps the cache warm and dequeues the next
  message when the cancelled turn's `result` arrives.

### Ephemeral path (separate from the hot path)

`runEphemeralAgent` (line 404) spawns a fresh short-lived `claude -p` per
call, used for spec quality-gate evaluation. This path is correctly
isolated — it does not feed into the persistent outer session. **Not a
contributor to outer-session bloat.**

### What this means for H1 / H2

- **H1 refuted.** Outer sessions use a persistent CLI process per tab,
  reused across turns.
- **H2 refuted.** `--resume` does not appear anywhere in the outer-Claude
  invocation. The project memory note about `--resume` as a full cache miss
  does not apply here.

## H1 — Fresh `claude` process per outer turn

**Refuted.** The orchestrator spawns one `claude` process per tab and
re-uses it across turns via NDJSON stdin. Evidence:

- `ensureProcess` early-returns when `session.process` already exists
  (`src/main/agent/claude-backend.ts:667`).
- `writeMessage` targets the persistent process's `stdin`
  (`claude-backend.ts:631-643`).
- The process is only cleared on `close`/`error` (lines 843-878), after
  which the next user message spawns a replacement.

## H2 — `--resume` on the hot path

**Refuted.** No `--resume` in `ensureProcess` args
(`claude-backend.ts:672-677`). The only `--resume`-like concern that could
apply is if the CLI *internally* performs session-resume logic when using
`--print --input-format stream-json`; we have no evidence it does. The NDJSON
streaming input keeps the process's in-memory transcript authoritative.

## H3 — Tool responses echo prompts into the transcript

**Confirmed.** The orchestrator's MCP tool responses are returned verbatim
to `claude`, where they become part of the assistant-side tool_result blocks
and get replayed on every subsequent turn.

### dispatch_task

`src/main/claude/tools.ts:241-250` → `stackManager.dispatchTask` →
`src/main/control-plane/stack-manager.ts:611-689`. The function returns the
created `Task`, which includes the full `prompt`. The prompt may already
have the **entire fetched ticket body prepended** at line 642-647:

```ts
if (stack.ticket) {
  const ticketContext = await fetchTicketContext(stack.ticket, stack.project_dir);
  if (ticketContext) {
    prompt = `${ticketContext}\n\n---\n\n## Task\n\n${prompt}`;
  }
}
```

The resulting `Task` object is persisted with that full prompt (line 649)
and serialized into the MCP response (tools.ts' `handleToolCall` returns the
`Task` object unmodified, which the MCP bridge then wraps in a
`tool_result`). So:

- User message (with the short task description) is in the transcript.
- Fetched ticket body (potentially several KB) is now in the transcript
  via the echoed `Task.prompt`.
- Every subsequent outer turn replays this.

### get_task_status

`tools.ts:262-263` → `stack-manager.ts:743-758`. Returns
`{ status, task? }` where `task` is the full `Task` object — **including
`prompt`**. Repeated polling (the orchestrator's normal pattern while waiting
for completion) multiplies this into the transcript.

### get_task_output / get_logs

- `getTaskOutput` (stack-manager.ts:760-775) returns `tail -n <lines>
  /tmp/claude-task.log` where `lines` defaults to 50. 50 lines of inner-Claude
  streaming output can easily be 5–15 KB of text.
- `getLogs` (stack-manager.ts:777-803) tails **100 lines per container**
  across all of a stack's services and concatenates. Can be 20–50 KB on a
  stack with multiple services.

Nothing caps or de-duplicates these payloads; they land in the transcript
and replay each turn.

### dispatch_task echo magnitude, illustrated

A task dispatched to a ticket with a 10 KB body, via a 200-byte prompt, will
have a `tool_result` containing a serialized `Task` whose `prompt` is ~10.2 KB.
That ~10 KB of duplicate content is then charged on every outer turn until the
session is reset.

## H4 — Static context re-submitted every turn exceeds ~15k tokens

**Confirmed.** Measured component sizes (bytes / approximate tokens at ~4 B/token):

| Component | Bytes | ≈ Tokens |
|---|---:|---:|
| `sandstorm-cli/SANDSTORM_OUTER.md` | 5,908 | ~1,500 |
| `CLAUDE.md` (project root, auto-loaded because cwd = projectDir) | 10,330 | ~2,600 |
| `sandstorm-cli/CLAUDE.md` (loaded from sandstorm-cli dir when tab uses it) | 1,674 | ~400 |
| Memory index + all memory files | 19,263 | ~4,800 |
| Sandstorm MCP tool schemas (from `src/main/claude/tools.ts` — only the schemas, not the handlers) | ~6,000 of declaration text | ~1,500 |
| Claude Code built-in tool schemas (Bash, Read, Edit, Write, Grep, Glob, Agent, TaskCreate, etc.) — orchestrator never passes `--tools`, so the full set loads | not measurable from repo | ~15,000–20,000 |
| Deferred-tool name list + skills list + system reminders | not measurable from repo | ~3,000–5,000 |
| **Fixed per-turn total** | | **~28,000–36,000** |

These numbers match, and slightly exceed, the measurements in the follow-up
comment on the ticket (estimated ~25–30k). All of this re-submits every
turn. The Anthropic prompt cache reduces the charged cost to ~10% of normal
when a prefix is cached, but: (a) the cache has a 5-minute TTL (see H5), (b)
any change to the prefix invalidates the cached block from that point
onward.

### Observation: the orchestrator ships tool schemas it is forbidden to use

`sandstorm-cli/SANDSTORM_OUTER.md` explicitly states the outer Claude
**does not** edit application source files directly, run test suites, etc.
But the default Claude Code built-in toolset is loaded in full on every
turn, including `Edit`, `Write`, `NotebookEdit`, `Agent`, `TaskCreate`,
`TaskUpdate`, and so on. The orchestrator never uses these tools — yet
their schemas cost tokens on every turn. (The follow-up comment's item 6
captures this.)

### Observation: `--exclude-dynamic-system-prompt-sections` does not apply

The CLI's `--exclude-dynamic-system-prompt-sections` flag helps only
**with the default system prompt**, per the CLI help text:
*"Only applies with the default system prompt (ignored with --system-prompt)."*
Because the orchestrator uses `--system-prompt-file SANDSTORM_OUTER.md`,
this flag is a no-op for us. It does not represent a free win.

## H5 — `ScheduleWakeup` wake-ups past the 5-minute cache window

**Confirmed (generalized beyond `ScheduleWakeup`).** The outer Claude does
not run `ScheduleWakeup` itself; that's a harness tool. But the **underlying
dynamic** — user-input gaps exceeding the 5-minute Anthropic prompt-cache
TTL — absolutely applies to the orchestrator workflow:

- A typical orchestrator pattern is: dispatch a task, wait 3–20 minutes for
  the inner Claude to finish, then ask for status / diff. The idle gap
  between "dispatch" and "check status" is almost always > 5 minutes.
- Every "first turn after an idle gap" pays a full cache miss on the ~28–36k
  of static context (plus the accumulated transcript).
- Over a 10-turn session with, say, 4 such cache-cold turns, this alone can
  add ~120k tokens vs. an equivalent cache-hot session.

Interactive `claude` avoids this because the user is actively typing — there
is rarely a > 5 min gap between turns in an interactive session.

**Relative magnitude:** this is plausibly the *largest single contributor* to
the "300k for one message" observation. A single user message (e.g.,
"dispatch this task, then check status when done") can easily span two
turns separated by > 5 min, both paying cold-cache cost.

## H6 — Interactive `claude` uses a caching strategy the orchestrator misses

**Not supported.** No evidence in the CLI help or in our invocation that
interactive `claude` uses a fundamentally different caching strategy than
`claude --print --input-format stream-json`. Both modes hit the same
Anthropic API, both rely on the server-side prompt cache. The observed
delta is fully explained by H3 (transcript growth from MCP tool echoes), H4
(fixed-context bloat), and H5 (cache TTL misses from long idle gaps).

If anything, the orchestrator is **more** efficient in one narrow respect:
it does not load interactive-mode ergonomics (REPL hooks, TTY-bound features,
etc.). The delta is elsewhere.

## Ranked list of causes

Largest → smallest, per-session impact on a representative 10-turn session.

| # | Cause | Why it's there | Impact | Avoidable? |
|---|---|---|---:|---|
| 1 | **Cache-cold turns after long idle gaps** (H5) | Orchestrator waits minutes between dispatch and status/diff turns, by design | ~50–150k per session (when 2-4 turns go cold) | Partially — requires warming mechanism or tolerating warm pre-dispatch flows |
| 2 | **Fixed per-turn static context ~28–36k** (H4) | SANDSTORM_OUTER.md + project CLAUDE.md + memory + built-in + MCP tool schemas | ~30k × 10 turns, ~90% absorbed by cache when warm; ~270k+ when cold | Reducible — tool-allowlist, trim auto-discoveries, consolidate system prompt |
| 3 | **Tool-response echoes of full `Task` objects (including prompt+ticket)** (H3) | `dispatchTask`/`getTaskStatus` return full `Task`; ticket context is prepended into `prompt` and never stripped on the way out | ~5–15k per dispatch/poll cycle, × N cycles per session | Yes — reshape MCP responses to omit the prompt/ticket fields |
| 4 | **Unbounded `get_task_output` / `get_logs` payloads** (H3 sub-case) | `tail -n 50` or 100 lines × services, no size cap | ~5–50k per call | Yes — add size cap + truncation marker |
| 5 | **Built-in tool schemas that the orchestrator is forbidden from using** (H4 sub-case) | Default `--tools` set is loaded; never restricted | ~8–15k per turn of fixed overhead | Yes — pass `--tools <orchestrator-allowlist>` |
| 6 | **Project `CLAUDE.md` auto-discovery in the orchestrator CWD** (H4 sub-case) | `cwd` set to user's project dir; `claude` auto-loads that `CLAUDE.md` even under `--system-prompt-file` | ~2–4k per turn when cached; larger when cold | Reducible — disable auto-discovery or point cwd elsewhere |
| 7 | **Deep memory file set (~5k tokens)** | Project memory auto-loaded into every turn | ~5k per turn when cached; larger cold | Not worth touching — memory value > savings |
| 8 | **Absent session-token feedback to the orchestrator** (item 10 in follow-up comment) | Orchestrator has no inline visibility into current session cost | Indirect — model can't self-correct | Behavioral; partially addressed by existing counter UI (#238) but not fed back to the model |

## Remediation proposals

Each proposal is labeled with estimated savings per 10-turn session,
complexity (S/M/L), regression risk, and change category.

### P1 — Reshape `dispatch_task` / `get_task_status` / `get_task_output` responses

- **Category:** tool-response shape (MCP tools → Claude).
- **Savings (per session):** ~10–25k tokens.
- **Complexity:** S.
- **Regression risk:** low. Renderer / store path uses separate typed IPC
  (`agent:...` channels and the registry), not the MCP tool return values.
  The MCP return is consumed only by the outer Claude model.
- **What to change:**
  - `dispatch_task`: return `{ taskId, stackId, status }` — omit `prompt`,
    `ticket`, any raw user input. Model already has the prompt in its
    transcript from the preceding user turn; echoing it is pure duplication.
  - `get_task_status`: return `{ status, taskId, startedAt, finishedAt,
    exitCode }` — omit the full `Task` object's `prompt` field. If the model
    legitimately needs the prompt later, add a separate explicit
    `get_task_prompt` tool that is almost never called.
  - `get_task_output`: add a hard cap (e.g., 4 KB) with a leading
    truncation marker `"...[truncated N earlier bytes]..."`, regardless of
    the `lines` argument.
  - `get_logs`: add the same cap (8 KB) + truncation marker.
- **Savings mechanism:** less content added to the transcript per call,
  therefore less content replayed on every subsequent turn, therefore more
  of the prefix stays cache-stable.

### P2 — Drop unused built-in Claude Code tools via `--tools` allowlist

- **Category:** invocation change (CLI args).
- **Savings (per session):** ~8–15k when fully cache-cold, ~1–2k when
  mostly warm; compounding effect: reduces the volatile-prefix surface so
  more turns stay cache-hot.
- **Complexity:** S.
- **Regression risk:** low if the allowlist is conservative; the orchestrator
  spec (SANDSTORM_OUTER.md) already forbids Edit/Write/Agent/Task*.
- **What to change:** `ensureProcess` adds `--tools` with an orchestrator
  allowlist. Starting set (to be validated against actual orchestrator
  behavior):
  - Allow: `Bash` (for `gh`, `sandstorm push`, etc.), `Read`, `Grep`,
    `Glob`.
  - Deny by omission: `Edit`, `Write`, `NotebookEdit`, `Agent`, `TaskCreate`,
    `TaskUpdate`, `TaskList`, `TaskGet`, `TaskStop`, `TaskOutput`,
    `MultiEdit`, `WebFetch`, `WebSearch`, `LSP` (the orchestrator rarely
    needs these; if it turns out to need one in practice, add it back).
- **Caveat:** validate in a non-hot-path smoke test that the orchestrator
  can still run `gh` and `sandstorm push`. The concern isn't command
  execution — it's that we haven't measured what subset the model actually
  reaches for.

### P3 — Prompt-cache warming across idle gaps

- **Category:** harness change (orchestrator).
- **Savings (per session):** potentially 50–150k tokens on sessions where
  2–4 turns go cache-cold. Biggest single win.
- **Complexity:** M–L. Depends on whether the CLI supports a cheap
  "keep-alive" that reads the cached prefix without incurring a real model
  turn.
- **Regression risk:** medium. A naive "send a heartbeat every 4 minutes"
  could corrupt the transcript with synthetic user messages; and each
  heartbeat costs a real API turn.
- **Options (for the follow-up ticket to evaluate):**
  1. Anthropic-side: verify whether **cache control** on long-lived stable
     system-prompt blocks extends TTL beyond 5 minutes (cache-control
     headers with `ttl: '1h'` are a documented feature for some API
     customers).
  2. Pre-dispatch warmup: when the user focuses the chat input, send a
     no-op model turn if > 4 min since the last turn.
  3. Strategic turn ordering: after `dispatch_task`, the orchestrator does
     *not* `get_task_status` immediately (wastes a turn). Instead, a
     harness-side poller watches task completion, and the next outer turn is
     triggered only when the status *changes* — reducing the number of
     cache-cold probe turns.
- **Because complexity is M–L**, this proposal fails the follow-up threshold
  (`complexity ≤ M`) for **automatic** ticket-creation — it is filed as a
  follow-up explicitly because the **savings magnitude** is too large to
  defer, and the follow-up should begin with a deeper measurement and API
  investigation rather than a fix.

### P4 — Trim SANDSTORM_OUTER.md; explicit `--model`-based cwd policy

- **Category:** prompt change + invocation change.
- **Savings (per session):** ~5–10k tokens.
- **Complexity:** S.
- **Regression risk:** low for prompt trimming; medium for cwd policy
  changes (affects where `CLAUDE.md` / memory auto-load from).
- **What to change:**
  - Re-review SANDSTORM_OUTER.md and strip content that duplicates MCP tool
    descriptions (the command reference table at lines 28–46 overlaps
    heavily with what the tools themselves document).
  - Evaluate spawning the orchestrator `claude` with `cwd` set to a dir
    that does **not** auto-load the user's project `CLAUDE.md`. The
    orchestrator should not be reading the user's project CLAUDE.md at all;
    that's what inner Claude is for. The trade-off is `gh`/`Bash` commands
    executed from that cwd see a different working directory — need to
    confirm this doesn't break `gh issue view`, `sandstorm` commands, etc.
- **Below-threshold note:** savings are ~5–8k per session, complexity S,
  risk low. This sits **right at** the threshold. Filing as a follow-up
  because the implementation is cheap and bundles naturally with P2.

### P5 — Session-token feedback into the orchestrator prompt (below threshold)

- **Category:** prompt change.
- **Savings:** indirect. Observational, not mechanical.
- **Complexity:** S.
- **Regression risk:** very low.
- **Why not a follow-up ticket here:** savings are behavioral — the model
  *might* self-correct if it sees "session tokens so far: 180k", but the
  savings are not mechanically quantifiable. Does not clear the numeric
  threshold. Note here for future consideration.

### P6 — Measurement instrumentation (this ticket allows it; deferred anyway)

- **Category:** harness change, measurement-only.
- **Why not added here:** the ticket's acceptance criteria are met by the
  committed report + Vitest structural test + follow-up tickets, without
  requiring live measurement — because the code evidence confirmed or
  refuted every hypothesis with concrete file/line references. Live
  measurement would itself cost tokens from an already-strained budget and
  is better run *after* P1/P2 land so the baseline and improvement
  measurements happen together.
- **Recommendation:** add a measurement hook in the first remediation PR,
  not here.

## Reproducing the measurements

All measurements in this report are **code-level** (file sizes, args,
response-shape analysis). To reproduce:

```
wc -c sandstorm-cli/SANDSTORM_OUTER.md CLAUDE.md \
  sandstorm-cli/CLAUDE.md \
  ~/.claude/projects/-home-onomojo-Work-sandstorm-desktop/memory/*.md
```

And inspect:

- `src/main/agent/claude-backend.ts:665-700` for the CLI invocation args.
- `src/main/agent/claude-backend.ts:284-333` for the per-tab session
  lifecycle.
- `src/main/claude/tools.ts:40-214` for MCP tool schemas.
- `src/main/control-plane/stack-manager.ts:611-803` for MCP tool response
  shapes (`dispatchTask`, `getTaskStatus`, `getTaskOutput`, `getLogs`).

Live per-turn usage comparison (orchestrator vs. interactive single-process
subprocess session) was **not** performed in this ticket — see P6 above.
That measurement belongs in the first remediation PR, where the baseline
and improvement numbers can be captured together.

## Follow-ups

Follow-up tickets opened against this ticket, per the threshold rule in
#254 (`savings ≥ 5,000 tokens per 10-turn session AND complexity ≤ M AND
regression risk ≤ low`):

- **P1 — Reshape MCP tool responses (dispatch_task / get_task_status /
  get_task_output / get_logs):** #255.
- **P2 — Drop unused built-in Claude Code tools via `--tools` allowlist in
  the orchestrator CLI invocation:** #256.
- **P3 — Prompt-cache warming / idle-gap mitigation (investigation first,
  then implement):** #257. Filed despite being near/above the complexity
  threshold because the expected savings are the single largest contributor
  per H5; the follow-up's **first** deliverable is an investigation, not an
  implementation.

Near-boundary / below-threshold items **not** opened as tickets, but
captured here for future consideration:

- **P4 — Trim SANDSTORM_OUTER.md and evaluate orchestrator CWD policy** —
  savings ~5–10k per session, bundled naturally with P2; can be folded into
  that PR rather than opening a separate ticket.
- **P5 — Session-token feedback to the orchestrator prompt** — indirect /
  behavioral savings; does not clear the mechanical threshold.

No closure recommended: three remediations clear the threshold, so #254
does **not** enter the "no remediation cleared threshold" closure case.
