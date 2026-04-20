#!/usr/bin/env bash
# Deterministic check-and-resume flow for #268. Invoked by the
# check-and-resume-stack skill with a single stack-id argument.
#
# The script calls the in-process Sandstorm MCP bridge via HTTP so it
# goes through the same control plane as the model-invoked MCP tools —
# no raw `sandstorm` CLI, no docker commands. Prints ONE summary line on
# stdout; the model just echoes that to the user.

set -euo pipefail

STACK_ID="${1:-}"
if [[ -z "$STACK_ID" ]]; then
  echo "ERROR reason=stack_id_missing"
  exit 0
fi

: "${SANDSTORM_BRIDGE_URL:?bridge url not set}"
: "${SANDSTORM_BRIDGE_TOKEN:?bridge token not set}"

call_bridge() {
  curl -fsS -X POST \
    -H "X-Auth-Token: $SANDSTORM_BRIDGE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\",\"input\":$2}" \
    "$SANDSTORM_BRIDGE_URL/tool-call"
}

# Try the literal ID first.
STATUS_JSON="$(call_bridge get_task_status "{\"stackId\":\"$STACK_ID\"}" 2>/dev/null || echo '{"error":"call_failed"}')"
RESOLVED_ID="$STACK_ID"

# If the status call errored or returned a "not found" shape, resolve via list_stacks.
if echo "$STATUS_JSON" | jq -e '.error // (.result | tostring | test("not found|no such stack|unknown stack"; "i"))' >/dev/null 2>&1; then
  LIST_JSON="$(call_bridge list_stacks '{}' 2>/dev/null || echo '{"result":[]}')"
  # Build a newline-separated list of names matching by exact, hyphenated prefix, or prefix.
  MATCHES="$(echo "$LIST_JSON" | jq -r --arg q "$STACK_ID" '
    (.result // .result.stacks // []) | .[]? |
    (.name // .id // empty) | select(type == "string") |
    select(. == $q or startswith($q + "-") or startswith($q))
  ')"
  MATCH_COUNT=$(printf '%s\n' "$MATCHES" | grep -c . || true)
  if [[ "$MATCH_COUNT" -eq 0 ]]; then
    echo "NOT_FOUND id=$STACK_ID"
    exit 0
  elif [[ "$MATCH_COUNT" -gt 1 ]]; then
    JOINED=$(printf '%s\n' "$MATCHES" | paste -sd, -)
    echo "AMBIGUOUS id=$STACK_ID matches=$JOINED"
    exit 0
  fi
  RESOLVED_ID="$(printf '%s\n' "$MATCHES" | head -1)"
  STATUS_JSON="$(call_bridge get_task_status "{\"stackId\":\"$RESOLVED_ID\"}" 2>/dev/null || echo '{}')"
fi

# Pull a state label from common response shapes.
STATE="$(echo "$STATUS_JSON" | jq -r '.result.state // .result.status // .result.taskState // "unknown"')"

# Before trusting a "running" verdict from the DB, verify the containers
# actually are up. The DB status can drift stale when the user pauses
# (docker stop) or the OS kills containers — the tasks row stays
# 'running' but the claude/app containers are exited. Treating that as
# running leads to the skill silently no-op'ing on what the user actually
# sees as a paused stack.
CONTAINERS_LIVE="unknown"
if [[ "$STATE" == "running" ]]; then
  LIST_JSON="$(call_bridge list_stacks '{}' 2>/dev/null || echo '{"result":[]}')"
  # Collect service statuses for THIS stack. Accept either .name or .id
  # as the match key since different call shapes may carry one or both.
  SERVICES_STATUSES="$(echo "$LIST_JSON" | jq -r --arg id "$RESOLVED_ID" '
    (.result // .result.stacks // []) | .[]? |
    select((.name // "") == $id or (.id // "") == $id) |
    (.services // []) | .[]? |
    (.status // .state // "unknown")
  ')"
  if [[ -z "${SERVICES_STATUSES//[[:space:]]/}" ]]; then
    # No services info returned — can't verify. Fall through and trust
    # the DB state rather than second-guessing.
    CONTAINERS_LIVE="unknown"
  elif printf '%s\n' "$SERVICES_STATUSES" | grep -qv '^running$'; then
    # At least one service is not 'running' → DB is stale.
    CONTAINERS_LIVE="stale"
  else
    CONTAINERS_LIVE="live"
  fi
fi

case "$STATE" in
  running)
    if [[ "$CONTAINERS_LIVE" == "stale" ]]; then
      # DB said running but containers are down → treat as resumable.
      # Fall through to the resumable branch below.
      STATE="paused_stale"
    else
      echo "STATE=running id=$RESOLVED_ID action=none containers=$CONTAINERS_LIVE"
      exit 0
    fi
    ;;
  completed)
    echo "STATE=completed id=$RESOLVED_ID action=none"
    exit 0
    ;;
esac

# idle / paused / failed / paused_stale / unknown — treat as resumable.
RESUME_INPUT='{"stackId":"'"$RESOLVED_ID"'","prompt":"Continue from where you left off. Do not redo completed work. Pick up the next unfinished step.","forceBypass":true}'
DISPATCH_JSON="$(call_bridge dispatch_task "$RESUME_INPUT" 2>/dev/null || echo '{"error":"dispatch_failed"}')"
if echo "$DISPATCH_JSON" | jq -e '.error' >/dev/null 2>&1; then
  REASON="$(echo "$DISPATCH_JSON" | jq -r '.error')"
  echo "STATE=$STATE id=$RESOLVED_ID action=resume_failed reason=\"$REASON\""
  exit 0
fi
TASK_ID="$(echo "$DISPATCH_JSON" | jq -r '.result.taskId // .result.id // .result // "unknown"' | head -c 48)"
echo "STATE=$STATE id=$RESOLVED_ID action=resumed task=$TASK_ID"
