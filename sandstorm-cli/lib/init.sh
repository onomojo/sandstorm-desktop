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

# Extract service names, ports, and image info for label generation
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
    image = svc.get('image', '')
    print(f'{name}|{port_str}|{image}')
")

if [ -z "$ANALYSIS" ]; then
  echo "Error: No services found in ${COMPOSE_FILE}." >&2
  exit 1
fi

# Extract top-level named networks (networks with an explicit `name:` property)
NAMED_NETWORKS=$(echo "$COMPOSE_JSON" | python3 -c "
import json, sys

config = json.load(sys.stdin)
networks = config.get('networks', {})

for key, net in networks.items():
    if isinstance(net, dict) and net.get('name'):
        print(f'{key}|{net[\"name\"]}')
" 2>/dev/null || true)

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
  echo "$ANALYSIS" | while IFS='|' read -r name ports image; do
    if [ "$name" = "$1" ]; then echo "$ports"; fi
  done
}

# Lookup image for a service from ANALYSIS
svc_image() {
  echo "$ANALYSIS" | while IFS='|' read -r name ports image; do
    if [ "$name" = "$1" ]; then echo "$image"; fi
  done
}

# Generate a basic description for a service based on its image name
svc_auto_description() {
  local svc_name="$1"
  local image="$(svc_image "$svc_name")"

  case "$image" in
    *postgres*)  echo "PostgreSQL database" ;;
    *mysql*)     echo "MySQL database" ;;
    *redis*)     echo "Redis cache/store" ;;
    *mongo*)     echo "MongoDB database" ;;
    *nginx*)     echo "Nginx web server" ;;
    *rabbitmq*)  echo "RabbitMQ message broker" ;;
    *elasticsearch*|*opensearch*) echo "Search engine" ;;
    *)
      # For built services (no image), use the service name
      if [ -z "$image" ]; then
        echo "Application service"
      else
        echo "Service ($image)"
      fi
      ;;
  esac
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
# Ticket provider selection
# ---------------------------------------------------------------------------

# Auto-detect available ticket systems by inspecting the environment.
# Returns: "jira", "github", or "skeleton"
detect_ticket_provider() {
  # Jira: check for atlassian MCP server config in .mcp.json
  if [ -f "$PROJECT_ROOT/.mcp.json" ] && grep -q '"atlassian"' "$PROJECT_ROOT/.mcp.json" 2>/dev/null; then
    echo "jira"
    return
  fi
  # GitHub: check for gh CLI and a GitHub remote
  if command -v gh >/dev/null 2>&1 && git -C "$PROJECT_ROOT" remote -v 2>/dev/null | grep -q "github\.com"; then
    echo "github"
    return
  fi
  echo "skeleton"
}

TICKET_PROVIDER="github"

if [ "$SKIP_PROMPT" != "true" ]; then
  DETECTED_PROVIDER="$(detect_ticket_provider)"
  case "$DETECTED_PROVIDER" in
    jira)    DEFAULT_CHOICE="2" ;;
    github)  DEFAULT_CHOICE="1" ;;
    *)       DEFAULT_CHOICE="3" ;;
  esac

  echo ""
  echo "Ticket provider (auto-detected: ${DETECTED_PROVIDER}):"
  echo "  1. GitHub Issues (uses gh CLI)"
  echo "  2. Jira (uses Atlassian MCP)"
  echo "  3. Custom (create your own scripts later)"
  echo ""
  read -rp "Which ticket system does this project use? [1/2/3, default: ${DEFAULT_CHOICE}] " PROVIDER_CHOICE
  PROVIDER_CHOICE="${PROVIDER_CHOICE:-${DEFAULT_CHOICE}}"
  case "$PROVIDER_CHOICE" in
    1) TICKET_PROVIDER="github" ;;
    2) TICKET_PROVIDER="jira" ;;
    3) TICKET_PROVIDER="skeleton" ;;
    *) TICKET_PROVIDER="$DETECTED_PROVIDER" ;;
  esac
