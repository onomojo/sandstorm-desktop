#!/bin/bash
#
# create-pr.sh — Create a pull request.
#
# CONTRACT:
#   Input:  --title <title> [--body <body> | --body-file <path>] --base <branch> --head <branch>
#     --body      inline body (short, single-line-safe)
#     --body-file path to a file containing the body; use "-" to read from stdin
#   Output: PR URL to stdout
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
# Replace the body of this script with your git hosting platform's CLI or API call.
# For GitHub: gh pr create
# For GitLab: glab mr create
# For Bitbucket: use the REST API
#
set -euo pipefail

TITLE=""
BODY=""
BODY_FILE=""
BASE="main"
HEAD=""

while [ $# -gt 0 ]; do
  case "$1" in
    --title)     TITLE="$2"; shift 2 ;;
    --body)      BODY="$2"; shift 2 ;;
    --body-file) BODY_FILE="$2"; shift 2 ;;
    --base)      BASE="$2"; shift 2 ;;
    --head)      HEAD="$2"; shift 2 ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: create-pr.sh --title <title> [--body <body>|--body-file <path>] --base <branch> --head <branch>" >&2
      exit 1
      ;;
  esac
done

if [ -z "$TITLE" ]; then
  echo "Error: --title is required" >&2
  exit 1
fi

echo "Error: create-pr.sh is not configured." >&2
echo "Edit .sandstorm/scripts/create-pr.sh to connect to your git hosting platform." >&2
exit 1
