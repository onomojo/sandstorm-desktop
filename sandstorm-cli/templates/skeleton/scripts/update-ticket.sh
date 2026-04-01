#!/bin/bash
#
# update-ticket.sh — Update a ticket's body/description.
#
# CONTRACT:
#   Input:  <ticket-id> <body>
#   Action: replace the ticket body/description with the provided content
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
# Replace the body of this script with your ticket system's API call.
# If your ticket system doesn't support programmatic updates, this script
# can print a message telling the user to update manually and exit 0.
#
set -euo pipefail

TICKET_ID="${1:-}"
BODY="${2:-}"

if [ -z "$TICKET_ID" ] || [ -z "$BODY" ]; then
  echo "Usage: update-ticket.sh <ticket-id> <body>" >&2
  exit 1
fi

echo "Error: update-ticket.sh is not configured." >&2
echo "Edit .sandstorm/scripts/update-ticket.sh to connect to your ticket system." >&2
exit 1
