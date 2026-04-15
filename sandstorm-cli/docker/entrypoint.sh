#!/bin/bash
set -e

echo "=== Sandstorm: Starting up ==="

# -------------------------------------------------------------------
# 1. Configure git identity (required — passed from host)
# -------------------------------------------------------------------
if [ -z "$GIT_USER_NAME" ] || [ -z "$GIT_USER_EMAIL" ]; then
  echo "ERROR: GIT_USER_NAME and GIT_USER_EMAIL must be set."
  exit 1
fi

git config --global user.name "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"

mkdir -p /home/claude
cat > /home/claude/.gitconfig << GITEOF
[user]
    name = ${GIT_USER_NAME}
    email = ${GIT_USER_EMAIL}
GITEOF
chown claude:claude /home/claude/.gitconfig

# -------------------------------------------------------------------
# 2. Set up .env from sample if one doesn't exist
# -------------------------------------------------------------------
cd /app
if [ ! -f ".env" ]; then
  for sample in .sample.env .env.sample .env.example; do
    if [ -f "$sample" ]; then
      echo "Creating .env from ${sample}..."
      cp "$sample" .env
      # Override DB/Redis to point at compose services
      sed -i "s|^DATABASE_HOST=.*|DATABASE_HOST=${PGHOST:-postgres}|" .env 2>/dev/null || true
      sed -i "s|^DATABASE_PASSWORD=.*|DATABASE_PASSWORD=${PGPASSWORD:-password}|" .env 2>/dev/null || true
      sed -i "s|^DATABASE_USERNAME=.*|DATABASE_USERNAME=${PGUSER:-postgres}|" .env 2>/dev/null || true
      sed -i "s|^REDIS_URL=.*|REDIS_URL=${REDIS_URL:-redis://redis:6379/0}|" .env 2>/dev/null || true
      break
    fi
  done
fi

# -------------------------------------------------------------------
# 2.5. Configure Chrome DevTools MCP for Claude Code
# -------------------------------------------------------------------
# Write MCP config to /tmp/sandstorm-mcp.json (outside workspace, so it never appears in git)
# Chrome flags explanation:
#   --acceptInsecureCerts: Chromium in Docker auto-upgrades HTTP to HTTPS for
#     internal hostnames (e.g., http://app:3000 -> https://app:3000), which fails
#     because there's no SSL cert. This flag prevents those SSL errors.
#   --no-sandbox: Required when running as root or in containers without a sandbox namespace.
#   --disable-dev-shm-usage: Prevents crashes from /dev/shm being too small in containers.
#   --allow-insecure-localhost: Allows HTTP connections to localhost/internal hostnames.
cat > /tmp/sandstorm-mcp.json << 'MCPEOF'
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "chrome-devtools-mcp",
      "args": [
        "--headless",
        "--no-usage-statistics",
        "--isolated",
        "--acceptInsecureCerts",
        "--executablePath", "/usr/bin/chromium",
        "--chromeArg=--no-sandbox",
        "--chromeArg=--disable-dev-shm-usage",
        "--chromeArg=--allow-insecure-localhost"
      ],
      "env": {
        "CHROME_PATH": "/usr/bin/chromium",
        "PUPPETEER_EXECUTABLE_PATH": "/usr/bin/chromium"
      }
    }
  }
}
MCPEOF

# -------------------------------------------------------------------
# 3. Set ownership and signal readiness
# -------------------------------------------------------------------
chown -R claude:claude /app
chown -R claude:claude /home/claude
chown -R claude:claude /usr/local/bundle 2>/dev/null || true

# Write sandstorm instructions to user-level CLAUDE.md
# (Claude Code reads ~/.claude/CLAUDE.md alongside project-level CLAUDE.md)
mkdir -p /home/claude/.claude
if [ -f /usr/bin/SANDSTORM_INNER.md ]; then
  cp /usr/bin/SANDSTORM_INNER.md /home/claude/.claude/CLAUDE.md
fi

# Inject dynamic service descriptions from Docker labels
if [ -n "$SANDSTORM_PROJECT" ] && [ -S /var/run/docker.sock ]; then
  # Find sibling containers in the same compose project (excluding the claude container)
  SERVICE_DESCRIPTIONS=""
  CONTAINERS=$(docker ps --filter "label=com.docker.compose.project" --format '{{.Names}}' 2>/dev/null | grep "^${SANDSTORM_PROJECT}-" | grep -v -- "-claude-" | sort)

  if [ -n "$CONTAINERS" ]; then
    while IFS= read -r container_name; do
      # Extract service name from container name (e.g., sandstorm-myproject-1-app-1 → app)
      service_name=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container_name" 2>/dev/null)
      description=$(docker inspect --format '{{index .Config.Labels "sandstorm.description"}}' "$container_name" 2>/dev/null)

      if [ -n "$service_name" ] && [ "$service_name" != "claude" ]; then
        if [ -n "$description" ] && [ "$description" != "<no value>" ]; then
          SERVICE_DESCRIPTIONS="${SERVICE_DESCRIPTIONS}\n- **${service_name}** — ${description}"
        else
          SERVICE_DESCRIPTIONS="${SERVICE_DESCRIPTIONS}\n- **${service_name}**"
        fi
      fi
    done <<< "$CONTAINERS"
  fi

  if [ -n "$SERVICE_DESCRIPTIONS" ]; then
    {
      echo ""
      echo "## Stack Services"
      echo ""
      echo "Your stack has these services:"
      echo -e "$SERVICE_DESCRIPTIONS"
      echo ""
      echo "Use \`sandstorm-exec <service> <command>\` to run commands on these services."
      echo "Do NOT install languages or run project commands directly on this container."
    } >> /home/claude/.claude/CLAUDE.md
    echo "  Service descriptions injected from Docker labels"
  fi
fi

# Append per-project context from .sandstorm/context/*.md (mounted read-only)
if [ -d /sandstorm-context ] && ls /sandstorm-context/*.md 1>/dev/null 2>&1; then
  echo "" >> /home/claude/.claude/CLAUDE.md
  echo "# Per-Project Context" >> /home/claude/.claude/CLAUDE.md
  for ctx in /sandstorm-context/*.md; do
    echo "" >> /home/claude/.claude/CLAUDE.md
    cat "$ctx" >> /home/claude/.claude/CLAUDE.md
  done
  echo "  Per-project context injected from .sandstorm/context/"
fi

chown -R claude:claude /home/claude/.claude

# Fix docker socket permissions so claude user can access it
if [ -S /var/run/docker.sock ]; then
  chmod 666 /var/run/docker.sock
fi

# Signal to other services that the repo is ready
touch /tmp/.sandstorm-ready

echo ""
echo "=========================================="
echo "  Sandstorm Claude workspace is READY"
echo "=========================================="
echo "  Workspace: /app"
echo "=========================================="
echo ""

# -------------------------------------------------------------------
# 4. Start task runner (PID 1 — output goes to docker logs)
# -------------------------------------------------------------------
exec gosu claude /usr/bin/sandstorm-task-runner.sh
