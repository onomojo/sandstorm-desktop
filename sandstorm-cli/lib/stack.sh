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

# ---------------------------------------------------------------------------
# Stack registry
# ---------------------------------------------------------------------------
STACKS_DIR="$PROJECT_ROOT/.sandstorm/stacks"

ensure_stacks_dir() {
  mkdir -p "$STACKS_DIR"
}

registry_write() {
  local id="$1" ticket="$2" branch="$3" description="$4" status="$5" last_task="$6"
  ensure_stacks_dir
  python3 -c "
import json, sys, os
from datetime import datetime, timezone

path, sid = sys.argv[1], sys.argv[2]
ticket, branch, desc, status = sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]
last_task = sys.argv[7] if len(sys.argv) > 7 else ''

existing = {}
if os.path.exists(path):
    with open(path) as f:
        existing = json.load(f)

if 'created_at' not in existing:
    existing['created_at'] = datetime.now(timezone.utc).isoformat()

existing['stack_id'] = sid
if ticket:   existing['ticket'] = ticket
if branch:   existing['branch'] = branch
if desc:     existing['description'] = desc
if status:   existing['status'] = status
if last_task:
    existing['last_task'] = last_task[:200]
    existing['last_task_at'] = datetime.now(timezone.utc).isoformat()

with open(path, 'w') as f:
    json.dump(existing, f, indent=2)
" "$STACKS_DIR/${id}.json" "$id" "$ticket" "$branch" "$description" "$status" "$last_task"
}

