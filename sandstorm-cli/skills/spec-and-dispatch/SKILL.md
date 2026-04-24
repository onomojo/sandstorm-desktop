---
name: spec-and-dispatch
description: "Use this skill whenever the user wants to take an existing ticket / issue, run the Sandstorm spec quality gate on it, and then (once it passes) create a stack with the ticket's verbatim body as the initial task. Trigger phrases include: 'take ticket N and build it', 'spec and dispatch N', 'fire up a stack for ticket N', 'let's work on #N', 'start issue N in a stack', 'create a stack for issue N, run the gate first'. This skill is the full start-to-dispatch flow for a ticket: fetch ticket → spec_check → (refine loop if needed) → create_stack with gateApproved=true and the ticket body as the initial task. Do NOT trigger for: dispatching follow-up work to an EXISTING stack (that's the sandstorm / check-and-resume flow), running the spec gate in isolation (that's the sandstorm-spec skill), or creating a stack without a ticket."
---

# /spec-and-dispatch

End-to-end flow from a ticket number to a running stack.

## Extract from the user's message

- **Ticket ID** (required)
- **Stack name** (optional — if missing, ask the user. A good default is derived from the ticket slug, e.g. `fix-auth-bug-28`, but let the user confirm.)

## Run the gate first

```bash
bash "$SANDSTORM_SKILLS_DIR/spec-and-dispatch/scripts/spec-and-dispatch.sh" check <ticket-id>
```

The script prints the spec_check result payload. Three outcomes:

1. **Passed** (`passed:true`) → proceed to "Create the stack" below.
2. **Gaps** (`passed:false` with `questions`) → present the questions to the user. On their reply:
   ```bash
   echo "<user's answers verbatim>" | bash "$SANDSTORM_SKILLS_DIR/spec-and-dispatch/scripts/spec-and-dispatch.sh" refine <ticket-id>
   ```
   Loop through questions/answers until `passed:true`.
3. **Error** → relay to the user; stop.

## Create the stack

Once the gate passes, confirm the stack name with the user if you don't already have one. Then:

```bash
bash "$SANDSTORM_SKILLS_DIR/spec-and-dispatch/scripts/spec-and-dispatch.sh" create <ticket-id> <stack-name>
```

The script fetches the ticket body verbatim and dispatches it as the initial task with `gateApproved:true`. No summarization, no rewrite — the ticket is the source of truth per `feedback_pass_issue_verbatim.md`. It prints `OK stack=<name> ticket=<n> task=<task-id>` or `ERROR phase=<where> reason=<...>`.

Relay the result.

## Hard rules

- **Never summarize or rewrite the ticket body.** The script passes it verbatim; don't try to "improve" it.
- **Never set `branch: main`.** Omit the branch arg — it defaults to the stack name.
- **Never skip the gate** by calling `create` before `check` succeeds. The spec-gate pass is the precondition for dispatch.
- **Never call `spec_check`, `spec_refine`, or `create_stack` MCP tools directly.** This skill is the only path for this workflow.
- One ticket per invocation.
