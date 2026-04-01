#!/bin/bash
#
# fetch-ticket.sh — Fetch a ticket by ID.
#
# CONTRACT:
#   Input:  ticket identifier (e.g., 162, PROJ-123, or any format your system uses)
#   Output: standardized markdown to stdout with the following structure:
#
#     # Issue: <title>
#
#     Labels: <comma-separated labels>     (optional, omit if no labels)
#     State: <state>
#     Author: @<author>
#     Created: <ISO timestamp>
#
#     ## Description
#
#     <ticket body>
#
#     ## Comments                           (optional, omit if no comments)
#
#     ### @<author> — <ISO timestamp>
#
#     <comment body>
#
#   Exit: 0 on success, non-zero on failure (error to stderr)
#
# Replace the body of this script with your ticket system's API call.
# The output format above is what Sandstorm expects — match it so that
# the spec quality gate and task dispatch work correctly.
#
set -euo pipefail

TICKET_ID="${1:-}"

if [ -z "$TICKET_ID" ]; then
  echo "Usage: fetch-ticket.sh <ticket-id>" >&2
  exit 1
fi

echo "Error: fetch-ticket.sh is not configured." >&2
echo "Edit .sandstorm/scripts/fetch-ticket.sh to connect to your ticket system." >&2
echo "See the script comments for the expected output format." >&2
exit 1
