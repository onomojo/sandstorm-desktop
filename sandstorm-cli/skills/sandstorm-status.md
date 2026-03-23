---
name: sandstorm-status
description: Check the status of Sandstorm stacks, tasks, and view output/diffs.
trigger: when the user wants to check stack status, see what stacks are running, monitor tasks, view diffs, or check on progress
---

# Sandstorm Status & Monitoring

Commands for checking stack status, task progress, diffs, and logs.

## Commands

### Stack dashboard
```bash
sandstorm status
```
Shows a table of all stacks with: ID, status (UP/DOWN/RUNNING/IDLE/FAILED/BUILDING), ticket, branch, last task.

### Task status
```bash
sandstorm task-status <stack_id>
```
Shows current task state: RUNNING, IDLE, COMPLETED, FAILED, or NO TASK.

### Task output
```bash
sandstorm task-output <stack_id> [lines]
```
Shows the last N lines of task output (default: 50).

### Git diff
```bash
sandstorm diff <stack_id>
```
Shows untracked/modified file summary and all uncommitted changes in the stack's workspace. This is the primary review mechanism — inner Claude does not commit, so all changes appear here.

### Container logs
```bash
sandstorm logs <stack_id> [service]
```
Tails Docker logs for a service (default: `claude`).

## Status values

| Status | Meaning |
|--------|---------|
| BUILDING | Stack containers are being built |
| UP | Containers running, no task active |
| IDLE | Same as UP — container running, no task |
| RUNNING | Task is currently executing |
| COMPLETED | Last task finished successfully |
| FAILED | Last task failed |
| PR-CREATED | Changes pushed and PR created |
| DOWN | Containers not running |

## Common monitoring patterns

**Check all stacks:**
```bash
sandstorm status
```

**Monitor a specific task:**
```bash
sandstorm task-status 1
sandstorm task-output 1
```

**Review completed work:**
```bash
sandstorm task-status 1    # Confirm completed
sandstorm diff 1           # Review uncommitted changes (this is the intended review mechanism)
sandstorm task-output 1    # See what Claude did
```

**Debug a failed task:**
```bash
sandstorm task-status 1    # See FAILED status
sandstorm task-output 1 200  # Get more output lines
sandstorm logs 1           # Check container logs
```

## Important notes

- **Never poll in a loop.** Run status checks as one-shot commands.
- **Always use `sandstorm` commands** for monitoring — don't bypass with raw `docker` commands.
- Task output is stored in `/tmp/claude-task.log` inside the container.
- `sandstorm diff` shows uncommitted changes because inner Claude does not commit. This is by design — it lets you review everything before pushing.
