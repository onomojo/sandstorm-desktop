#!/bin/bash
#
# create-ticket.sh — File a new ticket.
#
# CONTRACT:
#   Input:  <title> <body>
#   Output: URL of the created ticket on stdout (final non-empty line)
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
# Replace the body of this script with your ticket system's API call.
# If your ticket system doesn't support programmatic creation, this script
# can print a message telling the user to file the ticket manually and
# exit non-zero so the UI surfaces the limitation.
#
set -euo pipefail

TITLE="${1:-}"
BODY="${2:-}"

if [ -z "$TITLE" ] || [ -z "$BODY" ]; then
  echo "Usage: create-ticket.sh <title> <body>" >&2
  exit 1
fi

echo "Error: create-ticket.sh is not configured." >&2
echo "Edit .sandstorm/scripts/create-ticket.sh to connect to your ticket system." >&2
exit 1
