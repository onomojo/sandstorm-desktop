#!/bin/bash
#
# create-pr.sh — Create a GitHub pull request.
#
# Contract:
#   Input:  --title <title> --body <body> --base <branch> --head <branch>
#   Output: PR URL to stdout
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
set -euo pipefail

TITLE=""
BODY=""
BASE="main"
HEAD=""

while [ $# -gt 0 ]; do
  case "$1" in
    --title)  TITLE="$2"; shift 2 ;;
    --body)   BODY="$2"; shift 2 ;;
    --base)   BASE="$2"; shift 2 ;;
    --head)   HEAD="$2"; shift 2 ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: create-pr.sh --title <title> --body <body> --base <branch> --head <branch>" >&2
      exit 1
      ;;
  esac
done

if [ -z "$TITLE" ]; then
  echo "Error: --title is required" >&2
  exit 1
fi

ARGS=(--title "$TITLE" --base "$BASE")

if [ -n "$BODY" ]; then
  ARGS+=(--body "$BODY")
fi

if [ -n "$HEAD" ]; then
  ARGS+=(--head "$HEAD")
fi

gh pr create "${ARGS[@]}" 2>&1 || {
  echo "Error: Failed to create pull request. Is 'gh' installed and authenticated?" >&2
  exit 1
}
