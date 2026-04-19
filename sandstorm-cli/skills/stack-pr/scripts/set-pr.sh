#!/usr/bin/env bash
# Script-backed wrapper for the set_pr MCP tool.
# Usage: set-pr.sh <stack-id> <pr-number> <pr-url>

set -euo pipefail

STACK_ID="${1:-}"
PR_NUMBER="${2:-}"
PR_URL="${3:-}"

if [[ -z "$STACK_ID" || -z "$PR_NUMBER" || -z "$PR_URL" ]]; then
  echo "ERROR reason=missing_arg expected=\"<stack-id> <pr-number> <pr-url>\""
  exit 0
fi

if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "ERROR reason=invalid_pr_number got=\"$PR_NUMBER\""
  exit 0
fi

: "${SANDSTORM_BRIDGE_URL:?bridge url not set}"
: "${SANDSTORM_BRIDGE_TOKEN:?bridge token not set}"

INPUT=$(jq -cn \
  --arg s "$STACK_ID" \
  --arg u "$PR_URL" \
  --argjson n "$PR_NUMBER" \
  '{name:"set_pr", input:{stackId:$s, prUrl:$u, prNumber:$n}}')

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

echo "OK id=$STACK_ID pr=$PR_NUMBER"
