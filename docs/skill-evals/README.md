# Skill eval methodology

This directory holds the systematic eval harness for every Sandstorm-bundled
skill. It exists because ad-hoc "try a prompt in an interactive session"
validation is non-repeatable and silently drifts across model releases. Every
skill that ships in `sandstorm-cli/skills/` MUST have a trigger eval set here.

## What an eval set looks like

`<skill-name>/trigger-eval.json` is a flat JSON array. Each element:

```json
{
  "query": "verbatim user phrasing",
  "should_trigger": true,
  "notes": "optional — why this phrasing, or which past session it came from"
}
```

Positives (`should_trigger: true`) MUST be real phrasings elicited directly
from the user — NOT invented. Phrasing is personal; what one user says ("pick
up where it left off") another never does. Ask the user how they'd talk to
the skill, skill by skill. Vary the entity ID (stack numbers, ticket
numbers, names) across queries so the model can't pass by keying on the
identifier instead of the intent. Target 3–10 positives per skill. Rare
skills (e.g. stack-teardown) can bottom out at 1 positive — the eval's main
signal for those is the negative set.

Negatives (`should_trigger: false`) are the other skills' positives. Draw
from the phrasings the user gave for adjacent skills rather than inventing
keyword-adjacent strings; that's the real disambiguation test. Target
≥5 negatives. For destructive skills (stack-teardown), oversample negatives
aggressively — false-positives cost real work.

## Running the harness

One-shot, single skill:

```bash
scripts/skill-eval.sh check-and-resume-stack claude-opus-4-6
```

All skills with eval sets, one model:

```bash
scripts/run-all-skill-evals.sh claude-opus-4-6
```

The runner wraps skill-creator's `run_loop.py` — it spins up a temporary
slash-command with the skill's description, fires the query at `claude -p`,
and detects Skill-tool invocation via streamed events. Each query runs 3× by
default; a skill "passes" a query if its trigger rate meets the threshold
(default 0.5).

Requirements (checked up-front by the wrapper):
- `ANTHROPIC_API_KEY` in env (used by `run_loop.py`'s improvement step)
- `claude` CLI on `$PATH`
- `python3` with the `anthropic` package available (installed alongside
  Claude Code)
- The `skill-creator` plugin installed locally
  (`claude plugin install skill-creator@claude-plugins-official`)

## Results history

Each run writes `results/<model-id>/<iso-timestamp>/results.json` plus a
sibling HTML report. The per-model subdirectory is what lets us compare
"opus-4.6 baseline" to "opus-4.7 shipped" without losing the older numbers.
The top-level `results/<model-id>/latest.json` is a symlink/copy of the most
recent run for quick reads.

## Acceptance bar

Per the skill-migration plan, a skill passes the bar when:
- Positive (should-trigger) queries trigger at ≥80% averaged across the set.
- Negative (should-not-trigger) queries fire <20% of the time.
- No single positive query has a 0% trigger rate (dead phrasings must be
  addressed — either reword the skill description or drop the query as
  unrepresentative).

Miss the bar → tune the SKILL.md description via run_loop's improvement pass
(`--max-iterations 5`) and commit the improved description.

## Why trigger evals but no behavior evals here yet

Behavior evals (does the skill, once triggered, do the right thing?) for
script-backed skills need a mock MCP bridge harness. The prototype lives at
`/tmp/mock-bridge.py` from the #268 session. Generalizing that into
`scripts/skill-behavior-eval.sh` is a follow-up PR under #285 once the
trigger-eval shape is in place for every skill.
