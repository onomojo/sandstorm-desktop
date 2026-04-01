#!/bin/bash
#
# update-ticket.sh — Update a GitHub issue body.
#
# Contract:
#   Input:  <ticket-id> <body>
#   Action: updates the issue body with the provided content
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
set -euo pipefail

TICKET_ID="${1:-}"
BODY="${2:-}"

if [ -z "$TICKET_ID" ] || [ -z "$BODY" ]; then
  echo "Usage: update-ticket.sh <ticket-id> <body>" >&2
  exit 1
fi

# Strip leading # if present
TICKET_ID="${TICKET_ID#\#}"

gh issue edit "$TICKET_ID" --body "$BODY" 2>&1 || {
  echo "Error: Failed to update issue #${TICKET_ID}. Is 'gh' installed and authenticated?" >&2
  exit 1
}

echo "Issue #${TICKET_ID} updated."