registry_read() {
  local id="$1" field="$2"
  local path="$STACKS_DIR/${id}.json"
  if [ -f "$path" ]; then
    python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$path" "$field"
  fi
}

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
    REG_TICKET=$(registry_read "$SID" "ticket")
    REG_BRANCH=$(registry_read "$SID" "branch")
    REG_DESC=$(registry_read "$SID" "description")
    [ -z "$REG_TICKET" ] && REG_TICKET="—"
    [ -z "$REG_BRANCH" ] && REG_BRANCH="—"
    [ -z "$REG_DESC" ] && REG_DESC="—"

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
# Ticket safety check
# ---------------------------------------------------------------------------
check_ticket_match() {
  local branch="$1" force="$2"
  if [ -z "$TICKET_PREFIX" ]; then return 0; fi

  local REG_TICKET
  REG_TICKET=$(registry_read "$STACK_ID" "ticket")
  if [ -z "$REG_TICKET" ]; then return 0; fi

  local BRANCH_TICKET
  BRANCH_TICKET=$(echo "$branch" | grep -oE "${TICKET_PREFIX}-[0-9]+" || true)
  if [ -n "$BRANCH_TICKET" ] && [ "$BRANCH_TICKET" != "$REG_TICKET" ]; then
    echo "ERROR: Ticket mismatch!"
    echo "  Registry ticket:  ${REG_TICKET}"
    echo "  Branch ticket:    ${BRANCH_TICKET} (from ${branch})"
    echo ""
    echo "Use --force to override."
    if [ "$force" != true ]; then
      exit 1
    fi
    echo "WARNING: --force used, proceeding despite mismatch."
  fi
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

    trap 'echo ""; echo "Cancelled."; registry_write "$STACK_ID" "" "" "" "cancelled" ""; exit 1' INT TERM
    registry_write "$STACK_ID" "$TICKET" "$GIT_BRANCH" "" "building" ""

    # Clone workspace if it doesn't exist
    if [ ! -d "$WORKSPACE/.git" ]; then
      echo "  Cloning repo to workspace..."
      mkdir -p "$WORKSPACE"
      git clone "$GIT_REMOTE_URL" "$WORKSPACE" > /dev/null 2>&1
      if [ -n "${GIT_BRANCH:-}" ]; then
        # Point workspace origin at the real remote (not the local clone source)
        REMOTE_URL=$(git -C "$PROJECT_ROOT" remote get-url origin 2>/dev/null || true)
        if [ -n "$REMOTE_URL" ]; then
          git -C "$WORKSPACE" remote set-url origin "$REMOTE_URL"
          git -C "$WORKSPACE" fetch origin 2>/dev/null || true
        fi
        # Try checking out existing remote branch first, then fall back to creating new
        git -C "$WORKSPACE" checkout "$GIT_BRANCH" 2>/dev/null \
          || git -C "$WORKSPACE" checkout -b "$GIT_BRANCH" "origin/$GIT_BRANCH" 2>/dev/null \
          || git -C "$WORKSPACE" checkout -b "$GIT_BRANCH"
      fi
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
    (
      trap 'registry_write "$STACK_ID" "" "" "" "cancelled" ""; exit 1' INT TERM HUP
      BUILD_FLAG="--build"
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
      if run_compose up -d $BUILD_FLAG > /tmp/sandstorm-build-${STACK_ID}.log 2>&1; then
        registry_write "$STACK_ID" "" "" "" "up" ""
      else
        registry_write "$STACK_ID" "" "" "" "failed" ""
      fi
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
    registry_write "$STACK_ID" "$TICKET" "$BRANCH" "$DESC" "" ""
    echo "Stack ${STACK_ID} registered:"
    cat "$STACKS_DIR/${STACK_ID}.json"
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

    if [ -f "$STACKS_DIR/${STACK_ID}.json" ]; then
      mkdir -p "$STACKS_DIR/archive"
      TIMESTAMP=$(date +%Y%m%d_%H%M%S)
      mv "$STACKS_DIR/${STACK_ID}.json" "$STACKS_DIR/archive/${STACK_ID}_${TIMESTAMP}.json"
      echo "Registry archived."
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
    while true; do
      case "${1:-}" in
        --sync) SYNC_MODE=true; shift ;;
        --ticket) TICKET="$2"; shift 2 ;;
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
      TASK_LABEL=$(echo "$TASK_CONTENT" | head -1 | cut -c1-80)
      registry_write "$STACK_ID" "$TICKET" "" "$TASK_LABEL" "running" "$TASK_CONTENT"

      echo "Sending task to Claude in stack ${STACK_ID} (synchronous)..."
      TTY_FLAG=""
      if [ -t 0 ]; then
        TTY_FLAG="-it"
      fi
      docker exec $TTY_FLAG -u claude "$CONTAINER_NAME" \
        claude --dangerously-skip-permissions --print -p "$TASK_CONTENT"

      FINAL_BRANCH=$(docker exec -u claude -w /app "$CONTAINER_NAME" git branch --show-current 2>/dev/null || echo "")
      registry_write "$STACK_ID" "" "$FINAL_BRANCH" "" "completed" ""
    else
      echo "Dispatching task to Claude in stack ${STACK_ID}..."

      TASK_LABEL=$(echo "$TASK_CONTENT" | head -1 | cut -c1-80)

      echo "$TASK_CONTENT" | docker exec -i -u claude "$CONTAINER_NAME" \
        bash -c "cat > /tmp/claude-task-prompt.txt"

      echo "$TASK_LABEL" | docker exec -i -u claude "$CONTAINER_NAME" \
        bash -c "cat > /tmp/claude-task-label.txt"

      # Trigger the task runner (runs as the container's main process, output goes to docker logs)
      docker exec -u claude "$CONTAINER_NAME" touch /tmp/claude-task-trigger

      registry_write "$STACK_ID" "$TICKET" "" "$TASK_LABEL" "running" "$TASK_CONTENT"

      (
        trap 'registry_write "$STACK_ID" "" "" "" "cancelled" ""; exit 1' INT TERM HUP
        while docker exec -u claude "$CONTAINER_NAME" test -f /tmp/claude-task.pid 2>/dev/null; do
          sleep 10
        done
        FINAL_STATUS=$(docker exec -u claude "$CONTAINER_NAME" cat /tmp/claude-task.status 2>/dev/null || echo "unknown")
        FINAL_BRANCH=$(docker exec -u claude -w /app "$CONTAINER_NAME" git branch --show-current 2>/dev/null || echo "")
        registry_write "$STACK_ID" "" "$FINAL_BRANCH" "" "$FINAL_STATUS" ""
      ) &

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

    REG_TICKET=$(registry_read "$STACK_ID" "ticket")
    REG_BRANCH=$(registry_read "$STACK_ID" "branch")
    REG_DESC=$(registry_read "$STACK_ID" "description")
    [ -n "$REG_TICKET" ] && echo "  Ticket:      ${REG_TICKET}"
    [ -n "$REG_BRANCH" ] && echo "  Branch:      ${REG_BRANCH}"
    [ -n "$REG_DESC" ]   && echo "  Description: ${REG_DESC}"
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
    check_ticket_match "$CURRENT_BRANCH" "$FORCE"

    # Safety check: warn if the inner agent switched branches
    EXPECTED_BRANCH=$(registry_read "$STACK_ID" "branch")
    if [ -n "$EXPECTED_BRANCH" ] && [ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]; then
      echo "WARNING: Branch drift detected!"
      echo "  Expected: ${EXPECTED_BRANCH}"
      echo "  Actual:   ${CURRENT_BRANCH}"
      echo "  The inner agent appears to have switched branches."
      if [ "$FORCE" != "true" ]; then
        echo "  Use --force to push anyway, or fix the branch first."
        exit 1
      fi
      echo "  --force specified, pushing anyway..."
    fi

    REG_TICKET=$(registry_read "$STACK_ID" "ticket")

    echo "Pushing from stack ${STACK_ID}..."
    echo "  Branch: ${CURRENT_BRANCH}"
    echo "  Commit: ${COMMIT_MSG}"
    [ -n "$REG_TICKET" ] && echo "  Ticket: ${REG_TICKET}"

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
        # Create PR back to main
        if git log origin/main.."'"${CURRENT_BRANCH}"'" --oneline | head -1 | grep -q .; then
          gh pr create \
            --title "'"${COMMIT_MSG}"'" \
            --body "Changes from Sandstorm stack '"${STACK_ID}"'" \
            --base main \
            --head "'"${CURRENT_BRANCH}"'" 2>/dev/null || echo "PR already exists or could not be created"
        fi
        git remote set-url origin "https://github.com/'"${GIT_REPO}"'.git"
      '

    registry_write "$STACK_ID" "" "$CURRENT_BRANCH" "" "pr-created" ""

    echo ""
    echo "Done! Changes pushed to ${CURRENT_BRANCH} and PR created."
    ;;

  # -----------------------------------------------------------------
  status)
    ensure_stacks_dir

    RUNNING_IDS=$(docker ps --filter "name=sandstorm-${PROJECT_NAME}-" --format "{{.Names}}" 2>/dev/null \
      | grep -- "-claude-" | sed -E "s/sandstorm-${PROJECT_NAME}-([0-9]+)-claude-1/\1/" | sort -n)
    REGISTERED_IDS=$(ls "$STACKS_DIR"/*.json 2>/dev/null | xargs -I{} basename {} .json | sort -n || true)
    ALL_IDS=$(printf '%s\n%s\n' "$RUNNING_IDS" "$REGISTERED_IDS" | sort -nu | grep -v '^$' || true)

    if [ -z "$ALL_IDS" ]; then
      echo "No Sandstorm stacks known."
      exit 0
    fi

    render_dashboard "$ALL_IDS" "$RUNNING_IDS" > /dev/null
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
