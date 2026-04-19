#!/usr/bin/env bash
# Script-backed spec-gate skill (#268 continuation).
# Wraps the `spec_check` and `spec_refine` MCP tools in a single
# deterministic entry point. The orchestrator only has to run one Bash
# call per user message; the script calls the in-process MCP bridge via
# HTTP.
#
# Usage:
#   sandstorm-spec.sh check  <ticket-id>
#   sandstorm-spec.sh refine <ticket-id>    # user answers on stdin

set -euo pipefail

SUBCOMMAND="${1:-}"
TICKET_ID="${2:-}"
PROJECT_DIR="${PWD}"

if [[ -z "$SUBCOMMAND" || -z "$TICKET_ID" ]]; then
  echo "ERROR reason=missing_arg expected=\"{check|refine} <ticket-id>\""
  exit 0
fi

: "${SANDSTORM_BRIDGE_URL:?bridge url not set}"
: "${SANDSTORM_BRIDGE_TOKEN:?bridge token not set}"

call_bridge() {
  curl -fsS -X POST \
    -H "X-Auth-Token: $SANDSTORM_BRIDGE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$1" \
    "$SANDSTORM_BRIDGE_URL/tool-call"
}

case "$SUBCOMMAND" in
  check)
    INPUT=$(jq -cn --arg t "$TICKET_ID" --arg d "$PROJECT_DIR" \
      '{name:"spec_check", input:{ticketId:$t, projectDir:$d}}')
    RESP="$(call_bridge "$INPUT" 2>/dev/null || echo '{"error":"call_failed"}')"
    echo "$RESP" | jq -c '.result // {error: (.error // "unknown_error")}'
    ;;
  refine)
    # userAnswers are expected on stdin — empty string means "no answers yet,
    # just re-fetch the gaps" which is the intended behavior of spec_refine.
    USER_ANSWERS=""
    if [[ ! -t 0 ]]; then
      USER_ANSWERS="$(cat)"
    fi
    INPUT=$(jq -cn \
      --arg t "$TICKET_ID" \
      --arg d "$PROJECT_DIR" \
      --arg u "$USER_ANSWERS" \
      '{name:"spec_refine", input:{ticketId:$t, projectDir:$d, userAnswers:$u}}')
    RESP="$(call_bridge "$INPUT" 2>/dev/null || echo '{"error":"call_failed"}')"
    echo "$RESP" | jq -c '.result // {error: (.error // "unknown_error")}'
    ;;
  *)
    echo "ERROR reason=unknown_subcommand got=\"$SUBCOMMAND\" expected=\"check|refine\""
    exit 0
    ;;
esac
