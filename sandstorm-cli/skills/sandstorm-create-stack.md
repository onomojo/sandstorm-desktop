---
name: sandstorm-create-stack
description: Create and start a new Sandstorm stack with isolated Docker environment, cloned repo, and all services.
trigger: when the user wants to create a stack, start a stack, spin up a stack, or begin work on a task that needs an isolated environment
---

# Sandstorm Create Stack

Create a new isolated Docker stack with a cloned repo and all project services.

## Command

```bash
sandstorm up <stack_id> [--ticket TICKET] [--branch BRANCH]
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<stack_id>` | Yes | Alphanumeric identifier (e.g., `1`, `2`, `fix-auth-bug`) |
| `--ticket TICKET` | No | Associated ticket ID (e.g., `PROJ-123`) |
| `--branch BRANCH` | No | Git branch to checkout (creates if doesn't exist) |

## What it does

1. Clones the project repo to `.sandstorm/workspaces/<stack_id>/`
2. Checks out the specified branch (if provided)
3. Copies `.env*` files from host to workspace
4. Remaps ports: `new_port = original_port + (stack_id_num * PORT_OFFSET)`
5. Runs `docker compose up -d --build`
6. Registers stack in `.sandstorm/stacks/<stack_id>.json`

## Usage patterns

**Simple numbered stack:**
```bash
sandstorm up 1
```

**Stack with ticket and branch:**
```bash
sandstorm up 1 --ticket PROJ-123 --branch feature/auth-fix
```

**Named stack:**
```bash
sandstorm up fix-auth --ticket PROJ-123 --branch fix/auth-bug
```

## Important notes

- The stack builds in the background. Use `sandstorm status` to check when it's ready.
- Build logs go to `/tmp/sandstorm-build-<stack_id>.log`
- Port conflicts happen if two stacks use the same numeric offset. Use unique IDs.
- The workspace is a full git clone from the remote — it has all branches that existed at clone time.
- Clean up stale stacks before creating new ones: `sandstorm status` then `sandstorm down <id>`.

## After creation

The stack is ready for:
- `sandstorm task <id> "prompt"` — dispatch work
- `sandstorm exec <id>` — shell into container
- `sandstorm claude <id>` — interactive Claude session

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| "Stack already exists" | ID already in use | Use `sandstorm down <id>` first or pick a different ID |
| Port conflict | Another stack uses same ports | Use a different stack ID |
| Build failure | Docker build error | Check `sandstorm logs <id>` |
