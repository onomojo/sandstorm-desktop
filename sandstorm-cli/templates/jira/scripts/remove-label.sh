#!/bin/bash
#
# remove-label.sh — Remove a label from a Jira issue.
#
# Prerequisites (export in shell before launching the app):
#   JIRA_URL        Site root, e.g. https://yourorg.atlassian.net
#   JIRA_USERNAME   Atlassian account email
#   JIRA_API_TOKEN  API token from https://id.atlassian.com/manage-profile/security/api-tokens
#
# Contract:
#   Input:  <ticket-id> <label>
#   Action: removes the label from the issue (no-op if label is not present)
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
set -euo pipefail

TICKET_ID="${1:-}"
LABEL="${2:-}"

if [ -z "$TICKET_ID" ] || [ -z "$LABEL" ]; then
  echo "Usage: remove-label.sh <ticket-id> <label>" >&2
  exit 1
fi

missing_deps=()
command -v curl >/dev/null 2>&1 || missing_deps+=("curl")
command -v jq >/dev/null 2>&1 || missing_deps+=("jq")
if [ ${#missing_deps[@]} -gt 0 ]; then
  echo "Error: missing required tools: ${missing_deps[*]}" >&2
  exit 1
fi

missing_vars=()
[ -z "${JIRA_URL:-}" ] && missing_vars+=("JIRA_URL")
[ -z "${JIRA_USERNAME:-}" ] && missing_vars+=("JIRA_USERNAME")
[ -z "${JIRA_API_TOKEN:-}" ] && missing_vars+=("JIRA_API_TOKEN")
if [ ${#missing_vars[@]} -gt 0 ]; then
  echo "Error: missing required environment variables: ${missing_vars[*]}" >&2
  exit 1
fi

BASE_URL="${JIRA_URL%/}"
PAYLOAD=$(jq -n --arg label "$LABEL" '{"update":{"labels":[{"remove":$label}]}}')

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X PUT \
  -u "$JIRA_USERNAME:$JIRA_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d "$PAYLOAD" \
  "${BASE_URL}/rest/api/2/issue/${TICKET_ID}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  echo "Error: remove-label failed (HTTP $HTTP_CODE)" >&2
  RESP_BODY=$(echo "$RESPONSE" | sed '$d')
  echo "$RESP_BODY" | jq -r '.errorMessages[]? // empty' >&2 2>/dev/null || true
  exit 1
fi

echo "Removed label '$LABEL' from $TICKET_ID."
