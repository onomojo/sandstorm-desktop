#!/bin/bash
#
# state-file-contract.sh — T0 bash contract tests for task-runner state files.
#
# Tests T0-reachable state files: those written by stack.sh (input files) and
# those written by pre-main-loop helper functions (check_for_stop_and_ask).
#
# Uses bash-harness.sh to isolate all /tmp/ writes to a per-run tmpdir.
#
# Exit codes: 0 = all assertions passed, 1 = one or more failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source the reusable harness
# shellcheck source=../fixtures/bash-harness.sh
source "${SCRIPT_DIR}/../fixtures/bash-harness.sh"

# ── Setup ────────────────────────────────────────────────────────────────────

setup_harness
source_task_runner_helpers
# Suppress internal [LOOP] output from helper functions during tests
log_loop() { :; }

FAIL=0

assert_pass() {
  local label="$1"
  echo "PASS [$label]"
}

assert_fail() {
  local label="$1"
  local msg="$2"
  echo "FAIL [$label]: $msg" >&2
  FAIL=1
}

# ── Group 1: stack.sh input files — format and writability ───────────────────
#
# For each input file that stack.sh writes before dispatching a task, we
# simulate what stack.sh does (write the file) and assert the file exists with
# the expected content.

# 1a. claude-task-trigger (presence-only)
touch "$tmpdir/claude-task-trigger"
if [ -e "$tmpdir/claude-task-trigger" ]; then
  assert_pass "input/trigger: file exists after touch"
else
  assert_fail "input/trigger: file exists after touch" "file not created"
fi

# 1b. claude-task-prompt.txt
PROMPT_TEXT="Fix the auth bug in src/main/auth.ts"
printf '%s\n' "$PROMPT_TEXT" > "$tmpdir/claude-task-prompt.txt"
if [ "$(cat "$tmpdir/claude-task-prompt.txt")" = "$PROMPT_TEXT" ]; then
  assert_pass "input/prompt.txt: content round-trips"
else
  assert_fail "input/prompt.txt: content round-trips" "content mismatch"
fi

# 1c. claude-task-label.txt (first 80 chars of prompt)
LABEL_TEXT=$(echo "$PROMPT_TEXT" | head -1 | cut -c1-80)
printf '%s\n' "$LABEL_TEXT" > "$tmpdir/claude-task-label.txt"
if [ "$(cat "$tmpdir/claude-task-label.txt")" = "$LABEL_TEXT" ]; then
  assert_pass "input/label.txt: content round-trips"
else
  assert_fail "input/label.txt: content round-trips" "content mismatch"
fi

# 1d. claude-task-model.txt (conditional: only when --model supplied)
echo "claude-opus-4-8" > "$tmpdir/claude-task-model.txt"
MODEL_READ=$(cat "$tmpdir/claude-task-model.txt" | tr -d '[:space:]')
if [ "$MODEL_READ" = "claude-opus-4-8" ]; then
  assert_pass "input/model.txt: model name round-trips"
else
  assert_fail "input/model.txt: model name round-trips" "got: $MODEL_READ"
fi

# 1e. claude-task-models.json (conditional: per-phase model map)
MODELS_JSON='{"execution":"claude-sonnet-4-6","review":"claude-haiku-4-5-20251001"}'
printf '%s' "$MODELS_JSON" > "$tmpdir/claude-task-models.json"
if jq '.' "$tmpdir/claude-task-models.json" > /dev/null 2>&1; then
  assert_pass "input/models.json: valid JSON"
else
  assert_fail "input/models.json: valid JSON" "jq rejected the content"
fi
EX_MODEL=$(jq -r '.execution' "$tmpdir/claude-task-models.json")
if [ "$EX_MODEL" = "claude-sonnet-4-6" ]; then
  assert_pass "input/models.json: execution key readable"
else
  assert_fail "input/models.json: execution key readable" "got: $EX_MODEL"
fi

# 1f. claude-task-resume.txt (conditional: session resume ID)
RESUME_ID="sess-abc123xyz"
printf '%s\n' "$RESUME_ID" > "$tmpdir/claude-task-resume.txt"
RESUME_READ=$(cat "$tmpdir/claude-task-resume.txt" | tr -d '[:space:]')
if [ "$RESUME_READ" = "$RESUME_ID" ]; then
  assert_pass "input/resume.txt: session ID round-trips"
else
  assert_fail "input/resume.txt: session ID round-trips" "got: $RESUME_READ"
fi

# 1g. claude-task-backend.txt (conditional: "claude" or "opencode")
for backend in claude opencode; do
  echo "$backend" > "$tmpdir/claude-task-backend.txt"
  BACK_READ=$(cat "$tmpdir/claude-task-backend.txt" | tr -d '[:space:]')
  if [ "$BACK_READ" = "$backend" ]; then
    assert_pass "input/backend.txt: '$backend' round-trips"
  else
    assert_fail "input/backend.txt: '$backend' round-trips" "got: $BACK_READ"
  fi
done

# 1h. claude-task-backend-model.txt (conditional: OpenCode model)
echo "anthropic/claude-sonnet-4-6" > "$tmpdir/claude-task-backend-model.txt"
BKMODEL_READ=$(cat "$tmpdir/claude-task-backend-model.txt" | tr -d '[:space:]')
if [ "$BKMODEL_READ" = "anthropic/claude-sonnet-4-6" ]; then
  assert_pass "input/backend-model.txt: value round-trips"
