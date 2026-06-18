#!/bin/bash
#
# Regression smoke test: verify-failure scope classification
#
# Verifies that classify_verify_failure_scope (sourced from task-runner.sh)
# correctly detects when ALL failing TypeScript files are outside the task's
# changed-file set and returns 0 (environmental). Also verifies the four
# documented non-environmental cases: in-scope failure, mixed scope, no
# parseable paths, and empty changed-file set.
#
# Exit codes: 0 = PASS, 1 = FAIL

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
# Source helper functions from task-runner.sh (stop before the main loop).
# Override /tmp paths to tmpdir equivalents so the tests are isolated.
# ---------------------------------------------------------------------------
FUNC_SOURCE=$(sed -n '1,/^# ─── Main Loop/p' "$TASK_RUNNER" | head -n -1)

# Patch /tmp/ references used by helper functions to point at our tmpdir
FUNC_SOURCE="${FUNC_SOURCE//\/tmp\//$tmpdir/}"

eval "$FUNC_SOURCE"

# ---------------------------------------------------------------------------
# Shadow _get_task_changed_files so we control the changed-file set.
# MOCK_CHANGED_FILES is set per test case (newline-separated paths).
# ---------------------------------------------------------------------------
MOCK_CHANGED_FILES=""

_get_task_changed_files() {
  printf '%s\n' "$MOCK_CHANGED_FILES" | grep -v '^$' || true
}

# ---------------------------------------------------------------------------
# Helper: build a verify log with TypeScript errors for given file paths
# ---------------------------------------------------------------------------
make_tsc_log() {
  local logfile="$1"
  shift
  : > "$logfile"
  for f in "$@"; do
    echo "${f}(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'." >> "$logfile"
  done
}

# ---------------------------------------------------------------------------
# Helper: assert environmental classification
# ---------------------------------------------------------------------------
FAIL=0

assert_environmental() {
  local label="$1"
  local verify_log="$2"
  local expect_env="$3"   # "yes" or "no"

  local result
  if classify_verify_failure_scope "$verify_log"; then
    result="yes"
  else
    result="no"
  fi

  if [ "$result" != "$expect_env" ]; then
    echo "FAIL [$label]: expected environmental=$expect_env, got $result" >&2
    FAIL=1
  else
    echo "PASS [$label]"
  fi
}

# ---------------------------------------------------------------------------
# Case 1: all failing files outside changed set → environmental
# ---------------------------------------------------------------------------
LOG1="$tmpdir/verify-case1.log"
make_tsc_log "$LOG1" \
  "src/unrelated/foo.ts" \
  "src/unrelated/bar.ts"

MOCK_CHANGED_FILES="src/main/my-change.ts"
assert_environmental "out-of-scope only → environmental" "$LOG1" "yes"

# ---------------------------------------------------------------------------
# Case 2: failing file matches a changed file → NOT environmental
# ---------------------------------------------------------------------------
LOG2="$tmpdir/verify-case2.log"
make_tsc_log "$LOG2" "src/main/my-change.ts"

MOCK_CHANGED_FILES="src/main/my-change.ts"
assert_environmental "in-scope failure → not environmental" "$LOG2" "no"

# ---------------------------------------------------------------------------
# Case 3: mixed scope (one in-scope, one out-of-scope) → NOT environmental
# ---------------------------------------------------------------------------
LOG3="$tmpdir/verify-case3.log"
make_tsc_log "$LOG3" \
  "src/main/my-change.ts" \
  "src/unrelated/other.ts"

MOCK_CHANGED_FILES="src/main/my-change.ts"
assert_environmental "mixed scope → not environmental" "$LOG3" "no"

# ---------------------------------------------------------------------------
# Case 4: no parseable TypeScript error paths → NOT environmental
# ---------------------------------------------------------------------------
LOG4="$tmpdir/verify-case4.log"
cat > "$LOG4" << 'EOF'
FAIL tests/unit/some.test.ts
  ● some test › should work

    expect(received).toBe(expected)

    Expected: true
    Received: false

Tests: 1 failed, 5 passed
EOF

MOCK_CHANGED_FILES="src/main/my-change.ts"
assert_environmental "no parseable paths → not environmental" "$LOG4" "no"

# ---------------------------------------------------------------------------
# Case 5: empty verify log → NOT environmental
# ---------------------------------------------------------------------------
LOG5="$tmpdir/verify-case5.log"
: > "$LOG5"

MOCK_CHANGED_FILES="src/main/my-change.ts"
assert_environmental "empty log → not environmental" "$LOG5" "no"

# ---------------------------------------------------------------------------
# Case 6: out-of-scope with ./  prefix in tsc output → environmental
# ---------------------------------------------------------------------------
LOG6="$tmpdir/verify-case6.log"
make_tsc_log "$LOG6" "./src/unrelated/baz.ts"

MOCK_CHANGED_FILES="src/main/my-change.ts"
assert_environmental "dotslash prefix stripped → environmental" "$LOG6" "yes"

# ---------------------------------------------------------------------------
# Case 7: empty changed-file set, parseable failure → environmental
# (no agent changes; any failure must be pre-existing)
# ---------------------------------------------------------------------------
LOG7="$tmpdir/verify-case7.log"
make_tsc_log "$LOG7" "src/unrelated/foo.ts"

MOCK_CHANGED_FILES=""
assert_environmental "no changed files → environmental" "$LOG7" "yes"

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
if [ $FAIL -eq 0 ]; then
  echo ""
  echo "All cases PASSED"
  exit 0
else
  exit 1
fi
