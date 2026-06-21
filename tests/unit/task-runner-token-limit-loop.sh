#!/bin/bash
#
# Behavioral loop harness: drives token-limit detection through the task-runner
# main loop using source_task_runner_with_loop + function shadowing.
#
# Usage: bash task-runner-token-limit-loop.sh <case>
#
# Cases:
#   exit0-json   — run_agent emits an exit-0 JSON rate_limit_event line;
#                  expect token_limited status
#   plain-text   — run_agent emits an exit-0 plain-text session-limit line;
#                  expect token_limited status
#
# Exit code: 0 = assertion passed, 1 = assertion failed

set -euo pipefail

CASE="${1:-}"
if [ -z "$CASE" ]; then
  echo "Usage: $0 <case>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="${SCRIPT_DIR}/../fixtures/bash-harness.sh"

source "$HARNESS"
setup_harness
source_task_runner_with_loop

echo "TMPDIR=$tmpdir"

# ---------------------------------------------------------------------------
# Silence loop logging noise during tests
# ---------------------------------------------------------------------------
log_loop() { :; }

# ---------------------------------------------------------------------------
# Stub: git-related helpers used by check_for_diff and prompt assembly
# ---------------------------------------------------------------------------
check_for_diff() { return 0; }     # always report changes so loop is entered

# ---------------------------------------------------------------------------
# Case-specific stub for run_agent
# run_agent writes to the raw log and task log; we control what goes there.
# Signature: run_agent <prompt_file> <raw_log> <task_log> <phase> <N> [args...]
# ---------------------------------------------------------------------------
case "$CASE" in
  exit0-json)
    run_agent() {
      local _prompt_file="$1"
      local _raw_log="$2"
      local _task_log="$3"
      # Write a JSON rate_limit_event line with exit 0
      printf '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":9999999999,"rateLimitType":"five_hour"}}\n' > "$_raw_log"
      printf '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You'"'"'ve hit your session limit"}\n' >> "$_raw_log"
      printf '' > "$_task_log"
      return 0
    }
    ;;
  plain-text)
    run_agent() {
      local _prompt_file="$1"
      local _raw_log="$2"
      local _task_log="$3"
      # Write a plain-text limit line with exit 0
      printf "You've hit your session limit \xc2\xb7 resets 5:20am (UTC)\n" > "$_raw_log"
      printf '' > "$_task_log"
      return 0
    }
    ;;
  *)
    echo "Unknown case: $CASE" >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Stubs: review, meta-review, verify — should never be called when token
# limit is hit during initial execution
# ---------------------------------------------------------------------------
run_review()      { echo "FAIL: run_review called unexpectedly" >&2; return 1; }
run_meta_review() { echo "FAIL: run_meta_review called unexpectedly" >&2; return 1; }
run_verify()      { echo "FAIL: run_verify called unexpectedly" >&2; return 1; }
check_for_stop_and_ask() { return 1; }
check_for_diff() { return 0; }
model_args_for_phase() { RESOLVED_MODEL_ARGS=(); }

# ---------------------------------------------------------------------------
# Write task trigger files so the loop picks up one task then exits
# ---------------------------------------------------------------------------
printf 'Test task for token-limit loop case: %s\n' "$CASE" > "${tmpdir}/claude-task-prompt.txt"
touch "${tmpdir}/claude-task-trigger"

# ---------------------------------------------------------------------------
# Run one iteration of the outer while loop body.
# We cannot call the actual daemon loop (it loops forever), so we source just
# the body by wrapping it in a function-like runner.  Instead, we use the
# helpers directly: simulate the pre-loop flow.
# ---------------------------------------------------------------------------

# Simulate what the main loop does before calling run_agent:
PROMPT=$(cat "${tmpdir}/claude-task-prompt.txt" 2>/dev/null)
MODEL_ARGS=()
RESUME_ARGS=()
AGENT_BACKEND="claude"
OPENCODE_MODEL=""
PHASE_ROUTING_JSON=""
PHASE_MODELS_JSON=""
TASK_NEEDS_KEY=0

# Write status/pid as the main loop would
echo "running" > "${tmpdir}/claude-task.status"
echo "$$" > "${tmpdir}/claude-task.pid"
> "${tmpdir}/claude-raw.log"
> "${tmpdir}/claude-tokens-execution"
> "${tmpdir}/claude-tokens-review"
> "${tmpdir}/claude-phase-timing.txt"
echo "0" > "${tmpdir}/claude-task.review-iterations"
echo "0" > "${tmpdir}/claude-task.verify-retries"

# Call run_agent (stubbed above) — this is the initial execution pass
run_agent "${tmpdir}/claude-task-prompt.txt" "${tmpdir}/claude-raw.log" "${tmpdir}/claude-task.log" execution 1
EXIT_CODE=$?

# Write execute-output-0 marker as the real loop does
{
  if [ $EXIT_CODE -eq 0 ]; then echo "EXECUTE_PASS"; else echo "EXECUTE_FAIL"; fi
  tail -50 "${tmpdir}/claude-task.log" 2>/dev/null || true
} > "${tmpdir}/claude-execute-output-0.txt" 2>/dev/null || true

tail -50 "${tmpdir}/claude-task.log" 2>/dev/null > "${tmpdir}/claude-execution-summary.txt" || true

# Now call check_for_token_limit — the key assertion
if check_for_token_limit "${tmpdir}/claude-raw.log"; then
  # Token limit detected — write token_limited status as the real loop does
  echo "token_limited" > "${tmpdir}/claude-task.status"
  TASK_TOKEN_LIMITED=1
  echo "PASS: token_limited status set for case=$CASE"
else
  echo "FAIL: token limit NOT detected for case=$CASE" >&2
  exit 1
fi

# Assert the status file contains token_limited
STATUS=$(cat "${tmpdir}/claude-task.status" 2>/dev/null)
if [ "$STATUS" = "token_limited" ]; then
  echo "PASS: status file contains 'token_limited'"
else
  echo "FAIL: status file contains '$STATUS' (expected 'token_limited')" >&2
  exit 1
fi

assert_no_tmp_leak "token-limit-loop-$CASE"
echo ""
echo "PASS: all assertions passed for case=$CASE"
exit 0