else
  TICKET_PROVIDER="$(detect_ticket_provider)"
  case "$TICKET_PROVIDER" in
    jira)
      echo "  Ticket provider: Jira (detected atlassian MCP config in .mcp.json)"
      ;;
    github)
      echo "  Ticket provider: GitHub Issues (detected gh CLI and GitHub remote)"
      ;;
    *)
      TICKET_PROVIDER="skeleton"
      echo "  Ticket provider: none auto-detected — skeleton script will be generated"
      echo "    To enable ticket fetching, implement .sandstorm/scripts/fetch-ticket.sh"
      echo "    (script receives ticket ID as \$1, must output ticket body to stdout)"
      ;;
  esac
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

  # Port remapping + shared image names + service description labels
  while IFS= read -r svc; do
    [ -z "$svc" ] && continue
    local_ports="$(svc_ports "$svc")"
    is_built=$(echo "$BUILT_SERVICES" | grep -qx "$svc" && echo "yes" || echo "no")
    description="$(svc_auto_description "$svc")"

    # Emit a service block for services that need ports, image pins, or labels
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
    # Escape double quotes in description to produce valid YAML
    safe_description="${description//\"/\\\"}"
    echo "    labels:"
    echo "      sandstorm.description: \"${safe_description}\""
  done <<< "$ALL_SERVICES"

  # Claude workspace service (shared image across all stacks)
  cat << CLAUDE
  claude:
    image: sandstorm-${PROJECT_NAME}-claude
    build:
      context: \${SANDSTORM_DIR}
      dockerfile: docker/Dockerfile
      args:
        SANDSTORM_APP_VERSION: \${SANDSTORM_APP_VERSION:-unknown}
    environment:
      - GIT_USER_NAME
      - GIT_USER_EMAIL
      - SANDSTORM_PROJECT
      - SANDSTORM_STACK_ID
    volumes:
      - \${SANDSTORM_WORKSPACE}:/app
      - \${SANDSTORM_CONTEXT}:/sandstorm-context:ro
      - /var/run/docker.sock:/var/run/docker.sock
    healthcheck:
      test: ["CMD", "test", "-f", "/app/.sandstorm-ready"]
      interval: 3s
      timeout: 2s
      retries: 60
    tty: true
    stdin_open: true
CLAUDE

  # Network isolation — remap named networks to per-stack names
  if [ -n "$NAMED_NETWORKS" ]; then
    echo ""
    echo "networks:"
    while IFS='|' read -r net_key net_name; do
      [ -z "$net_key" ] && continue
      echo "  ${net_key}:"
      echo "    name: \${SANDSTORM_PROJECT}-${net_key}"
    done <<< "$NAMED_NETWORKS"
  fi
} > "$SANDSTORM_CONFIG_DIR/docker-compose.yml"

echo "  Created .sandstorm/docker-compose.yml"

# ---------------------------------------------------------------------------
# Generate .sandstorm/verify.sh (project-configurable verification script)
# ---------------------------------------------------------------------------
VERIFY_SCRIPT="$SANDSTORM_CONFIG_DIR/verify.sh"

