---
name: sandstorm-spec
description: "Use this skill whenever the user wants to run the Sandstorm spec quality gate on a ticket or iterate on a ticket that failed the gate. Trigger phrases include: 'run spec check on ticket N', '/spec-check N', 'is ticket 123 ready', 'check the spec for 178', 'refine the spec for N with these answers', 'here are my answers', 'iterate on the gaps for 42', 'let's spec out ticket 42', 'help me spec this out better', 'is N gate-ready'. This skill wraps the spec quality gate in a deterministic script that auto-trims its output (no embedded ticket body) and short-circuits on already-gate-ready tickets via a spec-ready:sha-<hash> label. Prefer this skill whenever the user's intent is spec-gate evaluation or refinement on a named ticket. Do NOT trigger for: starting/dispatching a ticket (that's sandstorm-dispatch), the full spec+dispatch compound (that's spec-and-dispatch), reviewing code diffs, or anything that isn't specifically about the spec quality gate."
---

# /sandstorm-spec

Wraps the Sandstorm spec quality gate behind a single script. Two subcommands.

## Identify the subcommand from the user's message

**Use `check`** when the user is asking whether a ticket is ready, running a fresh spec check, or there's no prior question-and-answer context in this conversation.

**Use `refine`** when the user is providing answers to gaps that were surfaced by a previous check. Look for cues like "here are my answers," "the answers are," or a direct reply to a gap question you just surfaced.

## Run the script exactly once per turn

For `check`:
```bash
bash "$SANDSTORM_SKILLS_DIR/sandstorm-spec/scripts/sandstorm-spec.sh" check <ticket-id>
```

For `refine` (user's answers piped verbatim on stdin):
```bash
echo "<user's answers verbatim>" | bash "$SANDSTORM_SKILLS_DIR/sandstorm-spec/scripts/sandstorm-spec.sh" refine <ticket-id>
```

## Output shape (trimmed — #312)

The script emits a single JSON line on stdout. It does NOT include the full rendered ticket body — that rode in context forever across sub-turns and was the dominant bloat source. If you need the body, use `.sandstorm/scripts/fetch-ticket.sh <id>` (cheap, deterministic).

```json
{
  "passed": true | false,
  "gate_summary": "Gate=PASS, questions=0",
  "questions": [...]            // empty array when passed
  "ticket_url": "https://...",
  "cached": false               // true when the idempotency short-circuit fired
}
```

### Relaying to the user

- If `passed: true` → report "Gate passed" + the ticket URL. Stop.
- If `passed: true` and `cached: true` → report "Gate already passed — no re-evaluation needed." Stop.
- If `passed: false` with `questions` → present the questions verbatim to the user and wait for their reply. On reply, invoke `refine`.
- If `error` field present → relay the error and stop.

## Idempotency (#312)

On a successful PASS, the script tags the ticket with a `spec-ready:sha-<12-char-hash>` label. Subsequent `check` invocations on an unchanged body short-circuit immediately with `{passed: true, cached: true}` — no LLM call, no bridge call, ~200 B of output.

Behavior:
- `check` respects the cached label (fast path).
- `refine` always runs the LLM (user-initiated intent means they want re-evaluation).

If you suspect the cache is wrong, ask the user to edit the ticket body — any change invalidates the label's hash.

## Hard rules

- **One script invocation per user message.** Do not re-run without new user input.
- **Never edit the ticket yourself.** The underlying spec agent handles body updates on refine. Your job is to surface questions and relay answers.
- **Don't ask about other tickets in the same turn.** One ticket ID per invocation.
