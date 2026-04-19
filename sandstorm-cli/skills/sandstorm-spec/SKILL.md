---
name: sandstorm-spec
description: "Use this skill whenever the user wants to run the Sandstorm spec quality gate on a ticket, check whether a ticket is ready for agent dispatch, or iterate on a ticket that failed the gate. Trigger phrases include: 'run spec check on ticket N', '/spec-check N', 'is ticket 123 ready', 'check the spec for 178', 'refine the spec for N with these answers', 'here are my answers: ...', 'add my answers and re-check ticket N', 'iterate on the gaps for 42'. This skill wraps the spec_check and spec_refine workflows with a single deterministic script so the orchestrator doesn't have to carry the evaluation logic in its own context. Prefer this skill over the generic sandstorm skill whenever the user's intent is spec-gate evaluation or refinement on a named ticket. Do NOT trigger for: dispatching tasks, creating stacks, reviewing code diffs, or any workflow that isn't specifically about running the spec quality gate."
---

# /sandstorm-spec

Wraps the Sandstorm spec quality gate (`spec_check` and `spec_refine`) behind a single script. Two subcommands.

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

The script prints a JSON payload from the underlying spec agent. Relay its key fields to the user:

- If `passed: true` → report "spec gate passed" and stop.
- If `passed: false` with `questions` → present the questions to the user and wait for their reply. On the reply, invoke `refine`.
- If the script prints an error line starting with `ERROR`, relay the error.

## Hard rules

- **NEVER call the `spec_check` or `spec_refine` MCP tools directly.** This skill is the only path.
- **NEVER edit the ticket yourself.** The spec agent inside the script handles updates.
- **One script invocation per user message.** Do not re-run without user input.
