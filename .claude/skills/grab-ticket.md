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

Turn the issue title into a short kebab-case identifier suitable for a branch name. Examples:
- "Fix auth token refresh" → `fix-auth-token-refresh`
- "Add dark mode toggle" → `add-dark-mode-toggle`

## Step 3: Create the stack

Use the sandstorm-create-stack skill:

```bash
sandstorm up <stack_id> --ticket <NUMBER>
```

Wait for the stack to be ready (`sandstorm status`).

## Step 4: Dispatch the task

Use the sandstorm-dispatch-task skill to send the issue description as the task prompt. Include key details from the issue body so the inner Claude has full context.

## Step 5: Confirm

Report back to the user:
- Issue number and title
- Stack ID created
- Task dispatched

## Notes

- If the user says "grab tickets #1 through #5", repeat steps 1-4 for each issue in parallel (one stack per issue).
- If the issue lacks enough detail to dispatch, ask the user for clarification before dispatching.
- Always fetch the issue fresh — don't rely on cached or remembered issue content.
