#!/bin/bash
#
# Behavioral smoke test: check_for_token_limit detects plain-text session-limit
# lines and ignores the same phrase embedded inside stream-json objects.
#
# Verifies four cases:
#   1. Plain-text limit line → detected (return 0)  [the originally-reported bug]
#   2. No limit string at all → not detected (return 1)  [regression guard]
#   3. Limit phrase only inside JSON object lines → not detected (return 1)  [false-positive guard]
#   4. Limit phrase in JSON + plain-text in same log → detected (return 0)  [discriminator]
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
{"type":"result","result":"done"}
[LOOP] Execution pass 1 complete, checking for STOP_AND_ASK...
EOF

if run_check "$LOG2"; then
  echo "FAIL case 2: false positive — no limit string present but detected" >&2
  FAIL=1
else
  echo "PASS case 2: no limit string correctly not detected"
fi

# ---------------------------------------------------------------------------
# Case 3: Limit phrase only inside stream-json object → must NOT be detected (return 1)
# False-positive guard: agent-authored content quoting the phrase must be ignored.
# ---------------------------------------------------------------------------
LOG3="$tmpdir/log-json-only.log"
cat > "$LOG3" << 'EOF'
[LOOP] Starting initial execution pass...
{"type":"assistant","message":{"content":[{"type":"text","text":"You've hit your session limit"}]}}
{"type":"result","result":"The task mentions: You've hit your session limit but that is just context"}
[LOOP] Execution pass 1 complete
EOF

if run_check "$LOG3"; then
  echo "FAIL case 3: false positive — phrase only inside JSON objects but was detected" >&2
  FAIL=1
else
  echo "PASS case 3: JSON-embedded phrase correctly not detected (false-positive guard)"
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
