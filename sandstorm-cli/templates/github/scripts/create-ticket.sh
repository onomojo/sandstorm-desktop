#!/bin/bash
#
# create-ticket.sh — File a new GitHub issue.
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

gh issue create --title "$TITLE" --body "$BODY" || {
  echo "Error: Failed to create issue. Is 'gh' installed and authenticated?" >&2
  exit 1
}