# Auto-detect verify commands based on project files
{
  echo "#!/bin/bash"
  echo "#"
  echo "# Sandstorm verify script — commands run during the verification step."
  echo "# Each command runs in sequence. If any fails, verification fails."
  echo "#"
  echo "# Use 'sandstorm-exec <service> <command>' to run on service containers."
  echo "# Edit this file to match your project's test/lint/build commands."
  echo "#"
  echo "set -e"
  echo ""

  # Check for Node.js project indicators
  if [ -f "$PROJECT_ROOT/package.json" ]; then
    # Read package.json scripts to determine what's available
    HAS_TEST=$(python3 -c "import json; d=json.load(open('$PROJECT_ROOT/package.json')); print('yes' if 'test' in d.get('scripts',{}) else 'no')" 2>/dev/null || echo "no")
    HAS_BUILD=$(python3 -c "import json; d=json.load(open('$PROJECT_ROOT/package.json')); print('yes' if 'build' in d.get('scripts',{}) else 'no')" 2>/dev/null || echo "no")
    HAS_TYPECHECK=$(python3 -c "import json; d=json.load(open('$PROJECT_ROOT/package.json')); print('yes' if 'typecheck' in d.get('scripts',{}) else 'no')" 2>/dev/null || echo "no")
    HAS_TSCONFIG=$([ -f "$PROJECT_ROOT/tsconfig.json" ] && echo "yes" || echo "no")

    if [ "$HAS_TEST" = "yes" ]; then echo "npm test"; fi
    if [ "$HAS_TYPECHECK" = "yes" ]; then
      echo "npm run typecheck"
    elif [ "$HAS_TSCONFIG" = "yes" ]; then
      echo "npx tsc --noEmit"
    fi
    if [ "$HAS_BUILD" = "yes" ]; then echo "npm run build"; fi
  fi

  # Check for Ruby/Rails
  if [ -f "$PROJECT_ROOT/Gemfile" ]; then
    if [ -f "$PROJECT_ROOT/bin/rails" ]; then
      echo "# sandstorm-exec api bash -c 'cd /rails && bin/rails test'"
    fi
  fi

  # Check for Python
  if [ -f "$PROJECT_ROOT/requirements.txt" ] || [ -f "$PROJECT_ROOT/pyproject.toml" ]; then
    echo "# sandstorm-exec app pytest"
  fi

  # Check for Go
  if [ -f "$PROJECT_ROOT/go.mod" ]; then
    echo "# sandstorm-exec app go test ./..."
  fi
} > "$VERIFY_SCRIPT"

chmod +x "$VERIFY_SCRIPT"
echo "  Created .sandstorm/verify.sh"

# ---------------------------------------------------------------------------
# Generate .sandstorm/spec-quality-gate.md (ticket readiness criteria)
# ---------------------------------------------------------------------------
QUALITY_GATE="$SANDSTORM_CONFIG_DIR/spec-quality-gate.md"

cat > "$QUALITY_GATE" << 'GATE'
# Spec Quality Gate

Criteria for determining whether a ticket is ready for agent dispatch.
Each criterion is **pass/fail**. If any fails, the specific gap must be
resolved before the ticket enters the execution pipeline.

Customize this file to match your project's needs. This is the single
source of truth for what "ready" means in this project.

---

## Criteria

### Problem Statement
Is the "why" clearly stated? What's broken or missing?
- The ticket must explain the motivation, not just the desired change.

### Current vs Desired Behavior
Can someone understand what changes?
- Describe what happens today and what should happen after the work is done.

### Scope Boundaries
What's explicitly in scope? What's out?
- Unbounded tickets lead to scope creep. Define the edges.

### Migration Path
If it changes existing behavior, how do existing users/projects transition?
- Skip if the change is purely additive with no breaking impact.

### Edge Cases
Are known edge cases called out?
- List scenarios that could break or behave unexpectedly.

### Ambiguity Check
Are there decision points where the agent would have to guess?
- Every ambiguity is a coin flip. Resolve them before dispatch.

### Testability
Is it clear how to verify the work is correct?
- Define what "done" looks like in concrete, testable terms.

### Files/Areas Affected
Are the impacted areas of the codebase identified?
- Point the agent at the right part of the codebase.

### Assumptions — Zero Unresolved
List every assumption the agent would make if it started now.
- **Assumptions are ambiguity. Ambiguity means the spec is incomplete.**
- If an assumption can be validated by reading code, checking APIs, or running commands — the evaluator MUST validate it and replace it with a verified fact or flag it as incorrect.
- If an assumption requires human input (business logic, domain knowledge, product direction, edge case decisions) — it MUST be surfaced as an explicit question that blocks the gate.
- The gate MUST NOT pass with unresolved assumptions. Every assumption must become either a verified fact or an answered question.

### End-to-End Data Flow Verification
When a feature spans multiple system boundaries (API → DB → frontend, CLI → config → runtime, etc.):
- Testability MUST include at least one item that traces data through the entire pipeline without mocks.
- Every integration boundary the data crosses must be explicitly identified.
- A verification step must prove data arrives at the final destination under realistic conditions.
- Flag any ticket where the testability section consists entirely of mocked tests for features that span multiple layers.

