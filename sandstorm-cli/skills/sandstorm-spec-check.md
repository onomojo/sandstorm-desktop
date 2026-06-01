---
name: spec-check
description: Run the spec quality gate against a ticket to check readiness for agent dispatch
user_invocable: true
---

# /spec-check <issue>

Run the spec quality gate against a ticket. Returns pass/fail with specific gaps listed.

The quality gate criteria are built into Sandstorm Desktop — no per-project
`.sandstorm/spec-quality-gate.md` file is required or read.

## Instructions

1. **Fetch the ticket**: Run the project's fetch-ticket script to get the ticket content:

   ```bash
   .sandstorm/scripts/fetch-ticket.sh <ticket-id>
   ```

   If the script doesn't exist, inform the user: "No fetch-ticket script configured. Run `sandstorm init` to set up a ticket provider, or create `.sandstorm/scripts/fetch-ticket.sh` manually."

2. **Apply the built-in quality gate criteria**: Evaluate the ticket against the built-in criteria below.

3. **Phase 1 — Resolve assumptions**: Before evaluating pass/fail, identify every assumption in the ticket (explicit "Assumes..." statements AND implicit assumptions you would make).

   For each assumption, classify it:
   - **Self-resolvable**: Can be validated by reading code, checking APIs, schemas, or running commands. Attempt to validate it — read the relevant files, check the interfaces, verify the data flow. Replace confirmed assumptions with verified facts (e.g., "Verified: function X returns Y (see src/path/file.ts:42)"). Flag incorrect assumptions with the correct information.
   - **Requires human input**: Business logic context, domain knowledge, behavioral expectations, product direction, edge case decisions. Formulate a specific blocking question.

4. **Phase 2 — Evaluate each criterion** against the ticket body:
   - For each criterion, determine **PASS** or **FAIL**
   - If FAIL, explain specifically what's missing or unclear
   - Be strict — if you'd have to guess, it's a FAIL
   - Apply these checks:
     - **Assumptions — Zero Unresolved**: FAIL if any assumptions remain unresolved. Listing them is NOT sufficient.
     - **Dependency Contracts**: FAIL if cross-ticket/module dependencies lack explicit contracts (format, timing, verification). FAIL if read/write timing is incompatible.
     - **All Verification Automatable**: FAIL if any verification item requires manual human intervention or includes skippable checkboxes.
     - **Testability**: Automated tests are mandatory. Do NOT ask the user what verification is needed — specify Vitest unit/component tests, regression tests, typecheck, build. Do NOT require e2e/Playwright tests (not available in the stack container).

5. **Report results** in this format:

```
## Spec Quality Gate: [PASS/FAIL]

### Assumption Resolution
| # | Assumption | Type | Resolution |
|---|-----------|------|------------|
| 1 | <assumption text> | Self-resolvable / Requires human input | <verified fact OR specific question> |
...

### Results
| Criterion | Result | Notes |
|-----------|--------|-------|
| Problem Statement | PASS/FAIL | ... |
| Current vs Desired Behavior | PASS/FAIL | ... |
| ... | ... | ... |

### Gaps (if any)
- [ ] Specific gap 1 — what needs to be clarified and how to fix it
- [ ] Specific gap 2 — what needs to be clarified and how to fix it

### Questions Requiring User Answers (if any)
1. <specific question from unresolvable assumptions or ambiguities>
2. ...
```

6. **If PASS**: Ask the user if they want to proceed with dispatch.

7. **If FAIL**: Suggest the user run `/spec-refine <issue>` to enter the interactive refinement loop, or manually update the ticket to address the gaps.
