---
name: stack-failure-diagnostic
description: "Use this skill when the user asks why a stack failed, asks to diagnose / take a look at / figure out what happened with a stack that hit a problem. Trigger phrases include: 'why did stack N fail', 'take a look at stack N, something went wrong', 'stack N looks broken, what happened', 'diagnose stack N', 'what went wrong with stack N', 'stack N got stuck, can you take a look'. The skill reads the stack's dual-loop artifacts (phase timings, review verdicts, execution summaries) from inside its container and returns one structured report — avoiding the 40+ Bash-exploration sub-turns the orchestrator would otherwise make. Do NOT trigger for: status-only 'is stack N done?' (that's check-and-resume-stack), diff/logs inspection on a working stack (stack-inspect), or creating a new stack."
---

# /stack-failure-diagnostic

Extract the stack ID from the user's message, then run the script exactly once:

```bash
bash "$SANDSTORM_SKILLS_DIR/stack-failure-diagnostic/scripts/diagnose.sh" <stack-id>
```

The script prints a structured multi-section report. Relay the relevant parts to the user — do NOT re-read the underlying files yourself, do NOT run additional Bash/Grep/Read against the stack's container. The report already has everything you need to answer "what went wrong".

If the script prints `NOT_FOUND`, report it and ask for the exact ID. If it prints `NO_ARTIFACTS`, the stack has no dual-loop artifacts yet (never ran or was just created); tell the user that and stop.
