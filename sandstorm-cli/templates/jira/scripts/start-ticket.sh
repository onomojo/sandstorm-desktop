#!/bin/bash
#
# start-ticket.sh — Mark a Jira ticket as started.
#
# Prerequisites:
#   - Atlassian MCP Python server or Jira REST API access
#
# Contract:
#   Input:  ticket identifier (Jira key, e.g., PROJ-123)
#   Action: assigns ticket and transitions to "In Progress"
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
set -euo pipefail

TICKET_ID="${1:-}"

if [ -z "$TICKET_ID" ]; then
  echo "Usage: start-ticket.sh <ticket-id>" >&2
  exit 1
fi

echo "Error: Jira start-ticket requires the Atlassian MCP server or a custom API integration." >&2
echo "Replace this script with your Jira REST API call to transition the ticket." >&2
exit 1
