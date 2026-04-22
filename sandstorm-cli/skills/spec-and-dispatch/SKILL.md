---
name: spec-and-dispatch
description: "Use this skill whenever the user wants to take an existing ticket, run the Sandstorm spec quality gate on it, and then (once it passes) fire up a stack to work on it. Trigger phrases include: 'take ticket N and build it', 'spec and dispatch N', 'spec this out and make it happen', 'take this idea and ship it', 'create a stack for issue N, run the gate first', 'let's gate and dispatch N'. This is the compound end-to-end flow: fetch ticket → spec gate → (refine loop if needed) → start stack with verbatim body. Under the hood it delegates to the two atomic primitives — `sandstorm-spec` for the gate loop and `sandstorm-dispatch` for the zero-LLM stack creation — rather than reimplementing either. Do NOT trigger for: running ONLY the gate without dispatching (that's `sandstorm-spec`), starting an already-gate-ready ticket (that's `sandstorm-dispatch`), dispatching follow-up work to an existing stack, or creating a stack without a ticket."
---

# /spec-and-dispatch

End-to-end flow from a ticket number to a running stack. Delegates to the two atomic primitives:

- `sandstorm-spec` — the gate check/refine loop (LLM-backed)
- `sandstorm-dispatch` — pure stack-creation dispatch (zero LLM)

This skill is a thin compound — no duplicate LLM logic, no duplicate tool_result bloat in context.

## Extract from the user's message

- **Ticket ID** (required)
- **Stack name** (optional — if missing, ask the user. A good default is derived from the ticket slug, e.g. `fix-auth-bug-28`, but let the user confirm.)

## Run the gate first

```bash
bash "$SANDSTORM_SKILLS_DIR/spec-and-dispatch/scripts/spec-and-dispatch.sh" check <ticket-id>
```

The script delegates to `sandstorm-spec.sh check`. Three outcomes:

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

The script delegates to `sandstorm-dispatch.sh`, which verifies the `spec-ready` label one more time, fetches the ticket body verbatim, and creates the stack with `gateApproved:true`. It emits a single JSON line:

```json
{"ok": true, "stack_id": "28", "ticket_url": "https://...", "branch": "..."}
```

Relay the stack_id and URL to the user.

## Hard rules

- **Never summarize or rewrite the ticket body.** The scripts pass it verbatim; don't try to "improve" it.
- **Never set `branch: main`.** The dispatch primitive defaults to the stack name.
- **Never call `create` before `check` succeeds.** The dispatch primitive will refuse if the gate hasn't passed; don't try to work around that by calling bridge endpoints directly.
- One ticket per invocation.
