---
name: stack-pr
description: "Use this skill whenever the user wants to record/link/associate a pull request with an existing Sandstorm stack. Trigger phrases include: 'record PR #N for stack X', 'set PR for stack X to #N', 'link PR https://github.com/.../pull/N to stack X', 'save the PR info on stack X', 'stack X's PR is #N'. Use this after a PR has been opened externally (via gh CLI, the GitHub UI, or push_stack's downstream flow) and the user wants the Sandstorm registry to know about it — the stack status flips to pr_created and the URL/number are stored. Do NOT trigger for: creating the PR itself (that's a separate gh CLI / push flow), tearing down the stack, checking stack status, or unrelated PR operations like merging or closing."
---

# /stack-pr

Extract from the user's message:
- The stack ID
- The PR number (integer)
- The PR URL (full https URL)

Then run the script exactly once:

```bash
bash "$SANDSTORM_SKILLS_DIR/stack-pr/scripts/set-pr.sh" <stack-id> <pr-number> <pr-url>
```

The script prints `OK id=<stack> pr=<number>` on success or `ERROR <reason>` on failure. Relay the line.

If any of the three inputs is missing from the user's message, ask the user for it — do NOT guess or look it up. Do not call the `set_pr` MCP tool directly.
