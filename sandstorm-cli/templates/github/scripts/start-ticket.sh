#!/bin/bash
#
# start-ticket.sh — Mark a GitHub issue as started.
#
# Contract:
#   Input:  ticket identifier (GitHub issue number, e.g., 162)
#   Action: adds "in-progress" label and assigns to current user
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
set -euo pipefail

TICKET_ID="${1:-}"

if [ -z "$TICKET_ID" ]; then
  echo "Usage: start-ticket.sh <ticket-id>" >&2
  exit 1
fi

# Strip leading # if present
TICKET_ID="${TICKET_ID#\#}"

gh issue edit "$TICKET_ID" --add-label "in-progress" --add-assignee "@me" 2>&1 || {
  echo "Error: Failed to update issue #${TICKET_ID}. Is 'gh' installed and authenticated?" >&2
  exit 1
}

echo "Issue #${TICKET_ID} marked as in-progress and assigned to you."
