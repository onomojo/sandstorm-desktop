#!/bin/bash
#
# Sandstorm stack management — isolated Claude Code Docker environments.
#
# This file is sourced by bin/sandstorm when a stack command is invoked.
# It expects SANDSTORM_DIR to be set by the caller.
#

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Project root is where the user invoked sandstorm (current directory)
PROJECT_ROOT="$(pwd)"

# Load project .env (if any)
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
fi

# Load project sandstorm config
if [ -f "$PROJECT_ROOT/.sandstorm/config" ]; then
  set -a
  source "$PROJECT_ROOT/.sandstorm/config"
  set +a
else
  echo "Error: No .sandstorm/config found in ${PROJECT_ROOT}" >&2
  echo "Run 'sandstorm init' to set up this project." >&2
  exit 1
fi

# Resolve the full remote URL (for cloning)
GIT_REMOTE_URL=$(git -C "$PROJECT_ROOT" remote get-url origin 2>/dev/null || true)
if [ -z "$GIT_REMOTE_URL" ]; then
  echo "Error: Could not determine remote URL. Ensure 'origin' remote is set." >&2
  exit 1
fi

# Resolve the git repo slug (e.g., onomojo/examprep — used for GitHub API operations)
GIT_REPO="${REPO:-}"
if [ -z "$GIT_REPO" ]; then
  GIT_REPO=$(echo "$GIT_REMOTE_URL" | sed 's|.*github.com[:/]||' | sed 's|\.git$||' || true)
fi
if [ -z "$GIT_REPO" ]; then
  echo "Error: Could not determine repository. Set REPO in .sandstorm or run from a git repo." >&2
  exit 1
fi

# Capture host git identity
GIT_AUTHOR_NAME=$(git config user.name 2>/dev/null || echo "Developer")
GIT_AUTHOR_EMAIL=$(git config user.email 2>/dev/null || echo "developer@localhost")
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL

# Stack metadata is stored in SQLite by the Sandstorm Desktop app (registry.ts).
# Legacy JSON-based registry functions were removed — see issue #166.

# ---------------------------------------------------------------------------
# Clone helpers
# ---------------------------------------------------------------------------

source "$SANDSTORM_DIR/lib/clone.sh"

# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------
render_dashboard() {
  local ALL_IDS="$1" RUNNING_IDS="$2"
  local ANY_RUNNING=false

  echo "┌───────┬───────────┬──────────────┬──────────────────────────────┬──────────────────────────────┐" >&2
  echo "│ Stack │ Status    │ Ticket       │ Branch                       │ Task                         │" >&2
  echo "├───────┼───────────┼──────────────┼──────────────────────────────┼──────────────────────────────┤" >&2

  for SID in $ALL_IDS; do
    local CNAME="sandstorm-${PROJECT_NAME}-${SID}-claude-1"

    if echo "$RUNNING_IDS" | grep -qw "$SID" 2>/dev/null; then
      if docker exec -u claude "$CNAME" test -f /tmp/claude-task.pid 2>/dev/null; then
        TSTATUS="RUNNING"
        ANY_RUNNING=true
      elif docker exec -u claude "$CNAME" test -f /tmp/claude-task.status 2>/dev/null; then
        TSTATUS=$(docker exec -u claude "$CNAME" cat /tmp/claude-task.status 2>/dev/null | tr '[:lower:]' '[:upper:]')
      else
        TSTATUS="IDLE"
      fi
    else
      TSTATUS=$(registry_read "$SID" "status")
      TSTATUS=$(echo "${TSTATUS:-down}" | tr '[:lower:]' '[:upper:]')
    fi

    local REG_TICKET REG_BRANCH REG_DESC
    REG_TICKET="—"
    REG_BRANCH=$(docker exec -u claude -w /app "$CNAME" git branch --show-current 2>/dev/null || echo "—")
    [ -z "$REG_BRANCH" ] && REG_BRANCH="—"
    REG_DESC="—"

    printf "│ %-5s │ %-9s │ %-12s │ %-28s │ %-28s │\n" \
      "$SID" "$TSTATUS" "${REG_TICKET:0:12}" "${REG_BRANCH:0:28}" "${REG_DESC:0:28}" >&2
  done

  echo "└───────┴───────────┴──────────────┴──────────────────────────────┴──────────────────────────────┘" >&2

  if [ "$ANY_RUNNING" = true ]; then echo "true"; else echo "false"; fi
}

