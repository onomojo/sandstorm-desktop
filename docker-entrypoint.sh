#!/bin/bash
set -e

# ---------------------------------------------------------------------------
# Claude credentials setup
#
# The Claude CLI needs OAuth credentials at ~/.claude/.credentials.json.
# These can be provided via:
#   1. A volume mount at /claude-credentials/.credentials.json
#   2. The CLAUDE_CREDENTIALS environment variable (JSON string)
#   3. Already present at ~/.claude/.credentials.json (manual setup)
# ---------------------------------------------------------------------------

CLAUDE_DIR="${HOME}/.claude"
CREDS_FILE="${CLAUDE_DIR}/.credentials.json"

mkdir -p "$CLAUDE_DIR"

# Always refresh credentials from volume or env var on each startup.
# OAuth tokens expire after ~6 hours, so stale copies must be overwritten.
if [ -f "/claude-credentials/.credentials.json" ]; then
  cp /claude-credentials/.credentials.json "$CREDS_FILE"
  echo "[entrypoint] Copied Claude credentials from /claude-credentials volume"
elif [ -n "$CLAUDE_CREDENTIALS" ]; then
  echo "$CLAUDE_CREDENTIALS" > "$CREDS_FILE"
  echo "[entrypoint] Wrote Claude credentials from CLAUDE_CREDENTIALS env var"
elif [ ! -f "$CREDS_FILE" ]; then
  echo "[entrypoint] Warning: No Claude credentials found. Usage stats will be unavailable."
  echo "[entrypoint] Provide credentials via /claude-credentials volume mount or CLAUDE_CREDENTIALS env var."
fi

exec "$@"
