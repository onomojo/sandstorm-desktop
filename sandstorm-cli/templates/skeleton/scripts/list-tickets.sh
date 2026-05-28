#!/bin/bash
#
# list-tickets.sh — List open tickets for the current user with a given label.
#
# CONTRACT:
#   Input:  <label>   (positional — the label to filter by, e.g. "needs-spec")
#   Output: TSV with one line per ticket: <id>\t<title>\t<author-identity>
#           Empty output (no lines) when no matching tickets found.
#   Exit:   0 on success (including empty result), non-zero on failure (error to stderr)
#
# This stub is a clean no-op. Replace with your ticket system's API call.
# The output format above is what Sandstorm expects.
#
set -euo pipefail

# Intentionally empty — no tickets to process from an unconfigured system.
exit 0
