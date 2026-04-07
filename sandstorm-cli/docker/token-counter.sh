#!/bin/bash
#
# Inline token counter for Claude CLI stream-json output.
# Reads JSON lines from stdin, extracts token counts from "result" messages,
# and appends one line per result to the output file.
#
# Usage: token-counter.sh <output-file> [iteration] [phase]
#
# Each appended line has the format: {"in":N,"out":N,"iter":I,"phase":"P"}
# When iteration/phase are omitted, those fields are excluded (backward compat).
#

OUTPUT_FILE="${1:?Usage: token-counter.sh <output-file> [iteration] [phase]}"
ITERATION="${2:-}"
PHASE="${3:-}"

# Build jq filter based on available metadata
if [ -n "$ITERATION" ] && [ -n "$PHASE" ]; then
  JQ_FILTER='{in: (.usage.input_tokens // 0), out: (.usage.output_tokens // 0), iter: '"$ITERATION"', phase: "'"$PHASE"'"}'
else
  JQ_FILTER='{in: (.usage.input_tokens // 0), out: (.usage.output_tokens // 0)}'
fi

while IFS= read -r line; do
  # Quick check before invoking jq — skip lines that can't be result messages
  case "$line" in
    *'"type":"result"'*|*'"type": "result"'*)
      # Extract input_tokens and output_tokens from usage field
      tokens=$(echo "$line" | jq -c "$JQ_FILTER" 2>/dev/null)
      if [ -n "$tokens" ] && echo "$tokens" | jq -e '.in > 0 or .out > 0' >/dev/null 2>&1; then
        echo "$tokens" >> "$OUTPUT_FILE"
      fi
      ;;
  esac
done
