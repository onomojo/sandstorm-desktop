#!/bin/bash
#
# fetch-ticket.sh — Fetch a GitHub issue by number.
#
# Contract:
#   Input:  ticket identifier (GitHub issue number, e.g., 162)
#   Output: standardized markdown to stdout (title, body, comments, labels, state, author)
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
set -euo pipefail

TICKET_ID="${1:-}"

if [ -z "$TICKET_ID" ]; then
  echo "Usage: fetch-ticket.sh <ticket-id>" >&2
  exit 1
fi

# Strip leading # if present
TICKET_ID="${TICKET_ID#\#}"

JSON=$(gh issue view "$TICKET_ID" --json title,body,state,author,comments,labels,createdAt 2>&1) || {
  echo "Error: Failed to fetch issue #${TICKET_ID}. Is 'gh' installed and authenticated?" >&2
  exit 1
}

# Format the output as standardized markdown
python3 -c "
import json, sys

data = json.loads(sys.stdin.read())

print(f\"# Issue: {data['title']}\")
print()

labels = data.get('labels', [])
if labels:
    label_names = ', '.join(l['name'] for l in labels)
    print(f'Labels: {label_names}')

print(f\"State: {data['state']}\")
print(f\"Author: @{data['author']['login']}\")
print(f\"Created: {data['createdAt']}\")
print()
print('## Description')
print()
print(data.get('body', ''))

comments = data.get('comments', [])
if comments:
    print()
    print('## Comments')
    for c in comments:
        print()
        print(f\"### @{c['author']['login']} — {c['createdAt']}\")
        print()
        print(c['body'])
" <<< "$JSON"
