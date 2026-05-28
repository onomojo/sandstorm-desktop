#!/bin/bash
#
# list-tickets.sh — List open GitHub issues authored by the current user, filtered by label.
#
# Contract:
#   Input:  <label>   (positional — the label to filter by, e.g. "needs-spec")
#   Output: TSV with one line per issue: <number>\t<title>\t<author-login>
#           Empty output (no lines) when no matching issues found.
#   Exit:   0 on success (including empty result), non-zero on failure (error to stderr)
#
# Notes:
#   - Only returns open issues (excludes PRs — gh issue list excludes PRs by default)
#   - Filtered server-side to issues authored by the current authenticated user (@me)
#
set -euo pipefail

LABEL="${1:-}"

if [ -z "$LABEL" ]; then
  echo "Usage: list-tickets.sh <label>" >&2
  exit 1
fi

gh issue list \
  --label "$LABEL" \
  --state open \
  --author @me \
  --json number,title,author \
  --jq '.[] | "\(.number)\t\(.title)\t\(.author.login)"' 2>&1 || {
  echo "Error: Failed to list issues. Is 'gh' installed and authenticated?" >&2
  exit 1
}
