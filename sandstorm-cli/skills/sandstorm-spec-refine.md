---
name: spec-refine
description: Interactive refinement loop — run quality gate, present gaps, ask questions, update ticket until it passes
user_invocable: true
---

# /spec-refine <issue>

Enter the interactive refinement loop for a ticket. Runs the quality gate, presents gaps, asks clarifying questions, updates the ticket, and re-checks until the gate passes.

## Instructions

### Step 1: Fetch and check
1. Run the project's fetch-ticket script to get the current ticket content:
   ```bash
   .sandstorm/scripts/fetch-ticket.sh <ticket-id>
   ```
   If the script doesn't exist, inform the user: "No fetch-ticket script configured. Run `sandstorm init` to set up a ticket provider, or create `.sandstorm/scripts/fetch-ticket.sh` manually."
2. Read `.sandstorm/spec-quality-gate.md` for the quality gate criteria
3. **Resolve assumptions first**: Identify all assumptions (explicit and implicit). Self-resolvable ones — validate by reading code/APIs/schemas. Replace confirmed assumptions with verified facts. Flag incorrect ones. Unresolvable ones — formulate specific blocking questions.
4. Evaluate each criterion using the enhanced checks:
   - **Zero Unresolved Assumptions**: Listing is not enough — they must be verified or answered.
   - **End-to-End Data Flow**: Multi-boundary features need e2e verification, not just mocked tests.
   - **Dependency Contracts**: Cross-ticket/module references need explicit contracts (format, timing, verification).
   - **Automated Visual Verification**: UI tickets need automated visual checks against the real app.
   - **All Verification Automatable**: No manual steps, no skippable checkboxes.

### Step 2: If PASS
- Show the results table and confirmed assumption resolutions
- Ask the user: "Gate passes. All assumptions have been verified — approve to proceed with dispatch?"
- If approved, the ticket is ready. Inform the user they can now create a stack for this issue.
- Stop here.

### Step 3: If FAIL — present gaps and ask questions
- Show which criteria failed and why
- Show the assumption resolution table — highlight any that are unresolved
- For each gap and unresolved assumption, ask a **specific, answerable question** that would resolve it. Don't ask vague questions — ask exactly what you need to know.
- Wait for the user's answers.

### Step 4: Update the ticket
After the user answers:
1. Incorporate their answers into the ticket body
2. Replace resolved assumptions with verified facts (e.g., "Verified: X returns Y (see src/path.ts:42)")
3. Run the project's update-ticket script to save the changes:
   ```bash
   .sandstorm/scripts/update-ticket.sh <ticket-id> "<updated body>"
   ```
   If the script doesn't exist or fails, show the updated body to the user and ask them to update the ticket manually.
4. Preserve the original content — add clarifications inline or in new sections, don't delete existing content

### Step 5: Re-check
- Re-run the quality gate against the updated ticket (including assumption resolution)
- If PASS → go to Step 2
- If FAIL → go to Step 3
- Continue until the gate passes

### Guidelines
- Be concise with questions — don't over-explain
- Group related gaps into a single question when possible
- A good ticket should pass in seconds — don't make this a chore
- If the user says "skip" or "good enough" for a criterion, note it but respect their judgment
- Maximum 5 refinement iterations. If the gate still hasn't passed after 5 rounds, stop and suggest the user manually edit the ticket
