---
name: grab-ticket
description: Fetch a GitHub issue by number, read it, create a stack, and dispatch the work.
trigger: when the user says to grab a ticket, start an issue, work on issue #N, or pick up a ticket
user_invocable: true
---

# Grab Ticket

Fetch a GitHub issue, spin up a Sandstorm stack for it, and dispatch the task.

## Step 1: Fetch the issue

```bash
gh issue view <NUMBER> -R onomojo/sandstorm-desktop
```

Read the issue title, body, labels, and any comments. Understand what needs to be done.

## Step 2: Derive a stack ID

Turn the issue title into a short kebab-case identifier prefixed with the issue number, suitable for a branch name. Examples:
- "Fix auth token refresh" → `issue-42-fix-auth-token-refresh`
- "Add dark mode toggle" → `issue-15-add-dark-mode-toggle`

## Step 3: Create the stack

Use the MCP tool to create the stack. Do NOT pass a `branch` parameter — it defaults to the stack name, which becomes the feature branch.

**NEVER pass `branch: "main"`.**

```
mcp__sandstorm-tools__create_stack({
  name: "<stack_id>",
  projectDir: "/path/to/project",
  ticket: "<NUMBER>"
})
```

Use `mcp__sandstorm-tools__get_task_status` to check when the stack is ready.

## Step 4: Dispatch the task

Use the MCP tool to send the issue description as the task prompt. Include key details from the issue body so the inner Claude has full context.

```
mcp__sandstorm-tools__dispatch_task({
  stackId: "<stack_id>",
  prompt: "<goal-oriented task description based on the issue>"
})
```

## Step 5: Confirm

Report back to the user:
- Issue number and title
- Stack ID created
- Task dispatched

## Step 6: After push, create a PR

After the work is done and pushed, create a pull request:

```bash
gh pr create --title "<short title>" --body "Fixes #<NUMBER>"
```

## Notes

- If the user says "grab tickets #1 through #5", repeat steps 1-4 for each issue in parallel (one stack per issue).
- If the issue lacks enough detail to dispatch, ask the user for clarification before dispatching.
- Always fetch the issue fresh — don't rely on cached or remembered issue content.
- **NEVER pass `branch: "main"`.** Omit the branch parameter so stacks always work on feature branches.
- **NEVER tear down stacks** unless the user explicitly requests it.
