---
name: sandstorm-exec
description: Open a shell or interactive Claude session inside a Sandstorm stack container.
trigger: when the user wants to shell into a stack, debug inside a container, or run interactive claude in a stack
---

# Sandstorm Exec & Claude

Open interactive sessions inside a stack container.

## Commands

### Shell into container
```bash
sandstorm exec <stack_id>
```
Opens a bash shell as the `claude` user inside the stack's Claude container.

### Interactive Claude session
```bash
sandstorm claude <stack_id>
```
Launches Claude Code CLI interactively inside the stack with `--dangerously-skip-permissions`.

## When to use

- **`exec`** — Manual debugging, inspecting files, running one-off commands
- **`claude`** — Interactive pair-programming session with inner Claude

## Important notes

- Both commands are interactive (`-it`) — they require a terminal
- `exec` runs as the `claude` user (not root)
- `claude` syncs OAuth credentials from host before launching
- The working directory inside the container is `/app` (the repo clone)

## For non-interactive commands

If you just need to run a command inside the container without an interactive session:
```bash
docker exec sandstorm-<project>-<stack_id>-claude-1 bash -c 'command here'
```

Or use `sandstorm task` for commands that should be run by the inner Claude agent.
