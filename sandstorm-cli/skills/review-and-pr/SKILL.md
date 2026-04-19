---
name: review-and-pr
description: "Use this skill whenever the user is ready to publish the work from an existing Sandstorm stack — reviewing the diff, pushing to its branch, opening a pull request, and recording the PR on the stack. Trigger phrases include: 'make a PR for stack X', 'publish stack X', 'push and PR stack X', 'the diff looks good, ship it', 'open a pull request for stack X', 'finalize stack X', 'commit and push stack X to a PR'. This is the end-of-workflow publish step for a stack that has completed its task and whose diff the user has seen (or is about to see via this skill). Do NOT trigger for: pushing WITHOUT a PR, creating a stack from scratch, dispatching new work, or any workflow where there are no changes to publish. Do NOT trigger if the stack is still running — the skill assumes the task is finished."
---

# /review-and-pr

End-to-end publish flow. Two phases; run them in order.

## Phase 1 — preview

Show the uncommitted changes in the stack so you can craft a meaningful PR title and body:

```bash
bash "$SANDSTORM_SKILLS_DIR/review-and-pr/scripts/review-and-pr.sh" preview <stack-id>
```

The script prints the diff unchanged. Read it. If it's empty (`DIFF_EMPTY`), tell the user there's nothing to publish and stop — do NOT call phase 2.

## Phase 2 — publish

Craft a PR title and body:

- **Title** — short, under ~70 chars, follows the project's recent commit/PR style. If the stack has a ticket number, lead with the ticket context (e.g. "Fix auth token expiry (#28)").
- **Body** — a task-completion summary, per `feedback_pr_descriptions.md`: what was done, why, anything notable. NOT generic boilerplate.

Pipe the body on stdin:

```bash
echo "<PR body text>" | bash "$SANDSTORM_SKILLS_DIR/review-and-pr/scripts/review-and-pr.sh" publish <stack-id> "<PR title>"
```

The script commits + pushes the stack's branch, opens the PR via the project's `.sandstorm/scripts/create-pr.sh`, parses out the PR number and URL, and records them back against the stack via `set_pr`. It prints one line:

`OK stack=<id> pr=<number> url=<url>`

Or on failure: `ERROR phase=<phase> reason=<...>`.

Relay the line to the user.

## Hard rules

- **Never skip phase 1.** The user sees the diff (via your summary) before anything is pushed.
- **Never call `get_diff`, `push_stack`, or `set_pr` MCP tools directly.** This skill is the only path for this workflow.
- **Never pass `main` as a branch name.** Branches default to the stack name; don't override.
- One stack per invocation.
