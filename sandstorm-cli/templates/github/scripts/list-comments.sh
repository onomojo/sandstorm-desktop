#!/bin/bash
#
# list-comments.sh — List all comments on a GitHub issue.
#
# Contract:
#   Input:  <ticket-id>   (GitHub issue number)
#   Output: JSON array: [{"author":"<login>","body":"<text>","createdAt":"<iso>"}]
#           Empty array [] when no comments.
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
set -euo pipefail

TICKET_ID="${1:-}"

if [ -z "$TICKET_ID" ]; then
  echo "Usage: list-comments.sh <ticket-id>" >&2
  exit 1
fi

gh issue view "$TICKET_ID" \
  --json comments \
  --jq '[.comments[] | {author: .author.login, body: .body, createdAt: .createdAt}]' 2>&1 || {
  echo "Error: Failed to list comments. Is 'gh' installed and authenticated?" >&2
  exit 1
}
