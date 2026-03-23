---
name: sandstorm-teardown
description: Tear down a Sandstorm stack, stopping containers and cleaning up workspace files.
trigger: when the user wants to tear down a stack, destroy a stack, remove a stack, or clean up a stack
---

# Sandstorm Teardown

Tear down a stack completely — stops containers, removes workspace, archives registry.

## Command

```bash
sandstorm down <stack_id>
```

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<stack_id>` | Yes | Stack to tear down |

## What it does

1. Stops all Docker containers: `docker compose down -v`
2. Removes the workspace directory `.sandstorm/workspaces/<stack_id>/`
3. Archives the registry file to `.sandstorm/stacks/archive/<stack_id>_TIMESTAMP.json`

## Before tearing down

**Always check for unpushed changes first:**
```bash
sandstorm diff <stack_id>
```

If there are changes worth keeping:
```bash
sandstorm push <stack_id> "Save work before teardown"
```
This will commit, push the branch, and create a PR back to main.

## Usage

```bash
sandstorm down 1
```

## Cleaning up stale stacks

Before creating new stacks, clean up old ones:
```bash
sandstorm status          # See all stacks
sandstorm down 1          # Tear down stale stack
```

## Important notes

- This is **irreversible** — the workspace clone is deleted
- Unpushed changes will be lost
- The registry entry is archived (not deleted) for history
- Always ask the user before tearing down stacks with unpushed work
