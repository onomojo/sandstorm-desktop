#!/bin/bash
#
# list-tickets.sh — List open Jira issues reported by the current user, filtered by label.
#
# Prerequisites (export in shell before launching the app):
#   JIRA_URL        Site root, e.g. https://yourorg.atlassian.net
#   JIRA_USERNAME   Atlassian account email
#   JIRA_API_TOKEN  API token from https://id.atlassian.com/manage-profile/security/api-tokens
#
# Contract:
#   Input:  <label>   (positional — the label to filter by, e.g. "needs-spec")
#   Output: TSV with one line per issue: <key>\t<summary>\t<reporter-accountId>
#           Empty output (no lines) when no matching issues found.
#   Exit:   0 on success (including empty result), non-zero on failure (error to stderr)
#
# Notes:
#   - Uses reporter = currentUser() JQL — filters server-side to the authenticated user
#   - accountId is used as identity (stable, always present on Jira Cloud)
#
set -euo pipefail

LABEL="${1:-}"

if [ -z "$LABEL" ]; then
  echo "Usage: list-tickets.sh <label>" >&2
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
JQL="reporter = currentUser() AND labels = \"${LABEL}\" AND statusCategory != Done"
ENCODED_JQL=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$JQL")

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -u "$JIRA_USERNAME:$JIRA_API_TOKEN" \
  -H "Accept: application/json" \
  "${BASE_URL}/rest/api/2/search?jql=${ENCODED_JQL}&fields=summary,reporter&maxResults=50")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  echo "Error: Jira API returned HTTP $HTTP_CODE" >&2
  echo "$BODY" | jq -r '.errorMessages[]? // empty' >&2 2>/dev/null || true
  exit 1
fi

echo "$BODY" | jq -r '.issues[] | "\(.key)\t\(.fields.summary)\t\(.fields.reporter.accountId // "")"'
