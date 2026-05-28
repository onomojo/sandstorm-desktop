#!/bin/bash
#
# add-label.sh — Add a label to a GitHub issue.
#
# Contract:
#   Input:  <ticket-id> <label>
#   Action: adds the label to the issue
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
set -euo pipefail

TICKET_ID="${1:-}"
LABEL="${2:-}"

if [ -z "$TICKET_ID" ] || [ -z "$LABEL" ]; then
  echo "Usage: add-label.sh <ticket-id> <label>" >&2
  exit 1
fi

gh issue edit "$TICKET_ID" --add-label "$LABEL" 2>&1 || {
  echo "Error: Failed to add label '$LABEL' to issue $TICKET_ID. Is 'gh' installed and authenticated?" >&2
  exit 1
}
