#!/usr/bin/env bash
# Script-backed list-stacks skill (Ticket D continuation).
# Lists every stack with status + services via the in-process MCP bridge.

set -euo pipefail

: "${SANDSTORM_BRIDGE_URL:?bridge url not set}"
: "${SANDSTORM_BRIDGE_TOKEN:?bridge token not set}"

RESP="$(curl -fsS -X POST \
  -H "X-Auth-Token: $SANDSTORM_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"list_stacks","input":{}}' \
  "$SANDSTORM_BRIDGE_URL/tool-call" 2>/dev/null || echo '{"error":"call_failed"}')"

if echo "$RESP" | jq -e '.error' >/dev/null 2>&1; then
  REASON="$(echo "$RESP" | jq -r '.error')"
  echo "ERROR reason=\"$REASON\""
  exit 0
fi

echo "$RESP" | jq -c '.result // []'