# ---------------------------------------------------------------------------
# OAuth credential management
# ---------------------------------------------------------------------------
get_oauth_credentials() {
  local creds=""
  if command -v security &>/dev/null; then
    creds=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
  fi
  if [ -z "$creds" ] && [ -f "$HOME/.claude/.credentials.json" ]; then
    creds=$(cat "$HOME/.claude/.credentials.json" 2>/dev/null || true)
  fi
  echo "$creds"
}

sync_oauth_to_container() {
  local container="$1"
  local creds
  creds=$(get_oauth_credentials)
  if [ -z "$creds" ]; then
    echo "Warning: No OAuth credentials found. Run 'claude auth login' or '/login' to authenticate."
    return 1
  fi
  echo "$creds" | docker exec -i -u claude "$container" \
    bash -c "mkdir -p ~/.claude && cat > ~/.claude/.credentials.json"
}

# ---------------------------------------------------------------------------
# Resolve GitHub token
# ---------------------------------------------------------------------------
resolve_github_token() {
  if [ -z "$GITHUB_TOKEN" ]; then
    GITHUB_TOKEN=$(gh auth token 2>/dev/null || true)
  fi
  if [ -z "$GITHUB_TOKEN" ]; then
    echo "Error: No GITHUB_TOKEN found."
    echo "Set GITHUB_TOKEN in your environment or authenticate with 'gh auth login'."
    exit 1
  fi
  export GITHUB_TOKEN
}

# ---------------------------------------------------------------------------
# Docker compose helper
# ---------------------------------------------------------------------------
COMMAND="${1:-help}"
STACK_ID="${2:-1}"

# Enforce valid stack IDs (alphanumeric, hyphens, underscores)
if [[ ! "$STACK_ID" =~ ^[a-zA-Z0-9_-]+$ ]] && [[ "$COMMAND" != "status" ]] && [[ "$COMMAND" != "help" ]]; then
  echo "Error: Stack ID must be alphanumeric (e.g., sandstorm up 1 or sandstorm up my-stack)" >&2
  exit 1
fi

# Project name for stack naming (from config or derived from directory)
PROJECT_NAME="${PROJECT_NAME:-$(basename "$PROJECT_ROOT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g')}"
COMPOSE_PROJECT="sandstorm-${PROJECT_NAME}-${STACK_ID}"
CONTAINER_NAME="${COMPOSE_PROJECT}-claude-1"

SANDSTORM_COMPOSE="$PROJECT_ROOT/.sandstorm/docker-compose.yml"
PROJECT_COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"

# Workspace directory — the cloned repo for this stack
WORKSPACE="$PROJECT_ROOT/.sandstorm/workspaces/${STACK_ID}"
WORKSPACE_COMPOSE="$WORKSPACE/$PROJECT_COMPOSE_FILE"

# Verify project sandstorm files exist
if [ ! -f "$SANDSTORM_COMPOSE" ]; then
  echo "Error: No .sandstorm/docker-compose.yml found in ${PROJECT_ROOT}" >&2
  echo "Run 'sandstorm init' to set up this project." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Port remapping — compute host ports offset by stack ID
# ---------------------------------------------------------------------------
PORT_OFFSET="${PORT_OFFSET:-10}"

compute_port_env() {
  if [ -z "${PORT_MAP:-}" ]; then return; fi
  IFS=',' read -ra ENTRIES <<< "$PORT_MAP"
  for entry in "${ENTRIES[@]}"; do
    IFS=':' read -r svc host_port container_port idx <<< "$entry"
    local var_name="SANDSTORM_PORT_${svc}_${idx}"
    # Skip if already set (e.g., by Electron app's PortAllocator)
    if [ -n "${!var_name:-}" ]; then continue; fi
    # Arithmetic offset only works with numeric stack IDs
    if [[ "$STACK_ID" =~ ^[0-9]+$ ]]; then
      local remapped=$((host_port + STACK_ID * PORT_OFFSET))
      export "${var_name}=${remapped}"
    fi
  done
}

