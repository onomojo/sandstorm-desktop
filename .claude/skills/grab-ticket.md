---
name: grab-ticket
description: Fetch a ticket by number, read it, create a stack, and dispatch the work.
trigger: when the user says to grab a ticket, start an issue, work on issue #N, or pick up a ticket
user_invocable: true
---

# Grab Ticket

Fetch a ticket, spin up a Sandstorm stack for it, and dispatch the task.

## Step 1: Fetch the ticket

Run the project's fetch-ticket script:

```bash
.sandstorm/scripts/fetch-ticket.sh <TICKET_ID>
```

If the script doesn't exist, inform the user: "No fetch-ticket script configured. Run `sandstorm init` to set up a ticket provider, or create `.sandstorm/scripts/fetch-ticket.sh` manually."

Read the ticket title, body, labels, and any comments. Understand what needs to be done.

## Step 2: Mark ticket as started

Run the project's start-ticket script:

```bash
.sandstorm/scripts/start-ticket.sh <TICKET_ID>
```

If the script doesn't exist or fails, skip this step silently — it's optional.

## Step 3: Derive a stack ID

Turn the ticket title into a short kebab-case identifier prefixed with the ticket ID, suitable for a branch name. Examples:
- "Fix auth token refresh" → `issue-42-fix-auth-token-refresh`
- "Add dark mode toggle" → `issue-15-add-dark-mode-toggle`

## Step 4: Create the stack

Use the MCP tool to create the stack. Do NOT pass a `branch` parameter — it defaults to the stack name, which becomes the feature branch.

**NEVER pass `branch: "main"`.**

```
mcp__sandstorm-tools__create_stack({
  name: "<stack_id>",
  projectDir: "/path/to/project",
  ticket: "<TICKET_ID>"
})
```

Use `mcp__sandstorm-tools__get_task_status` to check when the stack is ready.

## Step 5: Dispatch the task

Use the MCP tool to send the ticket description as the task prompt. Include key details from the ticket body so the inner Claude has full context.

```
mcp__sandstorm-tools__dispatch_task({
  stackId: "<stack_id>",
  prompt: "<goal-oriented task description based on the ticket>"
})
```

## Step 6: Confirm

Report back to the user:
- Ticket ID and title
- Stack ID created
- Task dispatched

## Step 7: After push, create a PR

After the work is done and pushed, create a pull request using the project's create-pr script:

```bash
.sandstorm/scripts/create-pr.sh --title "<short title>" --body "Fixes #<TICKET_ID>"
```

If the script doesn't exist, inform the user: "No create-pr script configured. Run `sandstorm init` to set up a ticket provider, or create `.sandstorm/scripts/create-pr.sh` manually."

## Notes

- If the user says "grab tickets #1 through #5", repeat steps 1-5 for each ticket in parallel (one stack per ticket).
- If the ticket lacks enough detail to dispatch, ask the user for clarification before dispatching.
- Always fetch the ticket fresh — don't rely on cached or remembered ticket content.
- **NEVER pass `branch: "main"`.** Omit the branch parameter so stacks always work on feature branches.
- **NEVER tear down stacks** unless the user explicitly requests it.
