#!/bin/bash
#
# Normalize OpenCode NDJSON stream (--format json output) to the same
# formatted-text shape that run_claude / jq produces from Claude stream-json.
#
# Verified real schema (opencode-ai@1.17.7, captured 2026-06-18):
#   Each line: { "type": <t>, "timestamp": N, "sessionID": "…", "part": { … } }
#
# Mapping:
#   type=text       → emit .part.text as-is (text delta)
#   type=tool_use   → emit "\n── <.part.tool> ──\n" marker
#   type=step_finish → emit nothing (text already streamed; real schema has no result field)
#   type=error      → emit "\n❌ ERROR: <message>\n" (unverified envelope; keep defensively)
#
# Reads NDJSON from stdin; writes formatted text to stdout.
# Used by run_opencode() in task-runner.sh and tested independently.
#
jq -rj --unbuffered '
  if .type == "text" then
    .part.text // ""
  elif .type == "tool_use" then
    "\n── \(.part.tool) ──\n"
  elif .type == "step_finish" then
    empty
  elif .type == "error" then
    "\n❌ ERROR: " + (.message // "unknown error") + "\n"
  else
    empty
  end
' 2>/dev/null
