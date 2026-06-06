#!/bin/bash
#
# Behavioral smoke test: check_for_token_limit detects stream-json token-limit
# signals and plain-text lines, while ignoring false positives.
#
# Verifies these cases:
#   1. Plain-text limit line → detected (return 0)  [original bug repro]
#   2. No limit string at all → not detected (return 1)  [regression guard]
#   3. Limit phrase only inside agent-text JSON → not detected (return 1)  [false-positive guard]
#   4. Limit phrase in JSON + plain-text in same log → detected (return 0)  [discriminator]
#   5. JSON-only log with rate_limit_event (rejected) → detected (return 0)  [stream-json mode]
#   6. JSON-only log with result (is_error:true, api_error_status:429) → detected (return 0)
#   7. JSON rate_limit_event with non-rejected status → not detected (return 1)
#   8. JSON result with is_error:false → not detected (return 1)  [false-positive guard]
#
# Exit codes: 0 = all assertions pass, 1 = one or more assertions failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_RUNNER="$(realpath "$SCRIPT_DIR/../../sandstorm-cli/docker/task-runner.sh")"

if [ ! -f "$TASK_RUNNER" ]; then
  echo "SKIP: task-runner.sh not found at $TASK_RUNNER" >&2
  exit 0
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# ---------------------------------------------------------------------------
# Source check_for_token_limit from task-runner.sh.
# We extract only the helper-function block (everything before the main loop)
# so the main loop never executes.
# ---------------------------------------------------------------------------
FUNC_SOURCE=$(sed -n '1,/^# ─── Main Loop/p' "$TASK_RUNNER" | head -n -1)
eval "$FUNC_SOURCE"

# Override log_loop after sourcing to suppress internal output during tests.
log_loop() { :; }

FAIL=0

# ---------------------------------------------------------------------------
# Helper: run check_for_token_limit against a given log file and return its exit code
# ---------------------------------------------------------------------------
run_check() {
  local log_file="$1"
  check_for_token_limit "$log_file"
  return $?
}

# ---------------------------------------------------------------------------
# Case 1: Plain-text limit line → must be detected (return 0)
# This is the exact line from the originally-reported bug.
# ---------------------------------------------------------------------------
LOG1="$tmpdir/log-plain-text.log"
cat > "$LOG1" << 'EOF'
[LOOP] Starting initial execution pass...
You've hit your session limit · resets 5:20am (UTC)
You've hit your session limit · resets 5:20am (UTC)
[LOOP] Execution pass 1 complete, checking for STOP_AND_ASK...
EOF

if run_check "$LOG1"; then
  echo "PASS case 1: plain-text limit line detected"
else
  echo "FAIL case 1: plain-text limit line NOT detected — this is the originally-reported bug" >&2
  FAIL=1
fi

# ---------------------------------------------------------------------------
# Case 2: No limit string → must not be detected (return 1)
# Regression guard: a normal no-diff run must still be classified as completed.
# ---------------------------------------------------------------------------
LOG2="$tmpdir/log-no-limit.log"
cat > "$LOG2" << 'EOF'
[LOOP] Starting initial execution pass...
{"type":"assistant","message":{"content":[{"type":"text","text":"I will fix the bug now."}]}}
{"type":"result","is_error":false,"result":"done"}
[LOOP] Execution pass 1 complete, checking for STOP_AND_ASK...
EOF

if run_check "$LOG2"; then
  echo "FAIL case 2: false positive — no limit string present but detected" >&2
  FAIL=1
else
  echo "PASS case 2: no limit string correctly not detected"
fi

# ---------------------------------------------------------------------------
# Case 3: Limit phrase only in agent-text JSON (no rate_limit_event, no error result)
# → must NOT be detected (return 1). False-positive guard.
# ---------------------------------------------------------------------------
LOG3="$tmpdir/log-json-agent-text.log"
cat > "$LOG3" << 'EOF'
[LOOP] Starting initial execution pass...
{"type":"assistant","message":{"content":[{"type":"text","text":"You've hit your session limit"}]}}
{"type":"result","is_error":false,"result":"The task mentions: You've hit your session limit but that is just context"}
[LOOP] Execution pass 1 complete
EOF

if run_check "$LOG3"; then
  echo "FAIL case 3: false positive — phrase only inside agent-text JSON but was detected" >&2
  FAIL=1
else
  echo "PASS case 3: agent-text JSON phrase correctly not detected (false-positive guard)"
