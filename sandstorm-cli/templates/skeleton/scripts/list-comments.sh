#!/bin/bash
#
# list-comments.sh — List all comments on a ticket.
#
# CONTRACT:
#   Input:  <ticket-id>
#   Output: JSON array: [{"author":"<identity>","body":"<text>","createdAt":"<iso>"}]
#           Empty array [] when no comments.
#   Exit:   0 on success, non-zero on failure (error to stderr)
#
# This stub returns an empty array. Replace with your ticket system's API call.
#
set -euo pipefail

echo "[]"
exit 0
