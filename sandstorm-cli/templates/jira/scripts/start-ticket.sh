#!/bin/bash
#
# start-ticket.sh — Transition a Jira ticket to "In Progress" and assign it to the current user.
#
# Prerequisites (export in shell before launching the app):
#   JIRA_URL        Site root, e.g. https://yourorg.atlassian.net
#   JIRA_USERNAME   Atlassian account email
#   JIRA_API_TOKEN  API token from https://id.atlassian.com/manage-profile/security/api-tokens
#
# Contract:
#   Input:  ticket identifier (Jira key, e.g., PROJ-123)
#   Action: transitions ticket to "In Progress" and assigns it to the authenticated user
#   Exit:   0 on success (including partial: transition OK, assignment failed), non-zero on failure
#
set -euo pipefail

TICKET_ID="${1:-}"

if [ -z "$TICKET_ID" ]; then
  echo "Usage: start-ticket.sh <ticket-id>" >&2
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

# Fetch available transitions
TRANS_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -u "$JIRA_USERNAME:$JIRA_API_TOKEN" \
  -H "Accept: application/json" \
  "$BASE_URL/rest/api/2/issue/$TICKET_ID/transitions")

HTTP_CODE=$(echo "$TRANS_RESPONSE" | tail -1)
TRANS_BODY=$(echo "$TRANS_RESPONSE" | head -n -1)

if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  echo "Error: failed to fetch transitions (HTTP $HTTP_CODE)" >&2
  exit 1
fi

# Find "In Progress" — exact match (case-insensitive), then fuzzy "progress" fallback
TRANSITION_ID=$(echo "$TRANS_BODY" | jq -r '
  .transitions |
  (map(select(.name | ascii_downcase == "in progress")) | .[0].id) //
  (map(select(.name | ascii_downcase | contains("progress"))) | .[0].id) //
  empty
')

if [ -z "$TRANSITION_ID" ]; then
  echo "Error: no 'In Progress' transition found for $TICKET_ID." >&2
  echo "Available transitions:" >&2
  echo "$TRANS_BODY" | jq -r '.transitions[] | "  - " + .name' >&2
  exit 1
fi

# POST the transition
TRANS_POST=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -u "$JIRA_USERNAME:$JIRA_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d "{\"transition\":{\"id\":\"$TRANSITION_ID\"}}" \
  "$BASE_URL/rest/api/2/issue/$TICKET_ID/transitions")

HTTP_CODE=$(echo "$TRANS_POST" | tail -1)
if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  echo "Error: transition request failed (HTTP $HTTP_CODE)" >&2
  exit 1
fi

echo "Transitioned $TICKET_ID to In Progress."

# Get current user accountId
MYSELF_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -u "$JIRA_USERNAME:$JIRA_API_TOKEN" \
  -H "Accept: application/json" \
  "$BASE_URL/rest/api/2/myself")

HTTP_CODE=$(echo "$MYSELF_RESPONSE" | tail -1)
MYSELF_BODY=$(echo "$MYSELF_RESPONSE" | head -n -1)

if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  echo "Warning: could not retrieve account info (HTTP $HTTP_CODE) — skipping assignment." >&2
  exit 0
fi

ACCOUNT_ID=$(echo "$MYSELF_BODY" | jq -r '.accountId // empty')
if [ -z "$ACCOUNT_ID" ]; then
  echo "Warning: could not extract accountId — skipping assignment." >&2
  exit 0
fi

# Assign the ticket to the current user
ASSIGN_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X PUT \
  -u "$JIRA_USERNAME:$JIRA_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d "{\"accountId\":\"$ACCOUNT_ID\"}" \
  "$BASE_URL/rest/api/2/issue/$TICKET_ID/assignee")

HTTP_CODE=$(echo "$ASSIGN_RESPONSE" | tail -1)
if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  echo "Warning: assignment failed (HTTP $HTTP_CODE) — ticket transitioned but not assigned." >&2
  exit 0
fi

echo "Assigned $TICKET_ID to $JIRA_USERNAME."
