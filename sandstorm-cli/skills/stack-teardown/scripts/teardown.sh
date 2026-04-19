#!/usr/bin/env bash
# Script-backed wrapper for the teardown_stack MCP tool.
# Usage: teardown.sh <stack-id>
#
# Irreversible — the skill body is responsible for requiring explicit
# user confirmation before this script is ever invoked.

set -euo pipefail

STACK_ID="${1:-}"
if [[ -z "$STACK_ID" ]]; then
  echo "ERROR reason=missing_stack_id"
  exit 0
fi

: "${SANDSTORM_BRIDGE_URL:?bridge url not set}"
: "${SANDSTORM_BRIDGE_TOKEN:?bridge token not set}"

INPUT=$(jq -cn --arg s "$STACK_ID" '{name:"teardown_stack", input:{stackId:$s}}')

RESP="$(curl -fsS -X POST \
  -H "X-Auth-Token: $SANDSTORM_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$INPUT" \
  "$SANDSTORM_BRIDGE_URL/tool-call" 2>/dev/null || echo '{"error":"call_failed"}')"

if echo "$RESP" | jq -e '.error' >/dev/null 2>&1; then
  REASON="$(echo "$RESP" | jq -r '.error')"
  echo "ERROR reason=\"$REASON\" id=$STACK_ID"
  exit 0
fi

echo "OK id=$STACK_ID"
