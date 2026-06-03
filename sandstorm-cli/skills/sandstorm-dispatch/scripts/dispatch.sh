#!/usr/bin/env bash
# Atomic dispatch primitive (#312).
#
# Given a ticket ID, start a Sandstorm stack with the ticket's verbatim body
# as its initial task. ZERO LLM invocation. STRICTLY ENFORCES the `spec-ready`
# label — refuses to run if the ticket has not passed the spec quality gate.
#
# There is deliberately NO --force / --bypass flag. The outer Claude was
# casually bypassing the gate and undermining the Opus-plan → Sonnet-execute
# cost model. If someone genuinely needs an un-gated stack, they hit the
# `create_stack` bridge endpoint directly with `forceBypass: true` — that
# path is explicit, visible, and intentional.
#
# Usage:
#   dispatch.sh <ticket-id> [--stack-name <name>]

set -euo pipefail

TICKET_ID="${1:-}"
shift || true

STACK_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack-name)
      STACK_NAME="${2:-}"
      shift 2
      ;;
    *)
      echo '{"error":"unknown_arg","got":"'"$1"'","hint":"usage: dispatch.sh <ticket-id> [--stack-name <name>]"}'
      exit 0
      ;;
  esac
done

if [[ -z "$TICKET_ID" ]]; then
  echo '{"error":"missing_arg","expected":"<ticket-id> [--stack-name <name>]"}'
  exit 0
fi

PROJECT_DIR="${PWD}"
: "${SANDSTORM_BRIDGE_URL:?bridge url not set}"
: "${SANDSTORM_BRIDGE_TOKEN:?bridge token not set}"

call_bridge() {
  curl -fsS -X POST \
    -H "X-Auth-Token: $SANDSTORM_BRIDGE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$1" \
    "$SANDSTORM_BRIDGE_URL/tool-call"
}

ticket_url() {
  local id="$1"
  if ! command -v gh >/dev/null 2>&1; then
    echo ""
    return 0
  fi
  gh issue view "$id" --json url -q '.url' 2>/dev/null || echo ""
}

# Gate enforcement: look for any label that starts with spec-ready.
# Accepts both the old `spec-ready` label and the new `spec-ready:sha-<hash>`
# form so projects migrating from manual labeling still work.
is_gate_ready() {
  local id="$1"
  if ! command -v gh >/dev/null 2>&1; then
    # No gh CLI → can't verify. Refuse rather than silently skip gate.
    echo "no-gh"
    return 0
  fi
  local labels
  labels="$(gh issue view "$id" --json labels -q '.labels[].name' 2>/dev/null || true)"
  if [[ -z "$labels" ]]; then
    echo "no-labels"
    return 0
  fi
  if echo "$labels" | grep -qE '^spec-ready(:|$)'; then
    echo "ready"
    return 0
  fi
  echo "not-ready"
}

# Slugify a string for use as a default stack name.
slugify() {
  local input="$1"
  echo "$input" | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' \
    | cut -c1-40
}

fetch_ticket_body() {
  local id="$1"
  local script="$PROJECT_DIR/.sandstorm/scripts/fetch-ticket.sh"
  if [[ ! -x "$script" ]]; then
    echo ""
    return 1
  fi
  "$script" "$id" 2>/dev/null
}

# Step 1: gate check.
URL="$(ticket_url "$TICKET_ID")"
GATE_STATUS="$(is_gate_ready "$TICKET_ID")"

case "$GATE_STATUS" in
  ready)
    ;;
  not-ready)
    jq -cn --arg url "$URL" \
      '{error: "NOT_GATE_READY", ticket_url: (if $url == "" then null else $url end), hint: "Run sandstorm-spec.sh check <id> first (or use spec-and-dispatch for the full flow)"}'
    exit 0
    ;;
  no-labels)
    jq -cn --arg url "$URL" \
      '{error: "NOT_GATE_READY", ticket_url: (if $url == "" then null else $url end), hint: "Ticket has no labels; run sandstorm-spec.sh check <id> to gate it first"}'
    exit 0
    ;;
  no-gh)
    echo '{"error":"GH_MISSING","hint":"gh CLI is required to verify the spec-ready label; install gh or run via Sandstorm orchestrator"}'
    exit 0
    ;;
esac

# Step 2: fetch body.
TICKET_BODY="$(fetch_ticket_body "$TICKET_ID" || true)"
if [[ -z "${TICKET_BODY//[[:space:]]/}" ]]; then
  jq -cn --arg url "$URL" --arg id "$TICKET_ID" \
    '{error: "FETCH_FAILED", ticket_id: $id, ticket_url: (if $url == "" then null else $url end), hint: "fetch-ticket.sh missing, empty, or failed"}'
  exit 0
fi

# Step 3: compute default stack name if not provided.
if [[ -z "$STACK_NAME" ]]; then
  # Best-effort: use "ticket-<id>-<slugified-first-line>"
  FIRST_LINE="$(echo "$TICKET_BODY" | head -1 | sed -E 's/^#+\s*//')"
  SLUG="$(slugify "$FIRST_LINE")"
  if [[ -n "$SLUG" ]]; then
    STACK_NAME="${SLUG}-${TICKET_ID}"
  else
    STACK_NAME="ticket-${TICKET_ID}"
  fi
fi

# Step 4: call create_stack via bridge.
INPUT=$(jq -cn \
  --arg name "$STACK_NAME" \
  --arg dir "$PROJECT_DIR" \
  --arg ticket "$TICKET_ID" \
  --arg task "$TICKET_BODY" \
  '{name:"create_stack", input:{name:$name, projectDir:$dir, ticket:$ticket, task:$task, gateApproved:true}}')

RESP="$(call_bridge "$INPUT" 2>/dev/null || echo '{"error":"call_failed"}')"

RESULT="$(echo "$RESP" | jq -c '.result // {error: (.error // "unknown_error")}')"
if echo "$RESULT" | jq -e '.error' >/dev/null 2>&1; then
  REASON="$(echo "$RESULT" | jq -r '.error')"
  jq -cn --arg reason "$REASON" --arg id "$TICKET_ID" --arg name "$STACK_NAME" \
    '{error: "CREATE_STACK_FAILED", reason: $reason, ticket_id: $id, stack_name: $name}'
  exit 0
fi

STACK_ID="$(echo "$RESULT" | jq -r '.id // .name // "unknown"')"
BRANCH="$(echo "$RESULT" | jq -r '.branch // ""')"

jq -cn \
  --arg stack "$STACK_ID" \
  --arg url "$URL" \
  --arg branch "$BRANCH" \
  '{ok: true, stack_id: $stack, ticket_url: (if $url == "" then null else $url end), branch: (if $branch == "" then null else $branch end)}'
