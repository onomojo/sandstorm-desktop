#!/bin/bash
#
# create-ticket.sh — File a new Jira issue via the Jira Cloud REST API v2.
#
# Prerequisites (export in shell before launching the app):
#   JIRA_URL          Site root, e.g. https://yourorg.atlassian.net
#   JIRA_USERNAME     Atlassian account email
#   JIRA_API_TOKEN    API token from https://id.atlassian.com/manage-profile/security/api-tokens
#   JIRA_PROJECT_KEY  Project key the issue is filed under (e.g. PROJ)
#
# Optional:
#   JIRA_ISSUE_TYPE   Issue type name (default: "Task")
#
# Contract:
#   Input:  <title> <body>
#   Output: URL of the created issue on stdout (final non-empty line)
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
set -euo pipefail

TITLE="${1:-}"
BODY="${2:-}"

if [ -z "$TITLE" ] || [ -z "$BODY" ]; then
  echo "Usage: create-ticket.sh <title> <body>" >&2
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
[ -z "${JIRA_PROJECT_KEY:-}" ] && missing_vars+=("JIRA_PROJECT_KEY")
if [ ${#missing_vars[@]} -gt 0 ]; then
  echo "Error: missing required environment variables: ${missing_vars[*]}" >&2
  echo "Export them in your shell environment and restart the desktop app." >&2
  exit 1
fi

ISSUE_TYPE="${JIRA_ISSUE_TYPE:-Task}"

BASE_URL="${JIRA_URL%/}"
if echo "$BASE_URL" | grep -qE '^https?://[^/]+/.+'; then
  echo "Error: JIRA_URL must be the site root (e.g. https://yourorg.atlassian.net), not a REST path." >&2
  exit 1
fi

PAYLOAD=$(jq -n \
  --arg key "$JIRA_PROJECT_KEY" \
  --arg summary "$TITLE" \
  --arg description "$BODY" \
  --arg issuetype "$ISSUE_TYPE" \
  '{"fields":{"project":{"key":$key},"summary":$summary,"description":$description,"issuetype":{"name":$issuetype}}}')

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -u "$JIRA_USERNAME:$JIRA_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d "$PAYLOAD" \
  "$BASE_URL/rest/api/2/issue")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
RESP_BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  echo "Error: Jira API returned HTTP $HTTP_CODE" >&2
  echo "$RESP_BODY" | jq -r '.errorMessages[]? // empty' >&2 2>/dev/null || true
  echo "$RESP_BODY" | jq -r '.errors // {} | to_entries[]? | "  " + .key + ": " + (.value|tostring)' >&2 2>/dev/null || true
  exit 1
fi

ISSUE_KEY=$(echo "$RESP_BODY" | jq -r '.key // empty')
if [ -z "$ISSUE_KEY" ]; then
  echo "Error: Jira API response did not include an issue key." >&2
  exit 1
fi

echo "${BASE_URL}/browse/${ISSUE_KEY}"