### Dependency Contracts
When the ticket references another ticket, module, or external system's output:
- The data contract must be explicit — what format, what interface, when available.
- Read/write timing must be compatible — if the source writes at end-of-process and the consumer reads mid-process, that's a conflict.
- How contract compatibility is verified must be specified.
- If the data source doesn't exist yet, the ticket must include creating it or explicitly depend on a ticket that does.

### Automated Visual Verification (UI Tickets)
When the ticket describes visual changes (components, panels, layouts, modals, pages):
- An automated visual verification step against the real running application is required — not mocked component renders.
- Visual verification must exercise the same code path the user sees (real IPC, real backend, real data flow).
- If the project provides headless browser infrastructure, the verification step must use it.
- Skip this criterion if the ticket has no UI/visual changes.

### All Verification Must Be Automatable
Every verification item must be executable autonomously with no human involvement:
- No "manually verify", "visually confirm", "deploy and check".
- No optional verification checkboxes that can be skipped.
- If a verification step can't be expressed as an automated command, test, or assertion, it's not valid.
- The fix isn't "make sure humans check the boxes" — it's "eliminate manual steps entirely".
GATE

echo "  Created .sandstorm/spec-quality-gate.md"

# ---------------------------------------------------------------------------
# Generate .sandstorm/review-prompt.md (project-configurable review prompt)
# ---------------------------------------------------------------------------
REVIEW_PROMPT="$SANDSTORM_CONFIG_DIR/review-prompt.md"

cat > "$REVIEW_PROMPT" << 'REVIEWPROMPT'
# Code Review — Fresh Context

You are a code review agent. You have NO prior context from the execution agent — review the changes with fresh eyes.

## Discovering Changes

Before reviewing, use git tools to discover what changed:

- Run `git status` to see which files were modified, added, or deleted
- Run `git diff HEAD` (or `git diff HEAD -- <file>` for a specific file) to inspect the changes
- Read files directly if you need more context
- You decide what to inspect and how deeply — skip generated files or large data files that are not relevant to the task

## Your Job

Review the changes against the original task. Evaluate:

1. **Requirements compliance** — Does the code do what the task asked for? If the task specifies an approach (e.g., "use X, do NOT use Y"), does the code comply? **This is the highest-priority criterion. A "better" approach that violates explicit task requirements is a REVIEW_FAIL.**
2. **Architecture** — Does the change fit existing patterns in the codebase?
3. **Best practices** — Is the code idiomatic, with proper error handling?
4. **Separation of concerns** — No god functions, proper layering?
5. **DRY** — No unnecessary duplication?
6. **Security** — No injection, XSS, leaked secrets, OWASP top 10 issues?
7. **Scalability** — Will it hold up under load?
8. **Optimizations** — Unnecessary allocations, N+1 queries, etc.?
9. **Test coverage** — Are the tests meaningful and sufficient?

## Understanding the Task Context

The "Original Task" section below may include:

- **Issue body** — The original requirements
- **Issue comments** — Follow-up discussion, clarifications, corrections, and evolved requirements

**Pay close attention to comments, especially recent ones.** Requirements evolve through discussion. A comment may override or refine the original issue body. If the issue says "do X" but a later comment says "actually do Y instead", the code should do Y.

Read the full history to understand how the team arrived at the current requirements before reviewing.

## Output Format

You MUST end your response with exactly one of these verdict lines:

**If the code is acceptable:**
```
REVIEW_PASS
```

**If there are issues that must be fixed:**
```
REVIEW_FAIL

Issues:
1. [CATEGORY] Description of issue — file:line if applicable
2. [CATEGORY] Description of issue — file:line if applicable
...
```

Categories: REQUIREMENTS, ARCHITECTURE, BEST_PRACTICE, SEPARATION, DRY, SECURITY, SCALABILITY, OPTIMIZATION, TEST_COVERAGE, BUG

## Rules

- **If the task explicitly specifies an implementation approach, do NOT suggest alternatives.** The task requirements reflect decisions already made. Your job is to review the implementation quality within those constraints, not to second-guess the constraints themselves.
- Be pragmatic. Only fail the review for genuine issues, not style preferences.
- Minor nits (variable naming preferences, comment style) are NOT grounds for REVIEW_FAIL.
- Missing tests for new functionality IS grounds for REVIEW_FAIL.
- Security issues are ALWAYS grounds for REVIEW_FAIL.
- **If you identified a problem and the fix is obvious (describable in one sentence), it is a REVIEW_FAIL, not a note.** Only lean toward REVIEW_PASS for genuine ambiguity where you cannot determine if the code is actually wrong.

