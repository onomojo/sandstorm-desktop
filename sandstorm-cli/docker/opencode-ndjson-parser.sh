#!/bin/bash
#
# Normalize OpenCode NDJSON stream (--format json output) to the same
# formatted-text shape that run_claude / jq produces from Claude stream-json.
#
# Mapping:
#   type=text       → emit .content as-is (text delta)
#   type=tool_use   → emit "\n── <name> ──\n" marker
#   type=step_finish → emit "\n<result>\n"
#   type=error      → emit "\n❌ ERROR: <message>\n"
#
# Reads NDJSON from stdin; writes formatted text to stdout.
# Used by run_opencode() in task-runner.sh and tested independently.
#
jq -rj --unbuffered '
  if .type == "text" then
    .content // ""
  elif .type == "tool_use" then
    "\n── \(.name) ──\n"
  elif .type == "step_finish" then
    "\n" + (.result // "") + "\n"
  elif .type == "error" then
    "\n❌ ERROR: " + (.message // "unknown error") + "\n"
  else
    empty
  end
' 2>/dev/null
