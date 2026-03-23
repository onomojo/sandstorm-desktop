---
name: sandstorm-init
description: Initialize Sandstorm in a project directory. Sets up .sandstorm/ config, docker-compose override, and gitignore entries.
trigger: when the user wants to initialize sandstorm in a project, set up sandstorm, or prepare a project for sandstorm stacks
---

# Sandstorm Init

Initialize Sandstorm in a project that has a `docker-compose.yml`.

## Command

```bash
sandstorm init [--compose FILE] [-y] [-h]
```

## Arguments

| Flag | Description |
|------|-------------|
| `--compose FILE` | Path to docker-compose file (auto-detects `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, `compose.yaml`) |
| `-y, --yes` | Skip confirmation prompt |
| `-h, --help` | Show help |

## What it does

1. Validates the project isn't already initialized (checks for `.sandstorm/config`)
2. Parses `docker-compose.yml` to extract service names and port mappings
3. Creates `.sandstorm/config` with `PROJECT_NAME`, `COMPOSE_FILE`, `PORT_MAP`, `PORT_OFFSET`
4. Creates `.sandstorm/docker-compose.yml` override with port remapping and Claude workspace service
5. Updates `.gitignore` to exclude `.sandstorm/stacks/`, `.sandstorm/config`, `.sandstorm/workspaces/`

## Prerequisites

- Project must have a `docker-compose.yml` (or variant)
- Project must be a git repository
- Docker and `docker compose` must be available

## Usage

For the outer Claude (orchestrator):
```bash
cd /path/to/project
sandstorm init -y
```

For the Electron desktop app:
```bash
sandstorm init -y --compose docker-compose.yml
```

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| "Already initialized" | `.sandstorm/config` exists | Remove `.sandstorm/` to re-initialize |
| "No docker-compose file found" | Missing compose file | Create one or use `--compose` to point to it |
| "No services found" | Empty or invalid compose file | Fix the compose file |

## After initialization

The project is ready for `sandstorm up <id>` to create stacks.
