#!/bin/bash
#
# Inline token counter for Claude CLI stream-json output.
# Reads JSON lines from stdin, extracts token counts from streaming events,
# and appends one line per event to the output file.
#
# Captures intermediate token data from message_start and message_delta events
# (as partial:true entries) in addition to final counts from result events.
#
# Usage: token-counter.sh <output-file> [iteration] [phase]
#
# Each appended line has the format:
#   Partial: {"in":N,"out":N,"iter":I,"phase":"P","partial":true}
#   Final:   {"in":N,"out":N,"iter":I,"phase":"P"}
# When iteration/phase are omitted, those fields are excluded (backward compat).
#
# stream_event wrapper handling: Claude CLI emits events wrapped as
# {"type":"stream_event","event":{...}}. We use jq '.event // .' to unwrap,
# which handles both bare events and stream_event-wrapped events.
#

OUTPUT_FILE="${1:?Usage: token-counter.sh <output-file> [iteration] [phase]}"
ITERATION="${2:-}"
PHASE="${3:-}"

# Track current turn's input tokens (set by message_start, used by message_delta)
current_input=0

# Build jq metadata suffix for output objects
if [ -n "$ITERATION" ] && [ -n "$PHASE" ]; then
  META=', iter: '"$ITERATION"', phase: "'"$PHASE"'"'
else
  META=''
fi

while IFS= read -r line; do
  # Quick check — skip lines that clearly don't contain relevant events
  case "$line" in
    *'"type":"result"'*|*'"type": "result"'*|\
    *'message_start'*|*'message_delta'*)
      # Unwrap stream_event wrapper: .event // . gives the inner event for both
      # stream_event-wrapped lines and bare event lines
      event=$(echo "$line" | jq -c '.event // .' 2>/dev/null)
      [ -z "$event" ] && continue

      event_type=$(echo "$event" | jq -r '.type // ""' 2>/dev/null)

      case "$event_type" in
        message_start)
          in_tokens=$(echo "$event" | jq -r '(.message.usage.input_tokens // 0)' 2>/dev/null)
          current_input="${in_tokens:-0}"
          if [ "${current_input:-0}" -gt 0 ] 2>/dev/null; then
            tokens=$(echo "$event" | jq -c "{in: (.message.usage.input_tokens // 0), out: 0${META}, partial: true}" 2>/dev/null)
            [ -n "$tokens" ] && echo "$tokens" >> "$OUTPUT_FILE"
          fi
          ;;
        message_delta)
          out_tokens=$(echo "$event" | jq -r '(.usage.output_tokens // 0)' 2>/dev/null)
          if [ "${out_tokens:-0}" -gt 0 ] 2>/dev/null; then
            tokens=$(echo "$event" | jq -c "{in: ${current_input:-0}, out: (.usage.output_tokens // 0)${META}, partial: true}" 2>/dev/null)
            [ -n "$tokens" ] && echo "$tokens" >> "$OUTPUT_FILE"
          fi
          ;;
        result)
          # result is always at top level (never wrapped in stream_event)
          # event == line here since .event // . returns . when .event is null
          in_tokens=$(echo "$event" | jq -r '(.usage.input_tokens // 0)' 2>/dev/null)
          out_tokens=$(echo "$event" | jq -r '(.usage.output_tokens // 0)' 2>/dev/null)
          if [ "${in_tokens:-0}" -gt 0 ] || [ "${out_tokens:-0}" -gt 0 ]; then
            tokens=$(echo "$event" | jq -c "{in: (.usage.input_tokens // 0), out: (.usage.output_tokens // 0)${META}}" 2>/dev/null)
            [ -n "$tokens" ] && echo "$tokens" >> "$OUTPUT_FILE"
            current_input=0
          fi
          ;;
      esac
      ;;
  esac
done
