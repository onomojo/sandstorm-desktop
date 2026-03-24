---
name: sandstorm
description: "Use this skill any time the user wants to work with Sandstorm agent stacks. This includes: creating, spinning up, or starting stacks; dispatching tasks or work to an inner Claude agent in a stack; checking stack status, task progress, or whether a task is done; viewing diffs, changes, or task output from a stack; pushing or publishing code changes from a stack to git; tearing down, cleaning up, or removing stacks; viewing container logs. Trigger whenever the user mentions 'stack' with a number or ID (like 'stack 1', 'stack 2', 'stack 3'), says 'sandstorm', refers to an 'isolated environment' for development, or asks to send work to an agent. Also trigger for multi-stack operations and any reference to agent workspaces. Do NOT trigger for general Docker, docker-compose authoring, CI/CD pipelines, or direct code editing unrelated to stacks."
---

# Sandstorm — MCP Tools Reference

Sandstorm manages isolated Docker agent stacks. Each stack is a full clone of the project repo with its own containers, ports, and an inner Claude agent.

**IMPORTANT:** Always use the MCP tools (`mcp__sandstorm-tools__*`) to manage stacks. Never use CLI commands (`sandstorm up`, `sandstorm task`, etc.) directly — the MCP tools go through the Electron app's control plane, which tracks stacks in the database and keeps the UI in sync.

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `mcp__sandstorm-tools__create_stack` | Create and start a new stack |
| `mcp__sandstorm-tools__list_stacks` | List all stacks with status and services |
| `mcp__sandstorm-tools__dispatch_task` | Send a task to inner Claude in a stack |
| `mcp__sandstorm-tools__get_task_status` | Check task state (running, completed, failed, idle) |
| `mcp__sandstorm-tools__get_task_output` | View latest task output |
| `mcp__sandstorm-tools__get_diff` | View uncommitted changes in a stack |
| `mcp__sandstorm-tools__get_logs` | View container logs for a stack |
| `mcp__sandstorm-tools__push_stack` | Commit and push changes from a stack |
| `mcp__sandstorm-tools__teardown_stack` | Tear down a stack (stops containers, cleans up) |

## Workflows

### Typical flow: ticket to PR

1. `create_stack` — name, projectDir, branch, ticket
2. `dispatch_task` — goal-oriented prompt describing the work
3. `get_task_status` — check when done
4. `get_diff` — review changes
5. `push_stack` — commit and push
6. `teardown_stack` — clean up

### Create stack and dispatch work

```
mcp__sandstorm-tools__create_stack({
  name: "fix-auth-bug",
  projectDir: "/path/to/project",
  branch: "fix/auth-bug",
  ticket: "PROJ-123",
  task: "Fix the auth token expiry bug. Users should see a clear error and be redirected to login."
})
```

The `task` parameter dispatches work immediately after creation — no need to call `dispatch_task` separately.

### Monitor and iterate

```
mcp__sandstorm-tools__get_task_status({ stackId: "fix-auth-bug" })
mcp__sandstorm-tools__get_task_output({ stackId: "fix-auth-bug" })
mcp__sandstorm-tools__get_diff({ stackId: "fix-auth-bug" })
mcp__sandstorm-tools__dispatch_task({ stackId: "fix-auth-bug", prompt: "Looks good but add limit/offset params" })
```

### Review, push, tear down

```
mcp__sandstorm-tools__get_diff({ stackId: "fix-auth-bug" })
mcp__sandstorm-tools__push_stack({ stackId: "fix-auth-bug", message: "Fix auth token expiry with user-facing error" })
mcp__sandstorm-tools__teardown_stack({ stackId: "fix-auth-bug" })
```

## Tool Details

### `create_stack`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | Yes | Stack name — becomes the stack ID (e.g., `fix-auth-bug`) |
| `projectDir` | Yes | Absolute path to the project directory |
| `ticket` | No | Associated ticket ID (e.g., `PROJ-123`) |
| `branch` | No | Git branch name (defaults to stack name) |
| `description` | No | Short description of the work |
| `runtime` | No | `docker` (default) or `podman` |
| `task` | No | Task to dispatch immediately after creation |

The stack builds in the background. Use `get_task_status` or `list_stacks` to check when it's ready.

### `dispatch_task`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `stackId` | Yes | Target stack ID |
| `prompt` | Yes | Task description for inner Claude |

**Write goal-oriented prompts.** Describe WHAT to achieve, not HOW. The inner Claude has the full repo context.

**Good:** "Fix the auth bug where JWT tokens expire silently. User should see an error and be redirected to login. Run the auth test suite."

**Bad:** "Open src/auth.ts, find line 42, change the catch block..."

### `get_task_status`

Returns the current task state for a stack: `running`, `completed`, `failed`, or `idle`.

### `get_task_output`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `stackId` | Yes | Target stack ID |
| `lines` | No | Number of lines to return (default: 50) |

### `get_diff`

Returns the full git diff of uncommitted changes in the stack's workspace. **Always review before pushing.**

### `get_logs`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `stackId` | Yes | Target stack ID |
| `service` | No | Service name (e.g., `claude`, `app`). Omit for all services. |

### `push_stack`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `stackId` | Yes | Target stack ID |
| `message` | No | Commit message |

### `teardown_stack`

Stops containers, removes workspace, archives stack to history. **This is irreversible.** Always check for unpushed changes first with `get_diff`.

## Important Rules

- **Use MCP tools only.** Never bypass with raw `sandstorm` CLI commands or `docker` commands.
- **No polling loops.** Run `get_task_status` as a one-shot check when the user asks. Never write sleep/poll loops.
- **Review before pushing.** Always `get_diff` before `push_stack`.
- **Check before teardown.** Always `get_diff` before `teardown_stack` to avoid losing work.
- **Goal-oriented prompts.** Tell inner Claude what to achieve, not which lines to edit.
- **Stacks appear in the UI.** Because MCP tools go through the Electron control plane, every stack you create will be visible in the Sandstorm Desktop UI.
