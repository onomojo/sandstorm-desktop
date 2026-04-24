# Orchestrator delta — running results

Filled in incrementally as each experiment completes. The plan + runbook are in
`.claude/plans/you-keep-saying-like-deep-journal.md` and
`docs/investigations/orchestrator-delta-runbook.md`. Final analysis writeup will live in `orchestrator-delta.md` once all experiments are in.

## Baseline message

> Take a look at stack 250… (full canonical scenario, see runbook)

Same message, every run. Same tab (`project-3`).

## Headline table

| # | Experiment | Total tokens | sub_turn_count | Cache read | Cache creation | Output | Per-sub-call prefix |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 | exp1-baseline | 323,093 | 22 | 268,107 | 47,728 | 7,244 | ~12.2 KB |
| 4 | exp4-no-mcp | **787,263** ⚠ | **41** | **734,160** | 43,184 | 9,889 | ~17.9 KB |
| 3 | exp3-no-system-prompt | 182,385 ✻ | 10 | 139,570 | 39,979 | 2,826 | ~14.0 KB |
| 2 | exp2-agent-enabled | 508,381 ⚠ | 31 | 433,954 | 66,179 | 8,231 | ~14.0 KB |
| 5 | exp5-strip-all | **1,131,897** ⚠⚠ | **40** | **1,107,612** | 16,271 | 7,983 | ~27.7 KB |
| 7 | exp7-austerity | _pending_ | | | | | |
| 6 | exp6-fresh-claude-code | _pending_ | | | | | |

## Per-experiment notes

### exp1-baseline (2026-04-19T16:54Z)

- 22 sub-API-calls in one user message. (Last comparable session: 16. So slightly higher this time, possibly because the response was more thorough.)
- 11 captured tool calls; 11 pure text-only assistant turns interleaved (the model "thinking" in between tools).
- Per-sub-call prefix averaged ~12.2 KB (cache_read sum / sub_turn_count). This is the average across the chain — the prefix grows with each tool_result, so later calls in the chain pay more than 12 KB and earlier ones less.
- Output tokens were 7,244 — the response was a long markdown writeup with tables. That's a big chunk of the bill the orchestrator pays just to reply to the user, separate from the tool-chain amplification.

Tool calls captured (in order):
1. `mcp__sandstorm-tools__get_task_status` (44 B)
2. `mcp__sandstorm-tools__list_stacks` (3,452 B)
3. `mcp__sandstorm-tools__get_task_status` (121 B)
4. `mcp__sandstorm-tools__get_task_output` (28 B)
5. `mcp__sandstorm-tools__get_diff` (2 B — empty diff)
6. `mcp__sandstorm-tools__get_logs` (5,836 B)
7. `Bash` (1,567 B)
8. `mcp__sandstorm-tools__dispatch_task` (126 B)
9. `Bash` (39 B)
10. `Bash` (129 B)
11. `mcp__sandstorm-tools__dispatch_task` (80 B)

7 of 11 are MCP calls — same fragmented "string four MCP calls together to assemble a status picture" pattern. The 5 status/list/output/diff/logs calls upfront could plausibly collapse into 1 well-shaped tool or 1 `sandstorm status --full 250` Bash call.

Total tool_result bytes: ~11.4 KB. Tiny — the cost is not the tool responses themselves; it's that there are 22 sub-calls each re-reading the prefix.

### exp4-no-mcp (2026-04-19T17:01Z)

**787K total tokens — 2.4× the baseline.** Removing MCP made it dramatically worse, not better.

