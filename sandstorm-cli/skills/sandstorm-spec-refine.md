---
name: spec-refine
description: Interactive refinement loop — run quality gate, present gaps, ask questions, update ticket until it passes
user_invocable: true
---

# /spec-refine <issue>

Enter the interactive refinement loop for a ticket. Runs the quality gate, presents gaps, asks clarifying questions, updates the ticket, and re-checks until the gate passes.

## Instructions

### Step 1: Fetch and check
1. Use `gh issue view <number>` to get the current issue body
2. Read `.sandstorm/spec-quality-gate.md` for the quality gate criteria
3. Evaluate each criterion (same as `/spec-check`)

### Step 2: If PASS
- Show the results table and assumptions list
- Ask the user: "Gate passes. Here are the assumptions I'd make — approve to proceed with dispatch?"
- If approved, the ticket is ready. Inform the user they can now create a stack for this issue.
- Stop here.

### Step 3: If FAIL — present gaps and ask questions
- Show which criteria failed and why
- For each gap, ask a **specific, answerable question** that would resolve it. Don't ask vague questions — ask exactly what you need to know.
- Wait for the user's answers.

### Step 4: Update the ticket
After the user answers:
1. Incorporate their answers into the issue body
2. Use `gh issue edit <number> --body "..."` to update the ticket with the clarifications
3. Preserve the original content — add clarifications inline or in new sections, don't delete existing content

### Step 5: Re-check
- Re-run the quality gate against the updated ticket
- If PASS → go to Step 2
- If FAIL → go to Step 3
- Continue until the gate passes

### Guidelines
- Be concise with questions — don't over-explain
- Group related gaps into a single question when possible
- A good ticket should pass in seconds — don't make this a chore
- If the user says "skip" or "good enough" for a criterion, note it but respect their judgment
- Maximum 5 refinement iterations. If the gate still hasn't passed after 5 rounds, stop and suggest the user manually edit the ticket