else
  assert_fail "input/backend-model.txt: value round-trips" "got: $BKMODEL_READ"
fi

# 1i. claude-task-phase-routing.json (conditional: per-phase routing)
ROUTING_JSON='{"execution":{"backend":"claude"},"review":{"backend":"opencode","provider":"anthropic"}}'
printf '%s' "$ROUTING_JSON" > "$tmpdir/claude-task-phase-routing.json"
if jq '.' "$tmpdir/claude-task-phase-routing.json" > /dev/null 2>&1; then
  assert_pass "input/phase-routing.json: valid JSON"
else
  assert_fail "input/phase-routing.json: valid JSON" "jq rejected the content"
fi
REVIEW_BACKEND=$(jq -r '.review.backend' "$tmpdir/claude-task-phase-routing.json")
if [ "$REVIEW_BACKEND" = "opencode" ]; then
  assert_pass "input/phase-routing.json: review.backend readable"
else
  assert_fail "input/phase-routing.json: review.backend readable" "got: $REVIEW_BACKEND"
fi

# ── Group 2: check_for_stop_and_ask output — claude-stop-reason.txt ──────────

# 2a. STOP_AND_ASK present → stop-reason.txt written with correct reason
TASK_LOG="$tmpdir/claude-task.log"
cat > "$TASK_LOG" << 'LOG'
Starting task analysis...

I see the failing test is out of scope.

STOP_AND_ASK: tests/integration/foo.test.ts is out of scope per ticket
LOG

if check_for_stop_and_ask "$TASK_LOG"; then
  STOP_REASON=$(cat "$tmpdir/claude-stop-reason.txt" 2>/dev/null || true)
  if [ -n "$STOP_REASON" ]; then
    assert_pass "stop-reason/written: file created by check_for_stop_and_ask"
  else
    assert_fail "stop-reason/written: file created by check_for_stop_and_ask" "file is empty"
  fi
  if echo "$STOP_REASON" | grep -q "out of scope"; then
    assert_pass "stop-reason/content: reason text captured"
  else
    assert_fail "stop-reason/content: reason text captured" "got: $STOP_REASON"
  fi
else
  assert_fail "stop-reason/detection: STOP_AND_ASK should be detected" "check_for_stop_and_ask returned 1"
fi

# 2b. No STOP_AND_ASK → stop-reason.txt NOT written (or retains previous value;
#     we just care that detection returns 1)
TASK_LOG2="$tmpdir/claude-task-no-stop.log"
cat > "$TASK_LOG2" << 'LOG'
Task completed successfully.
No issues found.
LOG

rm -f "$tmpdir/claude-stop-reason.txt"
if check_for_stop_and_ask "$TASK_LOG2"; then
  assert_fail "stop-reason/no-detection: should not fire on clean log" "check_for_stop_and_ask returned 0 (false positive)"
else
  assert_pass "stop-reason/no-detection: clean log correctly not detected"
  if [ ! -f "$tmpdir/claude-stop-reason.txt" ]; then
    assert_pass "stop-reason/not-written: stop-reason.txt not written for clean log"
  else
    assert_fail "stop-reason/not-written: stop-reason.txt not written for clean log" "file appeared unexpectedly"
  fi
fi

# 2c. Stop-questions JSON is valid JSON and readable when written by inner agent
STOP_QUESTIONS_FILE="$tmpdir/claude-stop-questions.json"
SAMPLE_QUESTIONS='[{"id":"q1","question":"What to do?","options":[{"id":"skip","label":"Skip","recommended":true}]}]'
printf '%s\n' "$SAMPLE_QUESTIONS" > "$STOP_QUESTIONS_FILE"

if jq '.' "$STOP_QUESTIONS_FILE" > /dev/null 2>&1; then
  assert_pass "stop-questions/valid-json: file is parseable JSON"
else
  assert_fail "stop-questions/valid-json: file is parseable JSON" "jq rejected content"
fi

Q_ID=$(jq -r '.[0].id' "$STOP_QUESTIONS_FILE")
if [ "$Q_ID" = "q1" ]; then
  assert_pass "stop-questions/content: first question id readable"
else
  assert_fail "stop-questions/content: first question id readable" "got: $Q_ID"
fi

# Verify check_for_stop_and_ask still detects STOP_AND_ASK when questions file exists
TASK_LOG3="$tmpdir/claude-task-with-questions.log"
cat > "$TASK_LOG3" << 'LOG'
Need guidance.

STOP_AND_ASK: the fix requires out-of-scope changes
LOG

if check_for_stop_and_ask "$TASK_LOG3"; then
  assert_pass "stop-questions/detection-with-file: STOP_AND_ASK detected when questions file present"
else
  assert_fail "stop-questions/detection-with-file: STOP_AND_ASK detected when questions file present" "returned 1"
fi

rm -f "$STOP_QUESTIONS_FILE"

# ── Group 3: No /tmp/claude-* leaks ──────────────────────────────────────────

if assert_no_tmp_leak "all-tests"; then
  assert_pass "leak-check: no /tmp/claude-* files in real /tmp"
else
  assert_fail "leak-check: no /tmp/claude-* files in real /tmp" "files leaked"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

if [ $FAIL -eq 0 ]; then
  echo ""
  echo "All T0 state-file contract tests PASSED"
  exit 0
else
  echo ""
  echo "FAIL: one or more T0 state-file contract tests failed (see above)"
  exit 1
fi
