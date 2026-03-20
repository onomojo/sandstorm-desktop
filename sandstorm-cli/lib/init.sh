#!/bin/bash
#
# Sandstorm init — scaffold .sandstorm/ configuration for a new project.
#
# Reads the project's docker-compose.yml to extract port mappings, then
# generates a minimal override compose that adds a Claude workspace container
# and remaps host ports by stack ID. All project services run untouched.
#
# This file is sourced by bin/sandstorm when `sandstorm init` is invoked.
# It expects SANDSTORM_DIR to be set by the caller.
#

PROJECT_ROOT="$(pwd)"
SANDSTORM_CONFIG_DIR="$PROJECT_ROOT/.sandstorm"

# ---------------------------------------------------------------------------
# Abort if already initialized
# ---------------------------------------------------------------------------
if [ -f "$SANDSTORM_CONFIG_DIR/config" ]; then
  echo "Sandstorm is already initialized in this project."
  echo "  Config:  .sandstorm/config"
  echo "  Compose: .sandstorm/docker-compose.yml"
  echo ""
  echo "To re-initialize, remove .sandstorm/ and run again."
  exit 1
fi

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------
COMPOSE_FILE=""
SKIP_PROMPT=false

shift  # remove "init" from args

while [ $# -gt 0 ]; do
  case "$1" in
    --compose)   COMPOSE_FILE="$2"; shift 2 ;;
    -y|--yes)    SKIP_PROMPT=true; shift ;;
    -h|--help)
      echo "Usage: sandstorm init [options]"
      echo ""
      echo "Options:"
      echo "  --compose FILE       Docker compose file (default: docker-compose.yml)"
      echo "  -y, --yes            Skip confirmation prompt"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Run 'sandstorm init --help' for usage." >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Find project docker-compose.yml
# ---------------------------------------------------------------------------
if [ -n "$COMPOSE_FILE" ]; then
  if [ ! -f "$PROJECT_ROOT/$COMPOSE_FILE" ]; then
    echo "Error: Compose file not found: $COMPOSE_FILE" >&2
    exit 1
  fi
else
  for candidate in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
    if [ -f "$PROJECT_ROOT/$candidate" ]; then
      COMPOSE_FILE="$candidate"
      break
    fi
  done
fi

if [ -z "$COMPOSE_FILE" ]; then
  echo "Error: No docker-compose.yml found in this project." >&2
  echo "Sandstorm init requires an existing docker-compose file to work from." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Parse compose file — extract service names and port mappings
# ---------------------------------------------------------------------------
echo "Reading ${COMPOSE_FILE}..."

COMPOSE_JSON=$(docker compose -f "$PROJECT_ROOT/$COMPOSE_FILE" config --format json 2>/dev/null)

if [ -z "$COMPOSE_JSON" ]; then
  echo "Error: Failed to parse ${COMPOSE_FILE}." >&2
  echo "Make sure Docker is running and the compose file is valid." >&2
  exit 1
fi

