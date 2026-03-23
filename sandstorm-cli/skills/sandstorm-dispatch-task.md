---
name: sandstorm-dispatch-task
description: Dispatch a task to the inner Claude agent running inside a Sandstorm stack.
trigger: when the user wants to send a task to a stack, dispatch work, run a task, assign work to inner claude, or execute code changes
---

# Sandstorm Dispatch Task

Send a task prompt to the inner Claude agent in a stack.

## Command

```bash
# Async (default — always prefer this)
sandstorm task <stack_id> [--ticket TICKET] "prompt text"

# From file
sandstorm task <stack_id> --file /path/to/prompt.txt

# Sync (blocks until done — avoid in orchestration)
sandstorm task <stack_id> --sync "prompt text"
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<stack_id>` | Yes | Target stack |
| `"prompt"` | Yes (or `--file`) | Task description |
| `--ticket TICKET` | No | Associated ticket ID |
| `--file FILE` | No | Read prompt from file |
| `--sync` | No | Run synchronously (blocks) |

## Critical rules

1. **Always use async mode** (no `--sync`). Never block the conversation waiting for a task.
2. **Never write sleep/poll loops.** Check status with `sandstorm task-status <id>` only when needed.
3. **Write clear, goal-oriented prompts.** Describe WHAT, not HOW. The inner Claude has the full repo.

## Writing good task prompts

**Good — goal-oriented:**
```bash
sandstorm task 1 "Fix the authentication bug where JWT tokens expire silently.
The user should see a clear error message and be redirected to login.
Run the auth test suite to verify the fix."
```

**Bad — micromanaging:**
```bash
sandstorm task 1 "Open src/auth.ts, find the verifyToken function on line 42,
change the catch block to add a console.error..."
```

## Monitoring tasks

```bash
sandstorm task-status <stack_id>     # Check if running/completed/failed
sandstorm task-output <stack_id>     # See output (last 50 lines)
sandstorm task-output <stack_id> 200 # See more output
sandstorm diff <stack_id>            # See what changed
```

## Task lifecycle

1. Prompt is written to container
2. Task runner picks it up and launches Claude
3. Inner Claude works autonomously with `--dangerously-skip-permissions`
4. Output streams to `/tmp/claude-task.log`
5. Status file updated to "completed" or "failed"
6. Registry updated with final branch info

## Common patterns

**Dispatch and move on:**
```bash
sandstorm task 1 "Implement the search feature with tests"
# Immediately respond to user, check later
```

**Check results:**
```bash
sandstorm task-status 1
sandstorm diff 1
```

**Iterate on feedback:**
```bash
sandstorm task 1 "The search feature looks good but needs pagination. Add limit/offset params."
```

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| "Container not running" | Stack is down | Run `sandstorm up <id>` first |
| Task stays "RUNNING" forever | Inner Claude hung | Check `sandstorm task-output <id>` for errors |
| "FAILED" status | Inner Claude errored | Check `sandstorm task-output <id>` for details |
