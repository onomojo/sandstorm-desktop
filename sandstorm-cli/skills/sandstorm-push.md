---
name: sandstorm-push
description: Commit, push, and create a PR from a Sandstorm stack to the remote git repository.
trigger: when the user wants to push changes, commit and push, save work from a stack, create a PR, or publish changes to github
---

# Sandstorm Push

Commit all uncommitted changes, push the branch, and create a PR back to main.

## Command

```bash
sandstorm push <stack_id> ["commit message"] [--force]
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<stack_id>` | Yes | Stack to push from |
| `"commit message"` | No | Custom message (default: "Changes from Sandstorm stack <id>") |
| `--force` | No | Override ticket safety checks and branch drift warnings |

## Prerequisites

- `GITHUB_TOKEN` environment variable must be set (or `gh auth token` must work)
- Stack must have uncommitted changes (otherwise nothing to push)

## Usage patterns

**Push and create PR:**
```bash
sandstorm push fix-auth-bug "Fix authentication token expiry"
```

**Force push (skip safety checks):**
```bash
sandstorm push fix-auth-bug "Emergency fix" --force
```

## Before pushing

**Always review the diff first:**
```bash
sandstorm diff <stack_id>
```

## What happens

1. GitHub token is injected into the container's git remote
2. Protected files (e.g., `CLAUDE.md`) are restored from git
3. All changes are staged (`git add -A`)
4. Commit is created with the message
5. Branch is pushed to remote
6. A PR is created back to `main` (via `gh pr create`)
7. Token is removed from remote URL
8. Registry status updated to "pr-created"

## Ticket safety

If `TICKET_PREFIX` is configured in `.sandstorm/config`:
- The branch name must contain the registered ticket (e.g., `PROJ-123`)
- Use `--force` to override this check

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| "GITHUB_TOKEN not set" | No git credentials | Set `GITHUB_TOKEN` or run `gh auth login` |
| "Ticket mismatch" | Branch doesn't match registered ticket | Use `--force` or fix the branch name |
| "Nothing to commit" | No changes in workspace | Check `sandstorm diff <id>` |
| "PR already exists" | A PR for this branch already exists | This is informational — the push still succeeded |