# Extract service names and ports
ANALYSIS=$(echo "$COMPOSE_JSON" | python3 -c "
import json, sys

config = json.load(sys.stdin)
services = config.get('services', {})

for name, svc in services.items():
    ports = svc.get('ports', [])
    port_entries = []
    for p in ports:
        if isinstance(p, dict):
            host = p.get('published', '')
            container = p.get('target', '')
            if host and container:
                port_entries.append(f'{host}:{container}')
        elif isinstance(p, str):
            port_entries.append(p)
    port_str = ','.join(port_entries) if port_entries else ''
    print(f'{name}|{port_str}')
")

if [ -z "$ANALYSIS" ]; then
  echo "Error: No services found in ${COMPOSE_FILE}." >&2
  exit 1
fi

# Parse into arrays
ALL_SERVICES=""
while IFS='|' read -r name ports; do
  [ -z "$name" ] && continue
  if [ -n "$ALL_SERVICES" ]; then
    ALL_SERVICES="${ALL_SERVICES}
${name}"
  else
    ALL_SERVICES="${name}"
  fi
done <<< "$ANALYSIS"

# Lookup ports for a service from ANALYSIS
svc_ports() {
  echo "$ANALYSIS" | while IFS='|' read -r name ports; do
    if [ "$name" = "$1" ]; then echo "$ports"; fi
  done
}

# Derive project name
PROJECT_NAME=$(basename "$PROJECT_ROOT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g')

# ---------------------------------------------------------------------------
# Show plan
# ---------------------------------------------------------------------------
echo ""
echo "Sandstorm — Project Initialization"
echo "==================================="
echo ""
echo "  Project: ${PROJECT_NAME}"
echo "  Compose: ${COMPOSE_FILE}"
echo ""
echo "  All project services will run alongside Claude:"
while IFS= read -r svc; do
  echo "    - ${svc}"
done <<< "$ALL_SERVICES"
echo "    + claude (sandstorm workspace)"
echo ""

if [ "$SKIP_PROMPT" != "true" ]; then
  read -rp "Continue? [Y/n] " CONFIRM
  CONFIRM="${CONFIRM:-Y}"
  if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Create directory structure
# ---------------------------------------------------------------------------
mkdir -p "$SANDSTORM_CONFIG_DIR/stacks"

# ---------------------------------------------------------------------------
# Build PORT_MAP
# ---------------------------------------------------------------------------
PORT_MAP=""
for svc_name in $(echo "$ALL_SERVICES"); do
  local_ports="$(svc_ports "$svc_name")"
  if [ -n "$local_ports" ]; then
    IFS=',' read -ra PORT_PAIRS <<< "$local_ports"
    idx=0
    for pair in "${PORT_PAIRS[@]}"; do
      host_port="${pair%%:*}"
      container_port="${pair#*:}"
      if [ -n "$PORT_MAP" ]; then
        PORT_MAP="${PORT_MAP},${svc_name}:${host_port}:${container_port}:${idx}"
      else
        PORT_MAP="${svc_name}:${host_port}:${container_port}:${idx}"
      fi
      idx=$((idx + 1))
    done
  fi
done

# ---------------------------------------------------------------------------
# Generate .sandstorm/config
# ---------------------------------------------------------------------------
cat > "$SANDSTORM_CONFIG_DIR/config" << EOF
# Sandstorm project configuration
# Generated from: ${COMPOSE_FILE}

# Project name (used in stack naming: sandstorm-<project>-<id>)
PROJECT_NAME=${PROJECT_NAME}

# Project's docker-compose file
COMPOSE_FILE=${COMPOSE_FILE}

# Port mappings — service:host_port:container_port:index (comma-separated)
# Host ports are remapped by adding (stack_id * PORT_OFFSET) at runtime
PORT_MAP=${PORT_MAP}

# Port offset multiplier per stack (default: 10)
# Stack 1 gets +10, stack 2 gets +20, etc.
PORT_OFFSET=10

# Optional: ticket prefix for branch safety checks (e.g., PROJ)
# TICKET_PREFIX=

# Optional: files to restore before push (prevents container edits to these)
# PROTECTED_FILES=CLAUDE.md
EOF

echo "  Created .sandstorm/config"

# ---------------------------------------------------------------------------
# Generate .sandstorm/docker-compose.yml
# ---------------------------------------------------------------------------
# Detect which services have build: directives (these need explicit image names)
BUILT_SERVICES=$(echo "$COMPOSE_JSON" | python3 -c "
import json, sys
config = json.load(sys.stdin)
for name, svc in config.get('services', {}).items():
    if 'build' in svc:
        print(name)
")

{
  cat << 'HEADER'
# Sandstorm stack override — adds Claude workspace + remaps ports.
#
# All project services run untouched from the project's docker-compose.yml.
# Bind mounts resolve to the workspace clone (not the host project).
# Port mappings are offset by stack ID to avoid conflicts.
#
# Image names are pinned to sandstorm-<project>-<service> so all stacks
# share the same images. Rebuild once, all stacks inherit the update.
#
# Do not run standalone. Sandstorm chains it automatically.

HEADER

  echo "services:"

  # Port remapping + shared image names for each service
  while IFS= read -r svc; do
    [ -z "$svc" ] && continue
    local_ports="$(svc_ports "$svc")"
    is_built=$(echo "$BUILT_SERVICES" | grep -qx "$svc" && echo "yes" || echo "no")

    # Only emit a service block if it has ports to remap or needs an image pin
    if [ -n "$local_ports" ] || [ "$is_built" = "yes" ]; then
      echo "  ${svc}:"
      # Pin image name so all stacks share the same built image
      if [ "$is_built" = "yes" ]; then
        echo "    image: sandstorm-${PROJECT_NAME}-${svc}"
      fi
      if [ -n "$local_ports" ]; then
        echo "    ports: !override"
        IFS=',' read -ra PORT_PAIRS <<< "$local_ports"
        idx=0
        for pair in "${PORT_PAIRS[@]}"; do
          container_port="${pair#*:}"
          echo "      - \"\${SANDSTORM_PORT_${svc}_${idx}}:${container_port}\""
          idx=$((idx + 1))
        done
      fi
    fi
  done <<< "$ALL_SERVICES"

  # Claude workspace service (shared image across all stacks)
  cat << CLAUDE
  claude:
    image: sandstorm-${PROJECT_NAME}-claude
    build:
      context: \${SANDSTORM_DIR}
      dockerfile: docker/Dockerfile
    environment:
      - GIT_USER_NAME
      - GIT_USER_EMAIL
      - SANDSTORM_PROJECT
      - SANDSTORM_STACK_ID
    volumes:
      - \${SANDSTORM_WORKSPACE}:/app
      - /var/run/docker.sock:/var/run/docker.sock
    healthcheck:
      test: ["CMD", "test", "-f", "/app/.sandstorm-ready"]
      interval: 3s
      timeout: 2s
      retries: 60
    tty: true
    stdin_open: true
CLAUDE
} > "$SANDSTORM_CONFIG_DIR/docker-compose.yml"

echo "  Created .sandstorm/docker-compose.yml"

# ---------------------------------------------------------------------------
# Update .gitignore
# ---------------------------------------------------------------------------
GITIGNORE="$PROJECT_ROOT/.gitignore"

add_gitignore_entry() {
  local entry="$1"
  if [ -f "$GITIGNORE" ]; then
    if ! grep -qxF "$entry" "$GITIGNORE" 2>/dev/null; then
      echo "$entry" >> "$GITIGNORE"
      return 0
    fi
    return 1
  else
    echo "$entry" >> "$GITIGNORE"
    return 0
  fi
}

GITIGNORE_ADDED=false

if [ ! -f "$GITIGNORE" ] || ! grep -q "# Sandstorm" "$GITIGNORE" 2>/dev/null; then
  echo "" >> "$GITIGNORE"
  echo "# Sandstorm" >> "$GITIGNORE"
  GITIGNORE_ADDED=true
fi

add_gitignore_entry ".sandstorm/stacks/" && GITIGNORE_ADDED=true
add_gitignore_entry ".sandstorm/config" && GITIGNORE_ADDED=true
add_gitignore_entry ".sandstorm/workspaces/" && GITIGNORE_ADDED=true

if [ "$GITIGNORE_ADDED" = true ]; then
  echo "  Updated .gitignore"
else
  echo "  .gitignore already up to date"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "Sandstorm initialized!"
echo ""
echo "Ready to go:"
echo ""
echo "  sandstorm up 1"