fi

# ---------------------------------------------------------------------------
# Case 4: Limit phrase inside JSON AND as a plain-text line → must be detected (return 0)
# Proves the guard discriminates by line shape rather than mere phrase absence.
# ---------------------------------------------------------------------------
LOG4="$tmpdir/log-json-plus-plain.log"
cat > "$LOG4" << 'EOF'
[LOOP] Starting initial execution pass...
{"type":"assistant","message":{"content":[{"type":"text","text":"You've hit your session limit context"}]}}
You've hit your session limit · resets 5:20am (UTC)
EOF

if run_check "$LOG4"; then
  echo "PASS case 4: detected when plain-text line present alongside JSON lines"
else
  echo "FAIL case 4: plain-text line not detected when JSON lines also present" >&2
  FAIL=1
fi

# ---------------------------------------------------------------------------
# Case 5: JSON-only log with rate_limit_event (status:rejected) → must be detected (return 0)
# This is the real stream-json mode signal that the original code missed.
# ---------------------------------------------------------------------------
LOG5="$tmpdir/log-json-rate-limit-event.log"
cat > "$LOG5" << 'EOF'
{"type":"system","subtype":"init","session_id":"sess-abc","tools":[]}
{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1780723200,"rateLimitType":"five_hour"}}
{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You've hit your session limit · resets 5:20am (UTC)","session_id":"sess-abc"}
EOF

if run_check "$LOG5"; then
  echo "PASS case 5: stream-json rate_limit_event (rejected) detected"
else
  echo "FAIL case 5: stream-json rate_limit_event (rejected) NOT detected — this is the key bug" >&2
  FAIL=1
fi

# ---------------------------------------------------------------------------
# Case 6: JSON-only log with result (is_error:true, api_error_status:429) only
# (no rate_limit_event line) → must be detected (return 0).
# ---------------------------------------------------------------------------
LOG6="$tmpdir/log-json-error-result.log"
cat > "$LOG6" << 'EOF'
{"type":"system","subtype":"init","session_id":"sess-def","tools":[]}
{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You've hit your session limit · resets 5:20am (UTC)","session_id":"sess-def"}
EOF

if run_check "$LOG6"; then
  echo "PASS case 6: stream-json error result (is_error:true, 429) detected"
else
  echo "FAIL case 6: stream-json error result (is_error:true, 429) NOT detected" >&2
  FAIL=1
fi

# ---------------------------------------------------------------------------
# Case 7: JSON rate_limit_event with non-rejected status → must NOT be detected (return 1)
# Warning-level rate limit events while work continues must not trigger detection.
# ---------------------------------------------------------------------------
LOG7="$tmpdir/log-json-rate-limit-warning.log"
cat > "$LOG7" << 'EOF'
{"type":"system","subtype":"init","session_id":"sess-ghi","tools":[]}
{"type":"rate_limit_event","rate_limit_info":{"status":"warning","resetsAt":1780723200,"rateLimitType":"five_hour"}}
{"type":"result","subtype":"success","is_error":false,"result":"Task completed successfully","session_id":"sess-ghi"}
EOF

if run_check "$LOG7"; then
  echo "FAIL case 7: false positive — rate_limit_event with non-rejected status detected" >&2
  FAIL=1
else
  echo "PASS case 7: rate_limit_event with non-rejected status correctly not detected"
fi

# ---------------------------------------------------------------------------
# Case 8: JSON result with is_error:false → must NOT be detected (return 1)
# A successful result that happens to have api_error_status:0 must not trigger.
# ---------------------------------------------------------------------------
LOG8="$tmpdir/log-json-success-result.log"
cat > "$LOG8" << 'EOF'
{"type":"system","subtype":"init","session_id":"sess-jkl","tools":[]}
{"type":"result","subtype":"success","is_error":false,"api_error_status":0,"result":"Task completed","session_id":"sess-jkl"}
EOF

if run_check "$LOG8"; then
  echo "FAIL case 8: false positive — successful result (is_error:false) detected" >&2
  FAIL=1
else
  echo "PASS case 8: successful result correctly not detected (false-positive guard)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if [ $FAIL -eq 0 ]; then
  echo ""
  echo "PASS: all check_for_token_limit smoke test cases passed"
  exit 0
else
  echo ""
  echo "FAIL: one or more smoke test cases failed (see above)"
  exit 1
fi
