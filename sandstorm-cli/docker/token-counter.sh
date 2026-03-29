#!/bin/bash
#
# Inline token counter for Claude CLI stream-json output.
# Reads JSON lines from stdin, extracts token counts from "result" messages,
# and appends one line per result to the output file.
#
# Usage: token-counter.sh <output-file>
#
# Each appended line has the format: {"in":N,"out":N}
#

OUTPUT_FILE="${1:?Usage: token-counter.sh <output-file>}"

while IFS= read -r line; do
  # Quick check before invoking jq — skip lines that can't be result messages
  case "$line" in
    *'"type":"result"'*|*'"type": "result"'*)
      # Extract input_tokens and output_tokens from usage field
      tokens=$(echo "$line" | jq -c '{in: (.usage.input_tokens // 0), out: (.usage.output_tokens // 0)}' 2>/dev/null)
      if [ -n "$tokens" ] && [ "$tokens" != '{"in":0,"out":0}' ]; then
        echo "$tokens" >> "$OUTPUT_FILE"
      fi
      ;;
  esac
done
