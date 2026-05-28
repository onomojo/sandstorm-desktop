#!/bin/bash
#
# post-comment.sh — Post a comment on a GitHub issue.
#
# Contract:
#   Input:  <ticket-id> <body>
#   Action: posts a new comment with the given body
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
set -euo pipefail

TICKET_ID="${1:-}"
BODY="${2:-}"

if [ -z "$TICKET_ID" ] || [ -z "$BODY" ]; then
  echo "Usage: post-comment.sh <ticket-id> <body>" >&2
  exit 1
fi

gh issue comment "$TICKET_ID" --body "$BODY" 2>&1 || {
  echo "Error: Failed to post comment on issue $TICKET_ID. Is 'gh' installed and authenticated?" >&2
  exit 1
}
