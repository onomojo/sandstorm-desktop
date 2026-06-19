#!/bin/bash
#
# Token counter for OpenCode NDJSON output (--format json mode).
# Reads NDJSON lines from stdin, extracts token counts from step_finish events,
# and appends one line per event to the output file.
#
# Verified real schema (opencode-ai@1.17.7, captured 2026-06-18):
#   step_finish line: { "type": "step_finish", …, "part": { …, "tokens": {
#     "input": N, "output": N, "cache": { "write": N, "read": N } } } }
#
# Token mapping:
#   .part.tokens.input        → in
#   .part.tokens.output       → out
#   .part.tokens.cache.write  → cc (cache write / creation)
#   .part.tokens.cache.read   → cr (cache read / hit)
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
      in_tokens=$(echo "$line" | jq -r '.part.tokens.input // 0' 2>/dev/null)
      out_tokens=$(echo "$line" | jq -r '.part.tokens.output // 0' 2>/dev/null)
      cc_tokens=$(echo "$line" | jq -r '(.part.tokens.cache.write // 0)' 2>/dev/null)
      cr_tokens=$(echo "$line" | jq -r '(.part.tokens.cache.read // 0)' 2>/dev/null)

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