print_port_map() {
  if [ -z "${PORT_MAP:-}" ]; then return; fi
  IFS=',' read -ra ENTRIES <<< "$PORT_MAP"
  for entry in "${ENTRIES[@]}"; do
    IFS=':' read -r svc host_port container_port idx <<< "$entry"
    local remapped=$((host_port + STACK_ID * PORT_OFFSET))
    echo "  ${svc}: localhost:${remapped}"
  done
}

compute_port_env

run_compose() {
  # Ensure context dir exists (compose volume mount requires it)
  local context_dir="$PROJECT_ROOT/.sandstorm/context"
  mkdir -p "$context_dir"

  SANDSTORM_DIR="$SANDSTORM_DIR" \
  SANDSTORM_WORKSPACE="$WORKSPACE" \
  SANDSTORM_CONTEXT="$context_dir" \
  SANDSTORM_PROJECT="$COMPOSE_PROJECT" \
  SANDSTORM_STACK_ID="$STACK_ID" \
  GIT_USER_NAME="$GIT_AUTHOR_NAME" \
  GIT_USER_EMAIL="$GIT_AUTHOR_EMAIL" \
  docker compose \
    -f "$WORKSPACE_COMPOSE" \
    -f "$SANDSTORM_COMPOSE" \
    -p "$COMPOSE_PROJECT" \
    "$@"
}


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
case "$COMMAND" in
  # -----------------------------------------------------------------
  up)
    shift 2
    TICKET=""
    BRANCH=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --ticket) TICKET="$2"; shift 2 ;;
        --branch) BRANCH="$2"; shift 2 ;;
        *) shift ;;
      esac
    done

    # Default to stack ID as branch name if no branch specified
    if [ -n "$BRANCH" ]; then
      export GIT_BRANCH="$BRANCH"
    else
      export GIT_BRANCH="$STACK_ID"
    fi

    echo "Starting Sandstorm stack ${STACK_ID} (${COMPOSE_PROJECT})..."
    [ -n "$TICKET" ] && echo "  Ticket: ${TICKET}"
    echo "  Branch: ${GIT_BRANCH}"
    print_port_map

    trap 'echo ""; echo "Cancelled."; exit 1' INT TERM

    # Clone workspace if it doesn't exist
    if [ ! -d "$WORKSPACE/.git" ]; then
      echo "  Cloning repo to workspace..."
      mkdir -p "$WORKSPACE"
      clone_workspace "$GIT_REMOTE_URL" "$GIT_BRANCH" "$WORKSPACE"
      # Copy env files that are gitignored (secrets/config needed to run)
      for f in "$PROJECT_ROOT"/.env*; do
        [ -f "$f" ] && cp "$f" "$WORKSPACE/" 2>/dev/null
      done
      # Remap ports in env files to match sandstorm stack offsets
      if [ -n "${PORT_MAP:-}" ]; then
        IFS=',' read -ra ENTRIES <<< "$PORT_MAP"
        for entry in "${ENTRIES[@]}"; do
          IFS=':' read -r svc host_port container_port idx <<< "$entry"
          remapped=$((host_port + STACK_ID * PORT_OFFSET))
          for ef in "$WORKSPACE"/.env*; do
            if [ -f "$ef" ]; then
              tmp="${ef}.tmp" && sed "s|localhost:${host_port}|localhost:${remapped}|g" "$ef" > "$tmp" && mv "$tmp" "$ef" || true
            fi
          done
        done
      fi
    fi

    # Make workspace world-readable/writable so container users can access it
    chmod -R a+rwX "$WORKSPACE" 2>/dev/null || true

    # Build and start in background — returns immediately.
    # Skip --build if all images referenced in the compose file already exist,
    # avoiding redundant rebuilds and orphaned dangling images (see #13).
    # If the app version has changed since the Claude image was built, force a
    # rebuild so embedded scripts (task-runner, entrypoint, etc.) are updated.
    (
      trap 'exit 1' INT TERM HUP
      BUILD_FLAG="--build"
      VERSION_REBUILD=false
      EXISTING_IMAGES=$(run_compose config --images 2>/dev/null || true)
      if [ -n "$EXISTING_IMAGES" ]; then
        ALL_EXIST=true
        while IFS= read -r img; do
          [ -z "$img" ] && continue
          if ! docker image inspect "$img" > /dev/null 2>&1; then
            ALL_EXIST=false
            break
          fi
        done <<< "$EXISTING_IMAGES"
        if [ "$ALL_EXIST" = true ]; then
          BUILD_FLAG=""
        fi
      fi

      # Version stamp check: compare the Claude image's sandstorm.app-version
      # label against the current app version. If they differ, force a rebuild.
      CLAUDE_IMAGE="sandstorm-${PROJECT_NAME}-claude"
      if [ -n "${SANDSTORM_APP_VERSION:-}" ] && [ "$SANDSTORM_APP_VERSION" != "unknown" ]; then
        IMAGE_VERSION=$(docker image inspect "$CLAUDE_IMAGE" --format '{{index .Config.Labels "sandstorm.app-version"}}' 2>/dev/null || true)
        if [ -n "$IMAGE_VERSION" ] && [ "$IMAGE_VERSION" != "$SANDSTORM_APP_VERSION" ]; then
          echo "App version changed (image: ${IMAGE_VERSION:0:8}... → current: ${SANDSTORM_APP_VERSION:0:8}...). Rebuilding base image..."
          BUILD_FLAG="--build"
          VERSION_REBUILD=true
        elif [ -z "$IMAGE_VERSION" ] && docker image inspect "$CLAUDE_IMAGE" > /dev/null 2>&1; then
          # Image exists but has no version label — rebuild to add it
          echo "Base image missing version stamp. Rebuilding..."
          BUILD_FLAG="--build"
          VERSION_REBUILD=true
        fi
      fi

      run_compose up -d $BUILD_FLAG > /tmp/sandstorm-build-${STACK_ID}.log 2>&1 || true
    ) &

    echo ""
    echo "Build running in background. Check 'sandstorm status' or 'sandstorm logs ${STACK_ID}'."
    echo "Build log: /tmp/sandstorm-build-${STACK_ID}.log"
    ;;

  # -----------------------------------------------------------------
  register)
    shift 2
    TICKET="" BRANCH="" DESC=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --ticket) TICKET="$2"; shift 2 ;;
        --branch) BRANCH="$2"; shift 2 ;;
        --description) DESC="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    echo "Stack ${STACK_ID} registered (metadata is stored in SQLite by Sandstorm Desktop)."
    ;;

  # -----------------------------------------------------------------
  down)
    echo "Tearing down Sandstorm stack ${STACK_ID} (${COMPOSE_PROJECT})..."
    if [ -f "$WORKSPACE_COMPOSE" ]; then
      run_compose down -v --rmi local
    fi

    # Prune dangling images left by previous builds (best effort, see #13)
    docker image prune -f > /dev/null 2>&1 || true

    # Clean up workspace (may contain files owned by container users)
    if [ -d "$WORKSPACE" ]; then
      docker run --rm -v "$(dirname "$WORKSPACE"):/workspaces" alpine \
        rm -rf "/workspaces/$(basename "$WORKSPACE")" 2>/dev/null \
        || rm -rf "$WORKSPACE" 2>/dev/null || true
      echo "Workspace cleaned up."
    fi

    echo "Stack ${STACK_ID} removed."
    ;;

  # -----------------------------------------------------------------
  exec)
    echo "Shelling into stack ${STACK_ID}..."
    docker exec -it -u claude "$CONTAINER_NAME" bash
    ;;

  # -----------------------------------------------------------------
  claude)
    echo "Syncing OAuth credentials..."
    sync_oauth_to_container "$CONTAINER_NAME"
    echo "Starting Claude in stack ${STACK_ID}..."
    docker exec -it -u claude "$CONTAINER_NAME" claude --dangerously-skip-permissions
    ;;

  # -----------------------------------------------------------------
  task)
    shift 2
    SYNC_MODE=false
    TICKET=""
    TASK_MODEL=""
    while true; do
      case "${1:-}" in
        --sync) SYNC_MODE=true; shift ;;
        --ticket) TICKET="$2"; shift 2 ;;
        --model) TASK_MODEL="$2"; shift 2 ;;
        *) break ;;
      esac
    done

    if [ "$1" = "--file" ]; then
      TASK_FILE="$2"
      if [ ! -f "$TASK_FILE" ]; then
        echo "Error: File not found: $TASK_FILE"
        exit 1
      fi
      TASK_CONTENT=$(cat "$TASK_FILE")
    else
      TASK_CONTENT="$*"
    fi

    if [ -z "$TASK_CONTENT" ]; then
      echo "Error: No task provided."
      echo "Usage: sandstorm task <id> \"task description\""
      echo "       sandstorm task <id> --sync \"task description\""
      echo "       sandstorm task <id> --file /path/to/task.md"
      exit 1
    fi

    sync_oauth_to_container "$CONTAINER_NAME"

    if [ "$SYNC_MODE" = true ]; then
      echo "Sending task to Claude in stack ${STACK_ID} (synchronous)..."
      TTY_FLAG=()
      if [ -t 0 ]; then
        TTY_FLAG=(-it)
      fi
      MODEL_ARG=()
      if [ -n "$TASK_MODEL" ]; then
        MODEL_ARG=(--model "$TASK_MODEL")
      fi
      docker exec "${TTY_FLAG[@]}" -u claude "$CONTAINER_NAME" \
        claude --dangerously-skip-permissions "${MODEL_ARG[@]}" --print -p "$TASK_CONTENT"

    else
      echo "Dispatching task to Claude in stack ${STACK_ID}..."

      TASK_LABEL=$(echo "$TASK_CONTENT" | head -1 | cut -c1-80)

      echo "$TASK_CONTENT" | docker exec -i -u claude "$CONTAINER_NAME" \
        bash -c "cat > /tmp/claude-task-prompt.txt"

      echo "$TASK_LABEL" | docker exec -i -u claude "$CONTAINER_NAME" \
        bash -c "cat > /tmp/claude-task-label.txt"

      # Write model selection file if specified
      if [ -n "$TASK_MODEL" ]; then
        echo "$TASK_MODEL" | docker exec -i -u claude "$CONTAINER_NAME" \
          bash -c "cat > /tmp/claude-task-model.txt"
      fi

      # Trigger the task runner (runs as the container's main process, output goes to docker logs)
      docker exec -u claude "$CONTAINER_NAME" touch /tmp/claude-task-trigger

      echo "Task dispatched. Inner Claude is working autonomously."
      echo ""
      echo "  Check progress:  sandstorm task-status ${STACK_ID}"
      echo "  View output:     sandstorm task-output ${STACK_ID}"
    fi
    ;;

  # -----------------------------------------------------------------
  task-status)
    if docker exec -u claude "$CONTAINER_NAME" test -f /tmp/claude-task.pid 2>/dev/null; then
      PID=$(docker exec -u claude "$CONTAINER_NAME" cat /tmp/claude-task.pid)
      echo "Stack ${STACK_ID}: RUNNING (pid ${PID})"
    elif docker exec -u claude "$CONTAINER_NAME" test -f /tmp/claude-task.status 2>/dev/null; then
      STATUS=$(docker exec -u claude "$CONTAINER_NAME" cat /tmp/claude-task.status)
      if [ "$STATUS" = "failed" ]; then
        EXIT_CODE=$(docker exec -u claude "$CONTAINER_NAME" cat /tmp/claude-task.exit 2>/dev/null || echo "?")
        echo "Stack ${STACK_ID}: FAILED (exit code ${EXIT_CODE})"
      else
        echo "Stack ${STACK_ID}: $(echo "$STATUS" | tr '[:lower:]' '[:upper:]')"
      fi
    else
      echo "Stack ${STACK_ID}: NO TASK"
    fi

    ;;

  # -----------------------------------------------------------------
  task-output)
    LINES="${3:-50}"
    if docker exec -u claude "$CONTAINER_NAME" test -f /tmp/claude-task.log 2>/dev/null; then
      docker exec -u claude "$CONTAINER_NAME" tail -n "$LINES" /tmp/claude-task.log
    else
      echo "No task output found for stack ${STACK_ID}."
    fi
    ;;

  # -----------------------------------------------------------------
  diff)
    docker exec -u claude -w /app "$CONTAINER_NAME" bash -c 'git status --short && echo "---" && git diff'
    ;;

  # -----------------------------------------------------------------
  push)
    FORCE=false
    for arg in "$@"; do
      [ "$arg" = "--force" ] && FORCE=true
    done
    COMMIT_MSG="${3:-"Changes from Sandstorm stack ${STACK_ID}"}"

    resolve_github_token

    CURRENT_BRANCH=$(docker exec -u claude -w /app "$CONTAINER_NAME" git branch --show-current)

    echo "Pushing from stack ${STACK_ID}..."
    echo "  Branch: ${CURRENT_BRANCH}"
    echo "  Commit: ${COMMIT_MSG}"

    docker exec \
      -u claude \
      -w /app \
      -e GITHUB_TOKEN="$GITHUB_TOKEN" \
      -e GH_TOKEN="$GITHUB_TOKEN" \
      -e GIT_AUTHOR_NAME="$GIT_AUTHOR_NAME" \
      -e GIT_AUTHOR_EMAIL="$GIT_AUTHOR_EMAIL" \
      -e GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" \
      -e GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL" \
      "$CONTAINER_NAME" bash -c '
        set -e
        git remote set-url origin "https://${GITHUB_TOKEN}@github.com/'"${GIT_REPO}"'.git"
        git add -A
        git diff --cached --quiet || git commit -m "'"${COMMIT_MSG}"'"
        git push -u origin "'"${CURRENT_BRANCH}"'"
        # Create PR back to main using the project create-pr script if available
        if git log origin/main.."'"${CURRENT_BRANCH}"'" --oneline | head -1 | grep -q .; then
          if [ -x /app/.sandstorm/scripts/create-pr.sh ]; then
            /app/.sandstorm/scripts/create-pr.sh \
              --title "'"${COMMIT_MSG}"'" \
              --body "Changes from Sandstorm stack '"${STACK_ID}"'" \
              --base main \
              --head "'"${CURRENT_BRANCH}"'" 2>/dev/null || echo "PR already exists or could not be created"
          else
            echo "No create-pr script found at .sandstorm/scripts/create-pr.sh — skipping PR creation."
            echo "Run sandstorm init to configure a ticket provider, or create the script manually."
          fi
        fi
        git remote set-url origin "https://github.com/'"${GIT_REPO}"'.git"
      '

    echo ""
    echo "Done! Changes pushed to ${CURRENT_BRANCH} and PR created."
    ;;

  # -----------------------------------------------------------------
  status)
    RUNNING_IDS=$(docker ps --filter "name=sandstorm-${PROJECT_NAME}-" --format "{{.Names}}" 2>/dev/null \
      | grep -- "-claude-" | sed -E "s/sandstorm-${PROJECT_NAME}-([0-9]+)-claude-1/\1/" | sort -n)

    if [ -z "$RUNNING_IDS" ]; then
      echo "No Sandstorm stacks running."
      exit 0
    fi

    render_dashboard "$RUNNING_IDS" "$RUNNING_IDS" > /dev/null
    ;;

  # -----------------------------------------------------------------
  logs)
    LOG_SERVICE="${3:-claude}"
    run_compose logs -f "$LOG_SERVICE"
    ;;

  # -----------------------------------------------------------------
  *)
    echo "Sandstorm — Claude Code Docker Stack Manager"
    echo ""
    echo "Usage: sandstorm <command> <stack_id> [args...]"
    echo ""
    echo "Commands:"
    echo "  init                                   Initialize Sandstorm in a project"
    echo "  up <id> [--ticket TICKET]              Start a new stack"
    echo "  down <id>                              Tear down stack"
    echo "  exec <id>                              Shell into the Claude container"
    echo "  claude <id>                            Run Claude interactively"
    echo "  register <id> --ticket T [--branch B]  Register stack metadata"
    echo ""
    echo "  task <id> [--ticket T] \"prompt\"        Dispatch a task (async)"
    echo "  task <id> --sync \"prompt\"              Dispatch a task (sync)"
    echo "  task <id> --file /path/to/task.md      Dispatch from file"
    echo "  task-status <id>                       Check task status"
    echo "  task-output <id> [lines]               Show task output"
    echo ""
    echo "  diff <id>                              Show git diff and untracked files"
    echo "  push <id> [\"msg\"] [--force]            Commit, push, and create PR"
    echo "  status                                 Dashboard of all stacks"
    echo "  logs <id> [service]                    Tail container logs (default: claude)"
    ;;
esac
