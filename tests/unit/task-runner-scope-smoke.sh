#!/bin/bash
#
# Regression smoke test: out-of-scope ticket → STOP_AND_ASK → needs_human
#
# Verifies that check_for_stop_and_ask (sourced from task-runner.sh) correctly
# detects the STOP_AND_ASK signal in the execution log and that the resulting
# status is needs_human.  Uses a synthetic ticket with explicit
# "Out of scope: tests/integration/**" and a simulated execution log that
# mirrors what the agent would output when it cannot fix a planted failing
# integration test without violating scope.
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

TASK_LOG="$tmpdir/task.log"
STOP_REASON_FILE="$tmpdir/claude-stop-reason.txt"

# ---------------------------------------------------------------------------
# Synthetic ticket body with explicit out-of-scope declaration
# ---------------------------------------------------------------------------
TICKET_BODY='# Task: Fix registry type validation

## Description
Fix the TypeScript registry so that it validates task types correctly.
Only src/main/control-plane/registry.ts needs to change.

## Out of scope
- tests/integration/**
- Any file not in src/main/control-plane/

Do not modify any file outside src/main/control-plane/.

## Acceptance criteria
- Unit tests in tests/unit/registry.test.ts pass
- No changes to integration tests
'

# ---------------------------------------------------------------------------
# Simulated execution log — mirrors what the agent emits when it discovers
# the planted failing integration test is out of scope and refuses to edit it.
# ---------------------------------------------------------------------------
cat > "$TASK_LOG" << 'LOG'
Starting task analysis...

I can see the failing test is:

  tests/integration/registry-integration.test.ts  ← PLANTED FAILING TEST

This test file is listed under "Out of scope: tests/integration/**" in the
ticket body.  Fixing the verify failure would require either:

  a) Modifying tests/integration/registry-integration.test.ts (out of scope), or
  b) Changing production code in a way that breaks other in-scope tests.

Neither is acceptable.  Stopping and requesting human input.

STOP_AND_ASK: tests/integration/registry-integration.test.ts is out of scope per ticket — verify failure cannot be fixed within allowed paths
LOG

# ---------------------------------------------------------------------------
# Source check_for_stop_and_ask directly from task-runner.sh by extracting
# the function block (sed stops before the main loop so it never runs).
# We patch the internal /tmp/claude-stop-reason.txt path to our temp file.
# ---------------------------------------------------------------------------

# Extract everything up to (not including) the "# ─── Main Loop" line
FUNC_SOURCE=$(sed -n '1,/^# ─── Main Loop/p' "$TASK_RUNNER" | head -n -1)

# Override the stop-reason path inside the function before eval
FUNC_SOURCE="${FUNC_SOURCE//\/tmp\/claude-stop-reason.txt/$STOP_REASON_FILE}"

eval "$FUNC_SOURCE"

# Capture the tests/integration/ diff state before running the function —
# this branch may legitimately have changes there (e.g. new e2e tests added
# as part of the same ticket). We only want to fail if the function itself
# introduces NEW changes to that directory.
BEFORE_INT_DIFF=$(git -C "$(realpath "$SCRIPT_DIR/../..")" diff --name-only HEAD 2>/dev/null | grep "^tests/integration/" | sort || true)

# ---------------------------------------------------------------------------
# Run the check — this is exactly what task-runner.sh does in both the
# initial-execution path and the loop paths after review/verify failures.
# ---------------------------------------------------------------------------
if check_for_stop_and_ask "$TASK_LOG"; then
  STATUS="needs_human"
else
  STATUS="completed"
fi

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------
FAIL=0

if [ "$STATUS" != "needs_human" ]; then
  echo "FAIL: expected status=needs_human, got status=$STATUS" >&2
  FAIL=1
fi

REASON=$(cat "$STOP_REASON_FILE" 2>/dev/null || true)
if [ -z "$REASON" ]; then
  echo "FAIL: stop-reason file is empty — reason was not captured" >&2
  FAIL=1
fi

# The reason must name the out-of-scope file
if ! echo "$REASON" | grep -q "tests/integration/"; then
  echo "FAIL: stop reason '$REASON' does not name the out-of-scope path (tests/integration/)" >&2
  FAIL=1
fi

# Verify no NEW diff in tests/integration/** was created by this smoke test.
# check_for_stop_and_ask only writes to $STOP_REASON_FILE; it must not touch
# real repo files. We compare against the pre-run state so pre-existing branch
# changes in tests/integration/ (e.g. new e2e tests) don't cause a false fail.
AFTER_INT_DIFF=$(git -C "$(realpath "$SCRIPT_DIR/../..")" diff --name-only HEAD 2>/dev/null | grep "^tests/integration/" | sort || true)
if [ "$BEFORE_INT_DIFF" != "$AFTER_INT_DIFF" ]; then
  echo "FAIL: smoke test execution created new changes in tests/integration/ — scope was violated" >&2
  FAIL=1
fi

if [ $FAIL -eq 0 ]; then
  echo "PASS: status=needs_human, reason captured, no tests/integration/ diff"
  exit 0
else
  echo ""
  echo "Task log:"
  cat "$TASK_LOG"
  echo ""
  echo "Stop reason: $REASON"
  exit 1
fi
