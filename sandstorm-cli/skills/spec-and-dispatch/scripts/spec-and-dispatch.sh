#!/usr/bin/env bash
# Script-backed spec-and-dispatch compound skill (Ticket D continuation).
# Three subcommands wrapping the full "ticket → spec gate → create stack
# with verbatim ticket body" flow.
#
#   spec-and-dispatch.sh check  <ticket-id>
#   spec-and-dispatch.sh refine <ticket-id>          # user answers on stdin
#   spec-and-dispatch.sh create <ticket-id> <stack-name>

set -euo pipefail

SUBCOMMAND="${1:-}"
TICKET_ID="${2:-}"
PROJECT_DIR="${PWD}"

if [[ -z "$SUBCOMMAND" || -z "$TICKET_ID" ]]; then
  echo "ERROR phase=args reason=missing expected=\"{check|refine|create} <ticket-id> [<stack-name>]\""
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
    "$SANDSTORM_BRIDGE_URL/tool-call"
}

fetch_ticket_body() {
  # Uses the project's fetch-ticket helper (same one the MCP
  # handleSpecCheck path uses). Returns the ticket body on stdout or
  # empty on failure — caller decides how to handle missing.
  local script="$PROJECT_DIR/.sandstorm/scripts/fetch-ticket.sh"
  if [[ ! -x "$script" ]]; then
    return 1
  fi
  "$script" "$TICKET_ID" 2>/dev/null
}

case "$SUBCOMMAND" in
  check)
    INPUT=$(jq -cn --arg t "$TICKET_ID" --arg d "$PROJECT_DIR" \
      '{ticketId:$t, projectDir:$d}')
    RESP="$(call_bridge spec_check "$INPUT" 2>/dev/null || echo '{"error":"call_failed"}')"
    echo "$RESP" | jq -c '.result // {error: (.error // "unknown_error")}'
    ;;

  refine)
    USER_ANSWERS=""
    if [[ ! -t 0 ]]; then
      USER_ANSWERS="$(cat)"
    fi
    INPUT=$(jq -cn \
      --arg t "$TICKET_ID" \
      --arg d "$PROJECT_DIR" \
      --arg u "$USER_ANSWERS" \
      '{ticketId:$t, projectDir:$d, userAnswers:$u}')
    RESP="$(call_bridge spec_refine "$INPUT" 2>/dev/null || echo '{"error":"call_failed"}')"
    echo "$RESP" | jq -c '.result // {error: (.error // "unknown_error")}'
    ;;

  create)
    STACK_NAME="${3:-}"
    if [[ -z "$STACK_NAME" ]]; then
      echo "ERROR phase=args reason=missing_stack_name expected=\"create <ticket-id> <stack-name>\""
      exit 0
    fi

    TICKET_BODY="$(fetch_ticket_body)" || {
      echo "ERROR phase=fetch_ticket reason=\"fetch-ticket.sh missing or failed\" ticket=$TICKET_ID"
      exit 0
    }
    if [[ -z "${TICKET_BODY//[[:space:]]/}" ]]; then
      echo "ERROR phase=fetch_ticket reason=empty_body ticket=$TICKET_ID"
      exit 0
    fi

    INPUT=$(jq -cn \
      --arg name "$STACK_NAME" \
      --arg dir "$PROJECT_DIR" \
      --arg ticket "$TICKET_ID" \
      --arg task "$TICKET_BODY" \
      '{name:$name, projectDir:$dir, ticket:$ticket, task:$task, gateApproved:true}')

    RESP="$(call_bridge create_stack "$INPUT" 2>/dev/null || echo '{"error":"call_failed"}')"
    if echo "$RESP" | jq -e '.error' >/dev/null 2>&1; then
      REASON="$(echo "$RESP" | jq -r '.error')"
      echo "ERROR phase=create_stack reason=\"$REASON\" ticket=$TICKET_ID stack=$STACK_NAME"
      exit 0
    fi
    # Stack creation schedules a background build. The create_stack response
    # returns the Stack row; the initial task (if passed via `task` field)
    # dispatches once the stack is up. We just report the mapping.
    RESULT_ID="$(echo "$RESP" | jq -r '.result.id // .result.name // "unknown"')"
    echo "OK stack=$RESULT_ID ticket=$TICKET_ID"
    ;;

  *)
    echo "ERROR phase=args reason=unknown_subcommand got=\"$SUBCOMMAND\" expected=\"check|refine|create\""
    exit 0
    ;;
esac
