---
name: stack-inspect
description: "Use this skill whenever the user wants to see DETAILED output, logs, or uncommitted changes from a specific Sandstorm stack. Trigger phrases include: 'show me the output of stack X', 'what did stack X log', 'show the task output for X', 'show container logs for stack X', 'what changed in stack X', 'show me the diff in stack X', 'what's happening inside stack X', 'dump stack X's output', 'get logs for stack X's claude container'. The skill covers three read-only probes — task output, container logs, and uncommitted diff — as subcommands. Do NOT trigger for: a quick status check (that's check-and-resume-stack), listing all stacks (that's list-stacks), or anything that modifies state. Prefer the narrower subcommand (output / logs / diff) over 'all' when the user is specific about what they want."
---

# /stack-inspect

Read-only inspection of a stack. Pick the right subcommand based on what the user asked for.

## Subcommands

```bash
bash "$SANDSTORM_SKILLS_DIR/stack-inspect/scripts/stack-inspect.sh" output <stack-id>
bash "$SANDSTORM_SKILLS_DIR/stack-inspect/scripts/stack-inspect.sh" logs   <stack-id> [service]
bash "$SANDSTORM_SKILLS_DIR/stack-inspect/scripts/stack-inspect.sh" diff   <stack-id>
bash "$SANDSTORM_SKILLS_DIR/stack-inspect/scripts/stack-inspect.sh" all    <stack-id>
```

- `output` → latest task output (last 50 lines by default).
- `logs [service]` → container logs. Omit `service` for all containers; specify `claude` or `app` to narrow.
- `diff` → uncommitted changes in the stack's workspace.
- `all` → condensed version of all three sections. Use sparingly — this is the most expensive variant.

The script prints the unwrapped bridge result. Relay it to the user, trimmed if very long.

## Hard rules

- One stack per invocation. If the user names multiple, ask which one.
- Don't call `get_task_output`, `get_logs`, or `get_diff` MCP tools directly — this skill is the only path for these read-only queries.
- Don't follow up with `dispatch_task` or any mutation. If the user wants to act on what they saw, that's a different skill (check-and-resume-stack, review-and-pr).
