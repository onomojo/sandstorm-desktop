#!/bin/sh
# sandstorm-scheduled-run.sh — invoked by cron to dispatch a scheduled job
# to the running Sandstorm Desktop app via Unix domain socket.
#
# Usage: sandstorm-scheduled-run.sh <project-dir> <schedule-id>
#
# Protocol version: 1
#
# Exit semantics:
#   0 — dispatch accepted, rejected (logged), or app not running (skip)
#   1 — unexpected error (surfaces via cron MAILTO if configured)
#
# Socket fallback chain:
#   1. nc -U (netcat with Unix socket support — most Linux distros)
#   2. python3 inline socket script (macOS, minimal environments)
#
# This script does NOT rely on PATH — it uses absolute paths where possible.

set -e

PROTOCOL_VERSION=1
SOCKET_PATH="${SANDSTORM_SOCK:-${HOME}/.sandstorm/orchestrator.sock}"
LOG_DIR="${HOME}/.sandstorm/logs"
LOG_FILE="${LOG_DIR}/scheduled-runs.log"

# --- Args ---

if [ "$1" = "--protocol-version" ]; then
  echo "$PROTOCOL_VERSION"
  exit 0
fi

if [ $# -lt 2 ]; then
  echo "Usage: $0 <project-dir> <schedule-id>" >&2
  exit 1
fi

PROJECT_DIR="$1"
SCHEDULE_ID="$2"
FIRED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%S")

# Validate inputs — reject control characters (newlines, etc.) that could break JSON
case "$PROJECT_DIR" in
  *[[:cntrl:]]*)
    echo "Error: PROJECT_DIR contains control characters" >&2
    exit 1
    ;;
esac
case "$SCHEDULE_ID" in
  *[[:cntrl:]]*)
    echo "Error: SCHEDULE_ID contains control characters" >&2
    exit 1
    ;;
esac

# --- Logging ---

mkdir -p "$LOG_DIR" 2>/dev/null || true

log() {
  echo "$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date) [$SCHEDULE_ID] $1" >> "$LOG_FILE" 2>/dev/null || true
}

# --- Check socket exists ---

if [ ! -S "$SOCKET_PATH" ]; then
  log "SKIP app-not-running: socket not found at $SOCKET_PATH"
  exit 0
fi

# --- Build request JSON ---

# Escape strings for JSON (backslashes, quotes, tabs, carriage returns, newlines).
# Uses POSIX-compliant sed (works on both GNU and BSD/macOS sed).
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' | tr '\r\n' '  '
}

PROJECT_DIR_ESC=$(json_escape "$PROJECT_DIR")
SCHEDULE_ID_ESC=$(json_escape "$SCHEDULE_ID")

# Request carries only the identifiers — the app looks up the schedule's
# structured action (`{kind: ..., ...}`) from schedules.json. No freeform
# prompt crosses the socket; there's nothing to dispatch to an outer-Claude
# chat turn by design.
REQUEST="{\"type\":\"scheduled-dispatch\",\"version\":${PROTOCOL_VERSION},\"projectDir\":\"${PROJECT_DIR_ESC}\",\"scheduleId\":\"${SCHEDULE_ID_ESC}\",\"firedAt\":\"${FIRED_AT}\"}"

# --- Send request via socket ---

send_via_nc() {
  printf '%s\n' "$REQUEST" | nc -U "$SOCKET_PATH" -w 5 2>/dev/null
}

send_via_python() {
  printf '%s' "$REQUEST" | /usr/bin/env python3 -c "
import socket, sys, json
data = sys.stdin.read()
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
try:
    sock.settimeout(10)
    sock.connect(sys.argv[1])
    sock.sendall((data + '\n').encode())
    resp = b''
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            break
        resp += chunk
        if b'\n' in resp:
            break
    print(resp.decode().strip())
except ConnectionRefusedError:
    print(json.dumps({'ok': False, 'reason': 'app-not-running', 'message': 'Connection refused'}))
except FileNotFoundError:
    print(json.dumps({'ok': False, 'reason': 'app-not-running', 'message': 'Socket not found'}))
finally:
    sock.close()
" "$SOCKET_PATH" 2>/dev/null
}

# Try nc first, fall back to python3
# Note: the `if` condition is exempt from set -e, so grep returning 1 is safe.
RESPONSE=""
if command -v nc >/dev/null 2>&1 && nc -h 2>&1 | grep -q '\-U'; then
  RESPONSE=$(send_via_nc) || true
fi

if [ -z "$RESPONSE" ]; then
  if command -v python3 >/dev/null 2>&1; then
    RESPONSE=$(send_via_python) || true
  fi
fi

# --- Handle response ---

if [ -z "$RESPONSE" ]; then
  log "SKIP app-not-running: no response from socket (connection failed)"
  exit 0
fi

# Parse the ok field from JSON response
OK=$(printf '%s' "$RESPONSE" | sed -n 's/.*"ok" *: *\(true\|false\).*/\1/p; s/.*"ok":\(true\|false\).*/\1/p' | head -1)

if [ "$OK" = "true" ]; then
  DISPATCH_ID=$(printf '%s' "$RESPONSE" | sed -n 's/.*"dispatchId" *: *"\([^"]*\)".*/\1/p; s/.*"dispatchId":"\([^"]*\)".*/\1/p' | head -1)
  log "DISPATCHED id=$DISPATCH_ID"
  exit 0
elif [ "$OK" = "false" ]; then
  REASON=$(printf '%s' "$RESPONSE" | sed -n 's/.*"reason" *: *"\([^"]*\)".*/\1/p; s/.*"reason":"\([^"]*\)".*/\1/p' | head -1)
  MESSAGE=$(printf '%s' "$RESPONSE" | sed -n 's/.*"message" *: *"\([^"]*\)".*/\1/p; s/.*"message":"\([^"]*\)".*/\1/p' | head -1)
  log "SKIP reason=$REASON message=$MESSAGE"
  exit 0
else
  log "ERROR unexpected response: $RESPONSE"
  exit 1
fi
