#!/usr/bin/env bash
# Script-backed stack-inspect skill (Ticket D continuation).
# Read-only probes against a stack via the in-process MCP bridge.
#
#   stack-inspect.sh output <stack-id>
#   stack-inspect.sh logs   <stack-id> [service]
#   stack-inspect.sh diff   <stack-id>
#   stack-inspect.sh all    <stack-id>

set -euo pipefail

SUBCOMMAND="${1:-}"
STACK_ID="${2:-}"

if [[ -z "$SUBCOMMAND" || -z "$STACK_ID" ]]; then
  echo "ERROR reason=missing_arg expected=\"{output|logs|diff|all} <stack-id> [<service>]\""
  exit 0
fi

: "${SANDSTORM_BRIDGE_URL:?bridge url not set}"
: "${SANDSTORM_BRIDGE_TOKEN:?bridge token not set}"

call_bridge() {
  local payload
  payload=$(jq -cn --arg name "$1" --argjson input "$2" '{name:$name, input:$input}')
  curl -fsS -X POST \
    -H "X-Auth-Token: $SANDSTORM_BRIDGE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "$SANDSTORM_BRIDGE_URL/tool-call" 2>/dev/null || echo '{"error":"call_failed"}'
}

unwrap() {
  # Prints .result as-is, or a single-line ERROR if the bridge reported one.
  local resp="$1"
  local label="$2"
  if echo "$resp" | jq -e '.error' >/dev/null 2>&1; then
    local reason
    reason="$(echo "$resp" | jq -r '.error')"
    echo "ERROR section=$label reason=\"$reason\""
    return 1
  fi
  echo "$resp" | jq -r '.result // ""'
}

do_output() {
  local resp
  resp="$(call_bridge get_task_output "{\"stackId\":\"$STACK_ID\"}")"
  unwrap "$resp" output
}

do_logs() {
  local service="${1:-}"
  local input
  if [[ -n "$service" ]]; then
    input="{\"stackId\":\"$STACK_ID\",\"service\":\"$service\"}"
  else
    input="{\"stackId\":\"$STACK_ID\"}"
  fi
  local resp
  resp="$(call_bridge get_logs "$input")"
  unwrap "$resp" logs
}

do_diff() {
  local resp
  resp="$(call_bridge get_diff "{\"stackId\":\"$STACK_ID\"}")"
  unwrap "$resp" diff
}

case "$SUBCOMMAND" in
  output) do_output ;;
  logs)   do_logs "${3:-}" ;;
  diff)   do_diff ;;
  all)
    echo "=== OUTPUT ==="
    do_output || true
    echo ""
    echo "=== LOGS ==="
    do_logs || true
    echo ""
    echo "=== DIFF ==="
    do_diff || true
    ;;
  *)
    echo "ERROR reason=unknown_subcommand got=\"$SUBCOMMAND\" expected=\"output|logs|diff|all\""
    exit 0
    ;;
esac
