---
name: sandstorm-push
description: Commit and push code changes from a Sandstorm stack to the remote git repository.
trigger: when the user wants to push changes, commit and push, save work from a stack, or publish changes to github
---

# Sandstorm Push / Publish

Commit and push changes from a stack workspace to the remote repository.

## Commands

### Push (existing branch)
```bash
sandstorm push <stack_id> ["commit message"] [--force]
```

### Publish (new branch)
```bash
sandstorm publish <stack_id> <branch_name> ["commit message"] [--force]
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<stack_id>` | Yes | Stack to push from |
| `"commit message"` | No | Custom message (default: "Changes from Sandstorm stack <id>") |
| `--force` | No | Override ticket safety checks |
| `<branch_name>` | Yes (publish only) | New branch name to create |

## When to use which

- **`push`** — Stack is already on the right branch (e.g., created with `--branch`)
- **`publish`** — Work was done on main/default branch and needs a feature branch

## Prerequisites

- `GITHUB_TOKEN` environment variable must be set (or `gh auth token` must work)
- Stack must have uncommitted changes (otherwise nothing to push)

## Usage patterns

**Push to current branch:**
```bash
sandstorm push 1 "Fix authentication token expiry"
```

**Create new branch and push:**
```bash
sandstorm publish 1 feature/auth-fix "Fix authentication token expiry"
```

**Force push (skip ticket check):**
```bash
sandstorm push 1 "Emergency fix" --force
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
5. Changes are pushed to remote
6. Token is removed from remote URL
7. Registry status updated to "pushed" / "published"

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
