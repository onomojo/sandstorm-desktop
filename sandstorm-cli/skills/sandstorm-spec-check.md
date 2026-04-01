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

3. **Evaluate each criterion** from the quality gate against the ticket body:
   - For each criterion, determine **PASS** or **FAIL**
   - If FAIL, explain specifically what's missing or unclear
   - Be strict — if you'd have to guess, it's a FAIL

4. **List assumptions**: Regardless of pass/fail, list every assumption you (as the agent) would make if you started this task right now. These are things not explicitly stated in the ticket that you'd have to infer.

5. **Report results** in this format:

```
## Spec Quality Gate: [PASS/FAIL]

### Results
| Criterion | Result | Notes |
|-----------|--------|-------|
| Problem Statement | PASS/FAIL | ... |
| Current vs Desired Behavior | PASS/FAIL | ... |
| ... | ... | ... |

### Gaps (if any)
- [ ] Specific gap 1 — what needs to be clarified
- [ ] Specific gap 2 — what needs to be clarified

### Assumptions
- Assumption 1
- Assumption 2
- ...
```

6. **If PASS**: Ask the user if the assumptions look correct and if they want to proceed with dispatch.

7. **If FAIL**: Suggest the user run `/spec-refine <issue>` to enter the interactive refinement loop, or manually update the ticket to address the gaps.
