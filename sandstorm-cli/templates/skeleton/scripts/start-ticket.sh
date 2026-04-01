#!/bin/bash
#
# start-ticket.sh — Mark a ticket as started.
#
# CONTRACT:
#   Input:  ticket identifier
#   Action: mark the ticket as in-progress (assign, label, transition — whatever your system uses)
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
# Replace the body of this script with your ticket system's API call.
#
set -euo pipefail

TICKET_ID="${1:-}"

if [ -z "$TICKET_ID" ]; then
  echo "Usage: start-ticket.sh <ticket-id>" >&2
  exit 1
fi

echo "Error: start-ticket.sh is not configured." >&2
echo "Edit .sandstorm/scripts/start-ticket.sh to connect to your ticket system." >&2
exit 1
