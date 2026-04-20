# Why the stack-250 failure diagnostic cost 1.4M tokens

## Session identified

Telemetry record at `2026-04-20T14:38:29Z` in `~/.config/sandstorm-desktop/sandstorm-desktop-token-telemetry.jsonl`. User turn: "it looks like stack 250 failed, can you take a look and see what you find?" Orchestrator produced a correct, well-structured root-cause analysis (the content is not the problem). The cost:

| Metric | Value |
|---|---|
| Total tokens | **1,395,066** (the user said "1.5M"; the precise number is 1.395M) |
| `cache_read_input_tokens` | 1,286,535 (**92%** of total) |
| `cache_creation_input_tokens` | 92,362 |
| `output_tokens` | 16,137 (1% of total) |
| `input_tokens` (fresh) | 32 |
| Sub-turn count | **47** |
| Tool calls | **31** |

## The single dominant pattern

**Every one of the 31 tool calls was `Bash`.** Zero `Skill`. Zero `Read`. Zero `Grep`. Zero `Task`/`Agent`. Pure Bash-driven exploration.

```
tool invocation histogram:
   31  Bash
```

For reference, the canonical scenario under our current (post-migration) setup:

| Session | Total tokens | Sub-turns | Tool calls | Tools used |
|---|---:|---:|---:|---|
| Canonical resume (working) | 95K | 4 | 2 | `Skill` |
| **This diagnostic** | **1,395K** | **47** | **31** | **only `Bash`** |

The diagnostic burned **~15× the cost** and **~12× the sub-turns** of the optimized canonical scenario. Same orchestrator, same skill set available. The difference: *this intent doesn't map to any skill, so the model fell back to Bash exploration.*

## Why Bash = expensive here, specifically

The diagnostic exploration read 103 KB of tool output across 31 Bash calls. The top 4 calls alone:

```
23.3 KB  # probably a full verdict file or execution log
16.4 KB
10.7 KB
10.4 KB
 6.1 KB
 5.7 KB
 5.2 KB
 ...
```

Each of those tool outputs enters the conversation context. Every subsequent sub-turn reads the cumulative prefix back (`cache_read_input_tokens`). With 47 sub-turns and a prefix that grew to ~27 KB average per sub-turn:

```
1,286,535 cache_read tokens  ÷  47 sub-turns  ≈  27 KB cached prefix per turn
```

That 27 KB includes ~15 KB of base system prompt + memory + skill descriptions, plus the growing tail of accumulated Bash outputs. **The cost is not the work; the cost is re-reading the exploration state on every sub-turn.**

Two older 1M+ sessions show the same pattern in less pure form:

| Session | Total | Sub-turns | Tools | Output bytes |
|---|---:|---:|---|---:|
| 2026-04-20T00:30:42 | 1.19M | 44 | `Bash`+`Skill` | 17 KB |
| 2026-04-19T20:47:31 | 1.13M | 40 | `Bash`+`Read` | 22 KB |
| 2026-04-20T14:38:29 (this) | **1.40M** | **47** | **Bash only** | **103 KB** |

The common factor across all three high-cost sessions is **sub-turn count in the 40–47 range with Bash as the dominant or sole tool.** When the orchestrator has an intent it can't resolve via a compound skill, it improvises by poking at files with Bash, and each poke compounds.

## Which of the 5 pre-registered hypotheses held up

Hypothesis numbering matches the plan file:

1. **Sub-turn count explosion.** ✅ **Yes, dominant driver.** 47 vs canonical 4 = 12× multiplier. Given the cache-read structure, sub-turn count is the dominant cost lever.
2. **No skill triggered → Bash exploration.** ✅ **Confirmed.** 100% Bash, zero Skill calls. Exact pattern of the #282-era catastrophe, in a different shape: skills ARE registered, just none exist for "diagnose a stack."
3. **Large tool outputs re-read into context.** ✅ **Confirmed.** 103 KB accumulated tool output × 47 sub-turns of cache re-reads = the 1.29M cache_read figure. The largest single Bash result was 23 KB.
4. **Sub-agent spawns.** ❌ **Not this.** Zero Task/Agent invocations in the tool-call list.
5. **Repeated re-reads of same files.** ◑ **Plausible but not measurable from telemetry.** The schema doesn't record Bash commands themselves, only result sizes. Given 31 Bash calls with some 20+ KB outputs, repeated `cat`/`tail` of the same verdict files is likely but not proven.

## Root cause, stated plainly

The orchestrator has no compound skill for "tell me what went wrong with stack N." The intent doesn't match `check-and-resume-stack` (that's "status + resume"), doesn't match `stack-inspect` (that's "show me diff/logs/output," not "diagnose across a dual-loop run"), doesn't match any other skill. So it improvises with Bash — and Bash exploration is exactly the shape that drives sub-turn multiplication and cache-read inflation.

The migration win on canonical scenarios (95K) was real. This is a different, un-migrated intent leaking the same cost pattern we thought we'd killed.

## Recommendation

**File a ticket for a new compound skill: `stack-failure-diagnostic`.** Parameters: stack ID. Body: an ephemeral sub-agent invocation (reuse `runEphemeralAgent` at `src/main/agent/claude-backend.ts`) that internally does the exploration — collect verdict files, iteration phase timings, execution summaries from inside the stack's workspace — and returns a structured one-page verdict to the orchestrator. The heavy exploration happens in fresh sub-agent context, paid for once, not 47 times against the cached prefix.

Expected savings on the same user prompt:

| Metric | Before | Estimated after |
|---|---:|---:|
| Sub-turns (orchestrator) | 47 | 4–6 |
| Tool calls (orchestrator) | 31 Bash | 1 Skill |
| Total tokens (orchestrator) | 1.40M | 120–180K |
| Ephemeral sub-agent cost | 0 | ~150–250K (one-shot, not cached-replayed) |
| **Round-trip total** | **1.40M** | **~300–400K** |

Even pessimistically, that's a ~4× reduction on a workflow the user hit today.

The harness bugs (#291, #292) are independent and already filed; fixing them reduces how often users *need* to diagnose a stack, but doesn't address the per-diagnostic cost.

## Next steps (not done in this investigation)

1. File the `stack-failure-diagnostic` skill ticket. Link this document as the justification.
2. While authoring, capture the exact Bash command sequence the orchestrator improvised in this session (by re-running the same diagnostic with telemetry capturing commands, not just result sizes — or by instrumenting the subprocess to log commands). That sequence is the spec for the skill's internal exploration.
3. Measure the same prompt post-skill-landing. Confirm the 4× target hits.

## What this investigation cost

Reading the telemetry JSONL, bucketing by token cost, characterizing the tool-call histogram, writing this document. Single-digit thousands of tokens; nothing compared to the object of study.
