---
name: sandstorm-dispatch
description: "Use this skill whenever the user wants to START a named ticket that is ALREADY gate-ready — i.e., fire up a stack and dispatch the ticket's verbatim body as its initial task. Trigger phrases include: 'start ticket N', 'start issue N', 'dispatch ticket N', 'fire up a stack for ticket N', 'let's work on #N', 'kick off ticket 42', 'it's specced out, now ship it', 'the ticket is ready, start the stack'. This skill is STRICTLY GATED on the `spec-ready` label — it will refuse to run if the ticket has not passed the spec quality gate. There is no bypass flag; if the gate hasn't passed, run `sandstorm-spec` first (or `spec-and-dispatch` which does both). Do NOT trigger for: drafting a new ticket (that's `sandstorm-spec` in a future draft mode), refining an existing ticket (that's `sandstorm-spec refine`), the full spec-and-dispatch compound (that's `spec-and-dispatch`), or dispatching follow-up work to an EXISTING stack (that's the `sandstorm` / `check-and-resume-stack` flow)."
---

# /sandstorm-dispatch

Atomic primitive: **given a gate-ready ticket, start a stack.** Zero LLM invocation. Strictly enforces the `spec-ready` label — if the ticket hasn't been through the spec quality gate, this skill refuses with a clear error.

## Extract from the user's message

- **Ticket ID** (required)
- **Stack name** (optional). If missing, ask the user. A good default is derived from the ticket slug (e.g. `fix-auth-bug-28`), but let the user confirm.

## Run the script exactly once per turn

```bash
bash "$SANDSTORM_SKILLS_DIR/sandstorm-dispatch/scripts/dispatch.sh" <ticket-id> --stack-name <stack-name>
```

The script emits a single JSON line on stdout. Relay the key fields to the user.

### Success shape

```json
{"ok": true, "stack_id": "28", "ticket_url": "https://github.com/.../issues/28", "branch": "fix-auth-bug-28"}
```

### Failure shapes

- Gate not passed:
  ```json
  {"error": "NOT_GATE_READY", "ticket_url": "...", "hint": "Run sandstorm-spec.sh check first"}
  ```
  Relay to user: "Ticket N isn't spec-ready yet — run `/sandstorm-spec check N` first, or use `/spec-and-dispatch` to do both."

- Other errors (fetch, create): pass the error message through verbatim.

## Hard rules

- **NO bypass flag.** The `--force` escape hatch was removed on purpose — the outer Claude was skipping the gate roughly half the time, which undermines the Opus-plan-then-Sonnet-execute cost model. If a caller truly needs an un-gated stack, they drop down to the `create_stack` bridge endpoint directly with `forceBypass: true`. That path is explicit, visible, and intentional.
- **One script invocation per user message.** Don't call it twice.
- **Never try to refine the ticket here.** If the gate is missing, stop and tell the user. This skill doesn't loop.
