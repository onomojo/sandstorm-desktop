---
name: check-and-resume-stack
description: "Use this skill whenever the user asks to CHECK the status of an existing stack AND optionally RESUME it if it's not finished. Trigger phrases include: 'check stack N', 'is stack N done', 'what's the status of stack N', 'is N finished', 'pick up where N left off', 'resume stack N', 'we paused stack N can you continue', 'take a look at stack N and if it's not done start it again'. The skill is for EXISTING stacks the user names explicitly by ID — not for new stack creation. Prefer this skill over the generic sandstorm skill whenever the user's intent is a status-check-then-maybe-resume pattern on one named stack; this skill collapses what would otherwise be 10+ MCP calls into 1–2. Do NOT trigger for: creating new stacks, dispatching new work, reviewing diffs on demand, tearing down stacks, or listing multiple stacks."
---

# /check-and-resume-stack

**Purpose:** one-shot "check on stack N, and if it hasn't finished, resume it from where it left off." Collapses the redundant 10+ investigation calls the orchestrator otherwise makes into a minimum viable sequence.

## Input signal

The user has named a specific stack ID (e.g. `250`, `homepage-launch`) and wants:
- Its current status
- If it's not finished AND they asked to resume: pick up where it left off

Extract the stack ID from the user's message. If you don't see an ID anywhere in the message, ask the user for it — do NOT call `list_stacks` to guess.

## The minimum viable sequence

Call tools in this order. Do not skip steps, do not add extra steps.

1. **`mcp__sandstorm-tools__get_task_status({ stackId: "<id>" })`** — first try with the literal ID from the user's message.

   - **If it returns a valid status**, go to step 2.
   - **If it returns not-found / unknown-stack**, the user may have typed a partial ID (e.g. `250` meaning `250-scheduled-automation`). Allow exactly ONE recovery call: `mcp__sandstorm-tools__list_stacks()`. Look for a stack whose name *starts with* or *contains* the user's ID. If exactly one match, retry `get_task_status` with the matched ID and continue. If zero or multiple matches, tell the user what you found and ask them to disambiguate. Do NOT guess — and do NOT exceed one `list_stacks` call.

2. **Interpret the status once.** Based on the returned state:

   | State | Action |
   |-------|--------|
   | `running` | Report "still running" with whatever progress info was in the status. Stop. Do NOT poll. |
   | `completed` | Report "completed successfully". Stop. Do NOT call `get_diff` unless the user asked to see changes. |
   | `failed` | Report the failure reason. Ask the user before resuming. Stop. |
   | `idle` or `paused` | If the user's message asked to resume, proceed to step 3. Otherwise report state and stop. |

3. **Resume only if requested.** One call:
   `mcp__sandstorm-tools__dispatch_task({ stackId: "<id>", prompt: "Continue from where you left off. Do not redo completed work. Pick up the next unfinished step." })`

4. **Report back to the user** — one concise summary, no multi-paragraph narration.

## Hard rules — these are the consolidation

- **At most ONE `list_stacks` call**, used only as a recovery step after `get_task_status` returned not-found. Never upfront.
- **At most TWO `get_task_status` calls** total: the literal-ID attempt, plus an optional retry with the resolved ID after a `list_stacks` recovery. No status polling.
- **NEVER call `get_task_output`, `get_logs`, or `get_diff`** unless the user explicitly asked for output / logs / changes.
- **NEVER shell out** with Bash to probe container state. The status call covers it.
- **NEVER run the spec quality gate** on resume — the user is continuing existing work, not dispatching a new ticket.
- **NEVER tear down the stack.** Ever. Including on failure. Including if containers exited. Resume means resume.
- **NEVER pre-create** a new stack if the named ID doesn't exist. Tell the user it doesn't exist and stop.

## What "collapsed" means

Baseline for the canonical "check-and-resume" scenario was 11 tool calls across 22 internal API rounds (get_task_status, list_stacks, get_task_status, get_task_output, get_diff, get_logs, Bash, dispatch_task, Bash, Bash, dispatch_task). Using this skill, the expected shape is:

- 1× `Skill` tool call (the invocation of this skill)
- 1× `get_task_status` with the literal ID (happy path)
- 0–1× `list_stacks` (only if the literal ID didn't resolve — a prefix/partial match recovery)
- 0–1× second `get_task_status` with the resolved ID (only after a `list_stacks` recovery)
- 0–1× `dispatch_task` (only if resume is called for)

Happy-path total: 2 tool calls. Recovery-path total: 4 tool calls + resume = 5. Baseline was 11. Either way, no `get_task_output`, no `get_logs`, no `get_diff`, no `Bash`.

If you find yourself reaching for a second status check or a `get_diff` the user didn't ask for, stop — that's the old behavior this skill exists to replace.
