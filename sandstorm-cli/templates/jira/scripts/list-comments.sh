#!/bin/bash
#
# list-comments.sh — List all comments on a Jira issue.
#
# Prerequisites (export in shell before launching the app):
#   JIRA_URL        Site root, e.g. https://yourorg.atlassian.net
#   JIRA_USERNAME   Atlassian account email
#   JIRA_API_TOKEN  API token from https://id.atlassian.com/manage-profile/security/api-tokens
#
# Contract:
#   Input:  <ticket-id>   (Jira key, e.g. PROJ-123)
#   Output: JSON array: [{"author":"<accountId>","body":"<text>","createdAt":"<iso>"}]
#           Empty array [] when no comments.
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
# Note: author field emits accountId (stable, privacy-safe Jira Cloud identifier)
#
set -euo pipefail

TICKET_ID="${1:-}"

if [ -z "$TICKET_ID" ]; then
  echo "Usage: list-comments.sh <ticket-id>" >&2
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

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -u "$JIRA_USERNAME:$JIRA_API_TOKEN" \
  -H "Accept: application/json" \
  "${BASE_URL}/rest/api/2/issue/${TICKET_ID}?fields=comment")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  echo "Error: Jira API returned HTTP $HTTP_CODE" >&2
  echo "$BODY" | jq -r '.errorMessages[]? // empty' >&2 2>/dev/null || true
  exit 1
fi

echo "$BODY" | jq '[.fields.comment.comments[] | {author: .author.accountId, body: .body, createdAt: .created}]'
