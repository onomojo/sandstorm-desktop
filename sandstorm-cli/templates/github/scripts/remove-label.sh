#!/bin/bash
#
# remove-label.sh — Remove a label from a GitHub issue.
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

gh issue edit "$TICKET_ID" --remove-label "$LABEL" 2>&1 || {
  echo "Error: Failed to remove label '$LABEL' from issue $TICKET_ID. Is 'gh' installed and authenticated?" >&2
  exit 1
}
