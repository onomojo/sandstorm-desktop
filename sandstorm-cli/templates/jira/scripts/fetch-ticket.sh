#!/bin/bash
#
# fetch-ticket.sh — Fetch a Jira ticket using the Atlassian MCP tools.
#
# Prerequisites:
#   - Atlassian MCP Python server must be running and configured
#   - Claude must have access to the mcp__atlassian__* tools
#
# Contract:
#   Input:  ticket identifier (Jira key, e.g., PROJ-123)
#   Output: standardized markdown to stdout (title, body, comments, labels, state, author)
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
# NOTE: This script is a placeholder. Jira integration requires the Atlassian
# MCP Python server. In practice, Claude reads this skill and uses the
# mcp__atlassian__get_issue tool directly. This script exists for the
# deterministic code path (stack-manager.ts context injection).
#
# To use without MCP, replace the body below with your preferred Jira API call
# (e.g., curl to the Jira REST API with appropriate auth).
#
set -euo pipefail

TICKET_ID="${1:-}"

if [ -z "$TICKET_ID" ]; then
  echo "Usage: fetch-ticket.sh <ticket-id>" >&2
  exit 1
fi

echo "Error: Jira fetch-ticket requires the Atlassian MCP server or a custom API integration." >&2
echo "Options:" >&2
echo "  1. Install the Atlassian MCP Python server (recommended)" >&2
echo "  2. Replace this script with a curl-based Jira REST API call" >&2
echo "  3. Use 'sandstorm init' with the Custom provider and implement your own" >&2
exit 1