- 41 sub-API-calls (vs baseline 22). Almost double the chain length.
- 23 Bash calls + 1 Read = 24 captured tool calls (and 17 pure-text "thinking" turns interleaved).
- Tool_result bytes total: ~21.5 KB (vs baseline ~11.4 KB). Each Bash call's stdout went into the transcript.
- Per-sub-call prefix averaged ~17.9 KB (HIGHER than baseline's 12.2 KB), because each Bash tool_result added more content to the transcript that the next sub-call had to re-read.

**Why it ran longer:**
1. Without `mcp__sandstorm-tools__*` helpers, the orchestrator had to reconstruct each operation via raw Bash: `docker ps`, `find sandstorm`, `cat /tmp/...`, `git log`, `tail logs`, etc. Where MCP's `list_stacks` returned the picture in one call, Bash needed several.
2. The orchestrator made an honest mistake (per the user's pasted response): it ran `sandstorm up 250 --branch ...` without `--ticket scheduled-automation`, which spun up a new empty stack at workspace `250/` instead of reviving the original at `250-scheduled-automation/`. It then spent more sub-calls investigating what happened and reconstructing the state. Some of the bloat is self-inflicted by that mistake (which MCP's `list_stacks` would have prevented by surfacing the legacy slug).
3. The model produced a much longer markdown writeup with multiple tables (output_tokens 9,889 vs 7,244 baseline).

**What this means for H-B:**
The simple form of H-B ("MCP migration introduced bloat → removing MCP reduces cost") is **refuted by the numbers**. With MCP gone, the orchestrator did MORE work, not less. MCP tools, despite their schema cost in the prefix, actually **collapse multi-step operations into fewer sub-calls** for the operations they wrap.

The nuanced form is still partially true: MCP schema bytes do ride the prefix on every turn (cost is real), but the trade-off is favorable when MCP wraps operations the orchestrator does often. The cost driver in our baseline isn't the MCP tools themselves — it's that the orchestrator does many things via tools regardless.

This actually **supports** the user's broader framing in a different way: when the orchestrator can't use a high-level tool (no MCP), it doesn't say "I can't do that"; it strings together raw primitives ("step right, step right, step right") and ends up doing the same thing more expensively. The roundabout pattern shows up clearly.

**Note:** the next experiments (3, 2, 5, 7) all keep MCP enabled. We don't need to re-test no-MCP variants — the answer is decisive enough.

### exp3-no-system-prompt (2026-04-19T20:26Z) ✻ quality caveat

**182K — roughly half the baseline. But the orchestrator did less work per message.**

Raw numbers (all better than baseline):
- 10 sub-API-calls (vs baseline 22). Less than half.
- 5 MCP calls (same fragmented `list_stacks → get_task_status → get_task_output → get_diff → get_logs` probing pattern).
- Zero Bash calls.
- Output tokens 2,826 (vs baseline 7,244) — much shorter response.
- Per-sub-call prefix ~14 KB (essentially the same as baseline's 12.2 KB).

**The quality caveat:** the user flagged that the orchestrator "didn't seem to even do anything." In this config the orchestrator:
- Gathered initial state via the 5 MCP calls.
- Reported what it found.
- **Stopped and asked the user to pick A or B** for how to proceed ("docker start containers manually" vs "dispatch a fresh task").

In baseline (exp1), the orchestrator knew `SANDSTORM_OUTER.md`'s rules about stack resumption and just went ahead and did it (dispatched a resume task, 2 more MCP calls for that). In exp3, without that prompt, the orchestrator was cautious and asked for instructions.

**So the 141K reduction (from 323K to 182K) is a mix of two things:**
1. **Genuine efficiency:** sub_turn_count fell from 22 → 10. No Bash-based roundabouts this time. About a 10-sub-call reduction even for the "initial-investigation only" portion.
2. **Reduced scope of action:** the orchestrator asked for user input instead of continuing. Some of the sub-call reduction comes from *not doing the follow-through work*.

We don't have a clean way to separate these two effects from this one run. But signal #1 exists — the first 10 sub-calls matched the baseline's first ~14 sub-calls in what they accomplished (gather status picture, report findings), and they did it in fewer turns. Some of that may be because without SANDSTORM_OUTER.md's reading-forbidden rules, the model didn't need to contort around restrictions — it could have used native capabilities more directly.

**Partial support for H-C.** The user's "restrictive philosophy causes roundabouts" hypothesis has *some* evidence here: the initial investigation phase genuinely used fewer sub-calls. But this is complicated by the fact that the canonical scenario ("resume stack 250") is Sandstorm-specific, and without the Sandstorm-specific prompt the orchestrator legitimately needs clarification. A more general canonical scenario (one not requiring Sandstorm knowledge to execute the follow-through) would separate these effects better.

**What to check next:** Experiment 5 (strip all) and Experiment 7 (austerity). If those show similar patterns (big token reduction but also reduced work completion), that confirms the pattern. If Experiment 5 is significantly cheaper than Exp 3 AND the orchestrator still follows through to completion (because Agent delegation lets it route rather than reason), that'd be the most interesting finding.

### exp2-agent-enabled (2026-04-19T20:33Z) ⚠ setup flaw

**508K — higher than baseline.** Two issues with this run:

**1. The model never actually used the Agent tool.** Agent / Task were added to the allowlist so the model COULD delegate, but the 15 captured tool calls show zero Agent invocations. It used MCP + Bash throughout, same as baseline. The model didn't organically reach for Agent just because it was available.

This points to a plan flaw: **adding Agent to the allowlist is necessary but not sufficient — the prompt also has to tell the model to delegate.** The plan had called for a one-paragraph prompt addition to SANDSTORM_OUTER.md, but the implementation shipped only the env-var allowlist flip; the prompt wasn't changed for this branch. So this run doesn't actually test H-A cleanly — it tests "model chooses to ignore Agent when SANDSTORM_OUTER.md is active."

**2. Not an environment confound — a behavioral difference.** Initial correction: I first framed this as "containers were running this run." That's wrong. The containers were stopped at the start, identical to baseline. The orchestrator in THIS run chose to run `docker start` via Bash mid-run, then inspected the live workspace further, which is how `get_diff` returned **45,059 bytes** of real diff (vs baseline's 2-byte empty result from stopped containers). Baseline dispatched a resume task via MCP and stopped; exp2 kept going: explicit `docker start`, workspace inspection, live `get_diff`, and only then dispatched.

Why the behavior difference on identical starting state? Two candidates:
  - **Run-to-run model variance.** The orchestrator's tool-chain isn't deterministic; the same user message can produce different chains on different runs.
  - **Agent's presence shifted reasoning.** Even though Agent was never *invoked*, having it in the tool schemas might have subtly shifted the model toward "I have capability for deeper exploration" behavior.

We can't separate these without repeated runs of each variant. For interpretation purposes: exp2's cost was higher than baseline partly because the model did more work this run, not because anything was structurally worse.

Observable:
- 31 sub-calls (vs 22 baseline)
- 15 captured tool calls — 10 MCP + 4 Bash + **1 huge get_diff (45 KB)** + 0 Agent
- `get_logs` called twice, returning 5 KB and 4.8 KB. Accumulated log payload alone is ~10 KB in the transcript after those two calls.
- Per-sub-call prefix ~14 KB (similar to baseline); the cache_read growth came from the diff + logs payload accumulating, not from a schema increase.

**H-A status: inconclusive.** We still don't know if active Agent delegation would help because the model didn't do it. Experiment 5 (no SANDSTORM_OUTER.md + Agent enabled + default system prompt) is now the primary clean test of H-A — the default Claude Code system prompt is known to make the model reach for Agent/Task naturally, which SANDSTORM_OUTER.md apparently suppresses.

**Follow-up experiment to consider (post-current-set):** Exp 2b — re-run Exp 2 but also add the planned prompt paragraph telling the model to delegate via Agent. That isolates "Agent available + prompted" vs "Agent available but unprompted" vs "Agent unavailable."

### exp5-strip-all (2026-04-19T20:47Z) ⚠⚠ worst result so far

**1.13 MILLION tokens.** 3.5× baseline. This is the most expensive run of the investigation.

Config: no SANDSTORM_OUTER.md + no MCP + Agent/Task added to allowlist. The "just be fresh Claude Code pointed at the project" setup. It was supposed to be the lightest-weight variant.

Raw numbers:
- 40 sub-API-calls.
- 23 Bash calls + 1 Read (12.3 KB) + 0 Agent + 0 MCP = 24 captured tool calls. 16 pure-text "thinking" sub-turns.
- `cache_creation_input_tokens`: only 16,271 (baseline 47,728). Static prefix IS smaller without SANDSTORM_OUTER.md — ~30K smaller. The setup-layer fix worked as designed.
- `cache_read_input_tokens`: **1,107,612** (baseline 268,107). The static prefix being smaller doesn't matter when the transcript balloons through 40 sub-calls.
- Per-sub-call prefix averaged ~27.7 KB — highest of any experiment. The 12 KB Read early in the chain + 22 accumulated Bash tool_results made the prefix grow fast.

**The damning finding: Agent/Task was available AND SANDSTORM_OUTER.md was gone. The model still didn't use Agent.** It did 23 Bash calls + 1 Read instead. Fresh Claude Code, with the same tool surface, is reported by the user to stay much cheaper on comparable work. Our orchestrator in this config did not behave like fresh Claude Code.

**Big-picture result from the first 5 experiments:**

Ordered by cost (completed runs only):
```
exp1 baseline                   323K / 22 sub-calls / full follow-through
exp2 agent-enabled              508K / 31 sub-calls / full follow-through (did extra work)
exp4 no-mcp                     787K / 41 sub-calls / full follow-through (made a mistake)
exp5 strip-all                 1,132K / 40 sub-calls / full follow-through
exp3 no-system-prompt           182K / 10 sub-calls / stopped early (asked A/B)
```

**Baseline is the cheapest completed run.** Every attempt to "fix" the orchestrator setup made it more expensive. The only cheaper result (exp3) was cheaper because the orchestrator stopped early and asked a clarifying question instead of executing the request.

**What this says about the original framing:**

1. The user's "restrictive philosophy forces roundabouts" framing is NOT supported by the data. Removing the restrictive philosophy (exp3, exp5) either produced incomplete work (exp3) or more exploration (exp5).
2. The "re-enable Agent delegation" hypothesis (H-A) is NOT a plug-and-play fix. Even with Agent available, the model doesn't reach for it. The model needs explicit instruction to delegate.
3. "Just make it ordinary Claude Code" (exp5) doesn't match the user's lived experience of fresh Claude Code being cheap. That suggests the CANONICAL SCENARIO itself (Sandstorm stack resumption) is inherently heavy work regardless of tool surface — it requires investigation, and any agent will investigate. The user's "fresh Claude Code stays cheap" memory is probably for different/simpler tasks, not the stateful "resume this long-running thing" workflow.

**This reshapes the remaining work:**
- Exp 7 (memory/CLAUDE.md austerity) — likely will also be expensive given the pattern. Memory contributes a small static prefix share (~5K tokens per turn); stripping it can't compensate for the 40-sub-call multiplier.
- Exp 2b (Agent + prompt paragraph) is now the most important remaining experiment. If explicit delegation prompting changes the behavior, that's the real lever. If it doesn't, we have stronger grounds to conclude the scenario itself is the cost driver and no orchestrator config will help.

## Candidate Experiment 8 (user-proposed, post-current-set)

**Idea:** move some MCP tools to skills instead of removing them. Skills are lazy-loaded — only their name + short description rides the prefix; the full body loads only when the Skill tool invokes one.

**Not a flip-the-env-var test.** Requires building skill versions of 1–2 existing MCP tools. Candidates:
- **Cold-path tools** (rarely used per session): `spec_refine`, `teardown_stack`, `set_pr`, `create_stack`. Paying their MCP schema cost on every turn is wasteful if they're invoked once in 20 turns.
- **Hot-path tools** (every session): `list_stacks`, `get_task_status`, `dispatch_task`, `push_stack`. Keep these MCP — Exp 4 showed that losing hot-path access forces Bash-reconstruction which costs more.

**Expected outcome:** modest savings on the prefix side (a few KB/turn), no change to sub_turn_count (skills take one sub-call to invoke, same as MCP). If sub_turn_count is the dominant lever (it looks that way from exp1/exp4), skills won't be the big unlock.

**When to consider building it:** after the current set completes and we know which hypothesis dominates. If H-C or H-A turn out to be the big lever, skills are a nice-to-have. If no hypothesis dominates cleanly and we're still trying to shave prefix bytes, skills become first priority.

## Session end-state (read this first on resume)

### Where we are
5 of 7 planned experiments completed (1, 4, 3, 2, 5). Experiment 7 deprioritized. Experiments 2b and 8 remain.

### Headline conclusions (supported by data)
1. **Baseline (current main) is the cheapest SETUP that completes the work.** Every tested configuration that removed something (MCP, SANDSTORM_OUTER.md) either produced incomplete work (exp3) or drove MORE cost (exp4, exp5). Up to 3.5× baseline for the "strip everything" variant.
2. **Sub-turn count is the dominant cost lever**, not prefix size per turn. Prefix per sub-call is ~12–28 KB depending on config; multiplied by 22–41 sub-calls gives the 300K–1.13M range we observed.
3. **Tool availability ≠ tool use.** Both exp2 and exp5 had Agent/Task in the allowlist. The model called Agent zero times in both. Passive "re-enable delegation" doesn't work; model needs explicit instruction.
4. **H-C (restrictive-philosophy) refuted.** Stripping SANDSTORM_OUTER.md did not cause the model to be more efficient — in exp5 it caused the model to explore even more deeply (1.13M tokens).
5. **The user's lived "fresh Claude Code stays cheap" experience is likely about different (simpler) tasks**, not the stateful "resume this Sandstorm stack" workflow. Exp 5 — close to fresh Claude Code pointed at the project — cost 1.13M. The canonical scenario is inherently heavy.

### Open levers still worth testing
Both focus on reducing prefix cost per sub-call rather than changing model behavior, since we now know model behavior resists direct manipulation by tool-allowlist changes.

1. **Exp 2b** — Agent in allowlist PLUS a prompt paragraph explicitly telling the model to delegate analysis. Tests whether explicit prompting (vs passive availability) changes behavior. Cheap: one prompt edit + one run.
2. **Exp 8** — port 1+ rarely-used MCP tool to a skill and measure. Tests the user's insight: MCP schemas ride the prefix on every sub-call (~8 KB); skills only surface names + short descriptions (~3–4 KB). Expected savings from one tool: small (~a few KB prefix). Expected savings from migrating cold-path MCPs wholesale: 30–40% cache_read reduction if model behavior stays the same. **Must be built with evals** — `/skill` (or current Claude Code skill-authoring tool) with ≥2 eval prompts verifying the skill fires on canonical scenarios.

### Environment issues to clean up FIRST on resume
- A **bare `250` stack** exists in Docker (created by exp4's orchestrator mistake, workspace at `.sandstorm/workspaces/250/`). It polluted runs 2, 3, and 5 as a second stack in `list_stacks`. Must be torn down before further experiments — user approval required per `feedback_never_teardown_stacks.md`. Command: `sandstorm down 250` against the bare one (not `250-scheduled-automation`).
- The `250-scheduled-automation` stack remains paused with uncommitted work. DO NOT teardown. The user's ongoing scheduler feature is there.

### Required reading on resume
In order:
1. This document (`docs/investigations/orchestrator-delta-results.md`) — full experiment data + this end-state section.
2. `.claude/plans/you-keep-saying-like-deep-journal.md` — investigation plan with all hypotheses + experiment definitions.
3. `docs/investigations/orchestrator-delta-runbook.md` — exact launch commands per experiment.
4. Memory: `feedback_measure_before_prescribing.md`, `feedback_lockdown_predates_fixes.md`, `feedback_never_teardown_stacks.md`, `feedback_new_pr_per_change.md`.

### Next-session first steps
1. Confirm with user: teardown bare `250` stack (stray from exp4).
2. Run Exp 2b: edit `sandstorm-cli/SANDSTORM_OUTER.md` on the `investigate/orchestrator-delta-experiments` branch to add a delegation-paragraph under the Tool Allowlist section. Rebuild (`npm run release`). User runs the canonical scenario with `SANDSTORM_TOKEN_TELEMETRY=1 SANDSTORM_TOKEN_TELEMETRY_EXPERIMENT=exp2b-agent-with-prompt SANDSTORM_EXP_ENABLE_AGENT=1`. Read telemetry row.
3. Design Exp 8 with proper skill tooling:
   - Pick ONE cold-path MCP tool (candidate: `teardown_stack` or `set_pr` — low usage).
   - Author a skill via Claude Code's skill-authoring tool. Include ≥2 eval prompts verifying invocation.
   - Test discoverability first (does the orchestrator's `--system-prompt-file` invocation surface skills? This is the known unknown).
   - If discoverable: run canonical scenario with the skill added (MCP stays intact alongside). If model uses the skill → viable path for broader migration. If model ignores it → add SANDSTORM_OUTER.md hint, re-run.
4. Write final investigation report at `docs/investigations/orchestrator-delta.md` and close out #254's investigation arc.

### Branch/PR state on resume
- Investigation work lives on `investigate/orchestrator-delta-experiments`. Do NOT merge to main — it's for experiments only.
- Each experiment extension (exp 2b, exp 8) should be a NEW commit on that branch, or a new branch off it. Do not create PRs unless we're actually landing something.
- Per `feedback_new_pr_per_change.md`: if we DO productionize any finding, it goes on a fresh branch off main with its own PR.

## Hypotheses verdict (filling in as data lands)

| Hypothesis | Verdict | Evidence |
|---|---|---|
| H-A: Missing sub-agent delegation | **REFUTED (passive form)** | exp2 AND exp5 both had Agent in the allowlist. Zero Agent calls in both. Making the tool available is not sufficient. Still open: does exp2b (Agent + prompt paragraph explicitly instructing delegation) change behavior? |
| H-B: CLI→MCP migration introduced bloat | **REFUTED (simple form)** | exp4-no-mcp ran 2.4× more expensive than baseline (787K vs 323K). MCP tools, despite schema cost, collapse multi-step operations into fewer sub-calls. |
| H-C: Restrictive philosophy causes roundabouts | **REFUTED** | exp3 hit 182K but stopped early without executing. exp5 (no SANDSTORM_OUTER.md + Agent + no MCP) was **3.5× baseline** at 1.13M tokens. Removing restrictions did not reduce the roundabout pattern — it amplified it. The orchestrator explored deeper, not shallower, without the Sandstorm-specific framing telling it what "resume a stack" means. |
| H-D: Memory / CLAUDE.md drift | _pending_ | (need exp 7) |
| H-E: Prompt language invites analysis | _pending_ | (need exp 3 + 5) |
