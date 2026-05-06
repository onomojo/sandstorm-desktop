#!/bin/bash
#
# update-ticket.sh — Update a Jira ticket's description via the Jira Cloud REST API v2.
#
# Prerequisites (export in shell before launching the app):
#   JIRA_URL        Site root, e.g. https://yourorg.atlassian.net
#   JIRA_USERNAME   Atlassian account email
#   JIRA_API_TOKEN  API token from https://id.atlassian.com/manage-profile/security/api-tokens
#
# Contract:
#   Input:  <ticket-id> <body>
#   Action: updates the ticket description with the provided content
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
set -euo pipefail

TICKET_ID="${1:-}"
BODY="${2:-}"

if [ -z "$TICKET_ID" ] || [ -z "$BODY" ]; then
  echo "Usage: update-ticket.sh <ticket-id> <body>" >&2
  exit 1
fi

missing_deps=()
command -v curl >/dev/null 2>&1 || missing_deps+=("curl")
command -v jq >/dev/null 2>&1 || missing_deps+=("jq")
if [ ${#missing_deps[@]} -gt 0 ]; then
  echo "Error: missing required tools: ${missing_deps[*]}" >&2
  echo "Install them and try again." >&2
  exit 1
fi

missing_vars=()
[ -z "${JIRA_URL:-}" ] && missing_vars+=("JIRA_URL")
[ -z "${JIRA_USERNAME:-}" ] && missing_vars+=("JIRA_USERNAME")
[ -z "${JIRA_API_TOKEN:-}" ] && missing_vars+=("JIRA_API_TOKEN")
if [ ${#missing_vars[@]} -gt 0 ]; then
  echo "Error: missing required environment variables: ${missing_vars[*]}" >&2
  echo "Export them in your shell environment and restart the desktop app." >&2
  exit 1
fi

BASE_URL="${JIRA_URL%/}"
if echo "$BASE_URL" | grep -qE '^https?://[^/]+/.+'; then
  echo "Error: JIRA_URL must be the site root (e.g. https://yourorg.atlassian.net), not a REST path." >&2
  exit 1
fi

PAYLOAD=$(jq -n --arg body "$BODY" '{"fields":{"description":$body}}')

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X PUT \
  -u "$JIRA_USERNAME:$JIRA_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d "$PAYLOAD" \
  "$BASE_URL/rest/api/2/issue/$TICKET_ID")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  echo "Error: update failed (HTTP $HTTP_CODE)" >&2
  RESP_BODY=$(echo "$RESPONSE" | head -n -1)
  echo "$RESP_BODY" | jq -r '.errorMessages[]? // empty' >&2 2>/dev/null || true
  exit 1
fi

echo "Updated $TICKET_ID description."
