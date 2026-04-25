---
name: spec-check
description: Run the spec quality gate against a ticket to check readiness for agent dispatch
user_invocable: true
---

# /spec-check <issue>

Run the spec quality gate against a ticket. Returns pass/fail with specific gaps listed.

## Instructions

1. **Fetch the ticket**: Run the project's fetch-ticket script to get the ticket content:

   ```bash
   .sandstorm/scripts/fetch-ticket.sh <ticket-id>
   ```

   If the script doesn't exist, inform the user: "No fetch-ticket script configured. Run `sandstorm init` to set up a ticket provider, or create `.sandstorm/scripts/fetch-ticket.sh` manually."

2. **Load the quality gate**: Read `.sandstorm/spec-quality-gate.md` from the project directory. If it doesn't exist, inform the user they need to run `sandstorm init` or open the project in Sandstorm Desktop first.

3. **Phase 1 — Resolve assumptions**: Before evaluating pass/fail, identify every assumption in the ticket (explicit "Assumes..." statements AND implicit assumptions you would make).

   For each assumption, classify it:
   - **Self-resolvable**: Can be validated by reading code, checking APIs, schemas, or running commands. Attempt to validate it — read the relevant files, check the interfaces, verify the data flow. Replace confirmed assumptions with verified facts (e.g., "Verified: function X returns Y (see src/path/file.ts:42)"). Flag incorrect assumptions with the correct information.
   - **Requires human input**: Business logic context, domain knowledge, behavioral expectations, product direction, edge case decisions. Formulate a specific blocking question.

4. **Phase 2 — Evaluate each criterion** from the quality gate against the ticket body:
   - For each criterion, determine **PASS** or **FAIL**
   - If FAIL, explain specifically what's missing or unclear
   - Be strict — if you'd have to guess, it's a FAIL
   - Apply these enhanced checks:
     - **Assumptions — Zero Unresolved**: FAIL if any assumptions remain unresolved. Listing them is NOT sufficient.
     - **End-to-End Data Flow Verification**: FAIL if the feature spans multiple system boundaries but testability consists entirely of mocked/unit tests.
     - **Dependency Contracts**: FAIL if cross-ticket/module dependencies lack explicit contracts (format, timing, verification). FAIL if read/write timing is incompatible.
     - **Automated Visual Verification**: FAIL if the ticket describes UI changes but has no automated visual verification against the real running app.
     - **All Verification Automatable**: FAIL if any verification item requires manual human intervention or includes skippable checkboxes.

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