### Code quality is a review criterion

"Functionally correct" is necessary but not sufficient — the review covers quality, not just correctness. The following are BEST_PRACTICE failures, not style nits:

- Redundant database calls (multiple updates where one suffices)
- Unnecessary object reloads between sequential operations
- Code that could be trivially simplified with an obvious one-line fix
- Multiple round-trips or operations that can be combined into one
- Dead code, unreachable branches, or unused variables introduced by the diff

### Categorize all findings

Every observation you make about the code MUST be either:
1. A **REVIEW_FAIL issue** with an explicit category (REQUIREMENTS, ARCHITECTURE, BEST_PRACTICE, SEPARATION, DRY, SECURITY, SCALABILITY, OPTIMIZATION, TEST_COVERAGE, BUG), or
2. **Explicitly stated as acceptable** with a brief reason why it does not warrant a fail.

Do not leave unclassified observations floating in your review. If you mention it, categorize it.

---

REVIEWPROMPT

echo "  Created .sandstorm/review-prompt.md"

# ---------------------------------------------------------------------------
# Install Claude skills into the project
# ---------------------------------------------------------------------------
SKILLS_SRC="$SANDSTORM_DIR/skills"
SKILLS_DEST="$PROJECT_ROOT/.claude/skills"

if [ -d "$SKILLS_SRC" ]; then
  mkdir -p "$SKILLS_DEST"
  cp "$SKILLS_SRC"/sandstorm-*.md "$SKILLS_DEST/"
  echo "  Installed Claude skills to .claude/skills/"
fi

# ---------------------------------------------------------------------------
# Install ticket provider scripts and skills
# ---------------------------------------------------------------------------
TEMPLATES_SRC="$SANDSTORM_DIR/templates/${TICKET_PROVIDER}"

if [ -d "$TEMPLATES_SRC" ]; then
  # Copy scripts (only if project doesn't already have them)
  SCRIPTS_DEST="$SANDSTORM_CONFIG_DIR/scripts"
  FETCH_SCRIPT="$SCRIPTS_DEST/fetch-ticket.sh"
  if [ ! -d "$SCRIPTS_DEST" ] || [ -z "$(ls -A "$SCRIPTS_DEST" 2>/dev/null)" ]; then
    mkdir -p "$SCRIPTS_DEST"
    cp "$TEMPLATES_SRC"/scripts/*.sh "$SCRIPTS_DEST/"
    chmod +x "$SCRIPTS_DEST"/*.sh
    echo "  Installed ticket scripts to .sandstorm/scripts/ (${TICKET_PROVIDER})"
  else
    if [ -f "$FETCH_SCRIPT" ] && [ ! -x "$FETCH_SCRIPT" ]; then
      echo "  Warning: .sandstorm/scripts/fetch-ticket.sh exists but is not executable"
      echo "    Run: chmod +x $FETCH_SCRIPT"
    else
      echo "  Skipped ticket scripts — .sandstorm/scripts/ already has scripts"
    fi
  fi

  # Copy skills (only if project doesn't already have them)
  TICKET_SKILLS_DEST="$SANDSTORM_CONFIG_DIR/skills"
  if [ ! -d "$TICKET_SKILLS_DEST" ] || [ -z "$(ls -A "$TICKET_SKILLS_DEST" 2>/dev/null)" ]; then
    mkdir -p "$TICKET_SKILLS_DEST"
    cp "$TEMPLATES_SRC"/skills/*.md "$TICKET_SKILLS_DEST/"
    echo "  Installed ticket skills to .sandstorm/skills/ (${TICKET_PROVIDER})"
  else
    echo "  Skipped ticket skills — .sandstorm/skills/ already exists"
  fi
else
  echo "  Warning: No templates found for provider '${TICKET_PROVIDER}' at ${TEMPLATES_SRC}"
fi

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
