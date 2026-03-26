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

## Critical Rules

- **NEVER set `branch` to `main`.** Omit the `branch` parameter — it defaults to the stack name, which becomes a feature branch. Setting `branch: "main"` causes pushes to go directly to main, bypassing code review. This has caused loss of work.
- **NEVER tear down stacks unless the user explicitly asks.** No inference, no cleanup, no "let me tear this down first." The ONLY valid trigger is the user directly requesting teardown.
- **Always create PRs after pushing.** Use `gh pr create` to open a pull request from the feature branch.
- **NEVER rewrite, summarize, or embellish GitHub issue text when dispatching.** Pass the issue body verbatim. See the "Verbatim Issue Dispatch" section below.

## Workflows

### Typical flow: ticket to PR

1. `create_stack` — name, projectDir, ticket (do NOT pass branch — it defaults to the stack name)
2. `dispatch_task` — pass the **verbatim issue body** as the task prompt (see Verbatim Issue Dispatch below)
3. `get_task_status` — check when done
4. `get_diff` — review changes
5. `push_stack` — commit and push to the feature branch
6. `gh pr create` — create a pull request

Do NOT tear down stacks — only the user decides when to tear down.

### Verbatim Issue Dispatch

When the user says "start issue #N", "spin up a stack for issue #N", or any variation:

1. **Fetch the full issue body:** `gh issue view <N> --json body,title -q '.body'`
2. **Pass the issue body verbatim** as the `task` parameter to `create_stack` or `dispatch_task`
3. **Do NOT summarize, rewrite, add implementation details, or "improve" the issue text**
4. **Never add file paths, class names, or implementation steps that aren't in the issue**

**If the user gives verbal instructions that differ from the issue**, update the issue first with `gh issue edit <N>`, then fetch and dispatch the updated body. The issue is the single source of truth.

**Why this matters:**
- The inner Claude has full repo context — it can figure out implementation details itself
- The inner Claude reads CLAUDE.md, understands the codebase, and makes appropriate decisions
- Adding implementation specifics from the outer Claude constrains the inner Claude and can steer it wrong
- Summarizing loses important details and nuance from the original issue

### Create stack and dispatch work (for a GitHub issue)

```bash
# 1. Fetch the issue body verbatim
ISSUE_BODY=$(gh issue view 28 --json body -q '.body')

# 2. Create stack with the unmodified issue body as the task
mcp__sandstorm-tools__create_stack({
  name: "issue-28-fix-auth-bug",
  projectDir: "/path/to/project",
  ticket: "28",
  task: <ISSUE_BODY — the full, unmodified issue text>
})
```

**NEVER pass `branch: "main"`. Omit the branch parameter entirely.**

The `task` parameter dispatches work immediately after creation — no need to call `dispatch_task` separately.

### Monitor and iterate

```
mcp__sandstorm-tools__get_task_status({ stackId: "issue-28-fix-auth-bug" })
mcp__sandstorm-tools__get_task_output({ stackId: "issue-28-fix-auth-bug" })
mcp__sandstorm-tools__get_diff({ stackId: "issue-28-fix-auth-bug" })
mcp__sandstorm-tools__dispatch_task({ stackId: "issue-28-fix-auth-bug", prompt: "Looks good but add limit/offset params" })
```

### Review, push, create PR

```
mcp__sandstorm-tools__get_diff({ stackId: "issue-28-fix-auth-bug" })
mcp__sandstorm-tools__push_stack({ stackId: "issue-28-fix-auth-bug", message: "Fix auth token expiry with user-facing error" })
gh pr create --title "Fix auth token expiry" --body "Fixes #28"
```

## Tool Details

### `create_stack`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | Yes | Stack name — becomes the stack ID (e.g., `fix-auth-bug`) |
| `projectDir` | Yes | Absolute path to the project directory |
| `ticket` | No | Associated ticket ID (e.g., `PROJ-123`) |
| `branch` | No | Git branch name (defaults to stack name). **NEVER set to `main`.** |
| `description` | No | Short description of the work |
| `runtime` | No | `docker` (default) or `podman` |
| `task` | No | Task to dispatch immediately after creation. **When working on a GitHub issue, this MUST be the verbatim issue body — never a summary or rewrite.** |

The stack builds in the background. Use `get_task_status` or `list_stacks` to check when it's ready.

### `dispatch_task`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `stackId` | Yes | Target stack ID |
| `prompt` | Yes | Task description for inner Claude. **When working on a GitHub issue, this MUST be the verbatim issue body.** |

**Write goal-oriented prompts.** Describe WHAT to achieve, not HOW. The inner Claude has the full repo context.

**When dispatching for a GitHub issue:** Pass the issue body verbatim. Do not summarize, rewrite, or add implementation details.

**For follow-up tasks** (not initial issue dispatch): goal-oriented prompts are fine.

**Good follow-up:** "Looks good but add limit/offset params to the list endpoint"

**Bad initial dispatch:** Rewriting "Fix auth bug" into "Open src/auth.ts, find line 42, change the catch block..."

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
- **Verbatim issue dispatch.** When dispatching work for a GitHub issue, pass the issue body verbatim as the task prompt. Never summarize, rewrite, add file paths, class names, or implementation steps that aren't in the issue. If the user's instructions differ from the issue, update the issue first, then dispatch.
- **Stacks appear in the UI.** Because MCP tools go through the Electron control plane, every stack you create will be visible in the Sandstorm Desktop UI.
- **NEVER use `main` as the branch.** Omit the branch parameter so stacks always work on feature branches.
- **NEVER tear down stacks** unless the user explicitly requests it. No automatic cleanup.
- **Always create PRs.** After `push_stack`, use `gh pr create` to open a pull request.
