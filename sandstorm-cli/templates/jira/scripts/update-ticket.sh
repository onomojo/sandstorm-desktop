#!/bin/bash
#
# update-ticket.sh — Update a Jira ticket description.
#
# Prerequisites:
#   - Atlassian MCP Python server or Jira REST API access
#
# Contract:
#   Input:  <ticket-id> <body>
#   Action: updates the ticket description with the provided content
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
set -euo pipefail

TICKET_ID="${1:-}"
BODY="${2:-}"

if [ -z "$TICKET_ID" ] || [ -z "$BODY" ]; then
  echo "Usage: update-ticket.sh <ticket-id> <body>" >&2
  exit 1
fi

echo "Error: Jira update-ticket requires the Atlassian MCP server or a custom API integration." >&2
echo "Replace this script with your Jira REST API call to update the ticket description." >&2
exit 1
