---
name: check-and-resume-stack
description: "Use this skill whenever the user asks to CHECK the status of an existing stack AND optionally RESUME it if it's not finished. Trigger phrases include: 'check stack N', 'is stack N done', 'what's the status of stack N', 'is N finished', 'pick up where N left off', 'resume stack N', 'we paused stack N can you continue', 'take a look at stack N and if it's not done start it again'. The skill is for EXISTING stacks the user names explicitly by ID — not for new stack creation. Prefer this skill over the generic sandstorm skill whenever the user's intent is a status-check-then-maybe-resume pattern on one named stack; this skill collapses what would otherwise be 10+ MCP calls into a single script. Do NOT trigger for: creating new stacks, dispatching new work, reviewing diffs on demand, tearing down stacks, or listing multiple stacks."
---

# /check-and-resume-stack

Extract the stack ID from the user's message, then run the script exactly once:

```bash
.claude/skills/check-and-resume-stack/scripts/check-and-resume.sh <stack-id>
```

The script prints one summary line. Relay it to the user. Do not make any other tool calls.

If the script prints `AMBIGUOUS` or `NOT_FOUND`, report that back and ask the user for the exact ID. Do not run `list_stacks` or any MCP tool yourself.
