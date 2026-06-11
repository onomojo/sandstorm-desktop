#!/bin/bash
#
# Token counter for OpenCode NDJSON output (--format json mode).
# Reads NDJSON lines from stdin, extracts token counts from step_finish events,
# and appends one line per event to the output file.
#
# Token mapping from OpenCode step_finish:
#   tokens.input  → in
#   tokens.output → out
#   tokens.cache_write (or 0 when absent) → cc
#   tokens.cache_read (preferred) or tokens.cache (single field) → cr
#
# Usage: opencode-token-counter.sh <output-file> [iteration] [phase]
#
# Each appended line has the format:
#   {"in":N,"out":N,"cc":N,"cr":N[,"iter":I,"phase":"P"]}
#

OUTPUT_FILE="${1:?Usage: opencode-token-counter.sh <output-file> [iteration] [phase]}"
ITERATION="${2:-}"
PHASE="${3:-}"

while IFS= read -r line; do
  case "$line" in
    *'"type":"step_finish"'*|*'"type": "step_finish"'*)
      in_tokens=$(echo "$line" | jq -r '.tokens.input // 0' 2>/dev/null)
      out_tokens=$(echo "$line" | jq -r '.tokens.output // 0' 2>/dev/null)
      # cache_write maps to cc; if absent, 0
      cc_tokens=$(echo "$line" | jq -r '(.tokens.cache_write // 0)' 2>/dev/null)
      # cache_read takes priority over single cache field; both fall back to 0
      cr_tokens=$(echo "$line" | jq -r '(.tokens.cache_read // .tokens.cache // 0)' 2>/dev/null)

      if [ "${in_tokens:-0}" -gt 0 ] || [ "${out_tokens:-0}" -gt 0 ] 2>/dev/null; then
        entry="{\"in\":${in_tokens:-0},\"out\":${out_tokens:-0},\"cc\":${cc_tokens:-0},\"cr\":${cr_tokens:-0}"
        if [ -n "$ITERATION" ] && [ -n "$PHASE" ]; then
          entry="${entry},\"iter\":${ITERATION},\"phase\":\"${PHASE}\""
        fi
        entry="${entry}}"
        echo "$entry" >> "$OUTPUT_FILE"
      fi
      ;;
  esac
done
