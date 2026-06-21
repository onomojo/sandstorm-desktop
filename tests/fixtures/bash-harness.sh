#!/bin/bash
#
# bash-harness.sh — reusable harness for task-runner.sh helper function tests.
#
# Source this file, then call:
#
#   setup_harness              — creates per-test $tmpdir, puts fake-claude on
#                                PATH as 'claude', sets $TASK_RUNNER, traps
#                                cleanup on EXIT
#   source_task_runner_helpers — sed-extracts all helper functions from
#                                task-runner.sh (up to but not including the
#                                main loop), rewrites /tmp/ → $tmpdir/ so
#                                file writes are isolated, then evals the result
#   assert_no_tmp_leak [label] — fails (return 1 + message to stderr) if any
#                                /tmp/claude-* files exist in real /tmp after
#                                the test has run; under the /tmp/→$tmpdir/
#                                substitution this should always be empty
#
# Usage pattern (in a bash test script):
#
#   source "$(dirname "${BASH_SOURCE[0]}")/../fixtures/bash-harness.sh"
#   setup_harness
#   source_task_runner_helpers
#   # ... test code ...
#   assert_no_tmp_leak "my-test"
#
# Design:
#   - $tmpdir is per-call (mktemp -d) and removed by EXIT trap
#   - fake-claude is a symlink at $tmpdir/bin/claude so it shadows any real
#     claude binary; FAKE_CLAUDE_MODE controls the output mode
#   - The /tmp/ substitution is the same pattern used in the pre-existing
#     task-runner-environmental-scope.sh and task-runner-scope-smoke.sh tests

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_FAKE_CLAUDE_BIN="${HARNESS_DIR}/fake-claude"

setup_harness() {
  tmpdir=$(mktemp -d)
  export tmpdir

  # Snapshot any /tmp/claude-* files that already exist before the test runs.
  # The task-runner daemon that hosts this container keeps live state files in
  # the real /tmp (claude-task.status, claude-raw.log, …); those are NOT leaks
  # from the test.  assert_no_tmp_leak diffs against this baseline so it only
  # flags files the test itself created via a /tmp/→$tmpdir/ substitution gap.
  # `|| true` guards against a transient non-zero exit from find when a
  # concurrent test removes its own /tmp/tmp.XXXX dir mid-scan — under
  # `set -euo pipefail` that would otherwise abort the sourcing script.
  _TMP_LEAK_BASELINE=$( { find /tmp -maxdepth 1 -name 'claude-*' 2>/dev/null || true; } | sort)
  export _TMP_LEAK_BASELINE

  trap '[ -n "${HARNESS_KEEP_TMPDIR:-}" ] || rm -rf "$tmpdir"' EXIT

  # Create a per-test bin directory with a 'claude' entry pointing at fake-claude
  local _bin_dir="${tmpdir}/bin"
  mkdir -p "$_bin_dir"
  ln -sf "$_FAKE_CLAUDE_BIN" "${_bin_dir}/claude"

  # Prepend to PATH so 'claude' resolves to our stub inside eval'd helper code
  export PATH="${_bin_dir}:${PATH}"

  # Resolve task-runner.sh from the repo root (two dirs up from fixtures/)
  TASK_RUNNER="${HARNESS_DIR}/../../sandstorm-cli/docker/task-runner.sh"
  TASK_RUNNER="$(realpath "$TASK_RUNNER" 2>/dev/null || echo "")"

  if [ ! -f "${TASK_RUNNER:-}" ]; then
    echo "SKIP: task-runner.sh not found at ${TASK_RUNNER:-<unresolved>}" >&2
    exit 0
  fi

  export TASK_RUNNER
}

# Source helper functions from task-runner.sh (everything before "# ─── Main Loop").
# Rewrites /tmp/ → $tmpdir/ so all state-file reads/writes are isolated.
# Must be called after setup_harness.
source_task_runner_helpers() {
  local _func_src
  _func_src=$(sed -n '1,/^# ─── Main Loop/p' "$TASK_RUNNER" | head -n -1)
  # Isolate all /tmp/ file references to tmpdir
  _func_src="${_func_src//\/tmp\//$tmpdir/}"
  eval "$_func_src"
}

# Source the full task-runner.sh including the main loop body, loading all
# helper functions plus the loop-body variable definitions into the caller's
# environment.  Rewrites /tmp/ → $tmpdir/ so all state-file reads/writes are
# isolated.
#
# Unlike source_task_runner_helpers (which stops at "# ─── Main Loop"),
# this function reads the complete file so that loop-level constants
# (MAX_INNER_ITERATIONS, MAX_OUTER_ITERATIONS, …) and every helper are
# available.  The outer daemon "while true" is NOT started: eval stops just
# before that line so the call returns immediately.
#
# After calling this function, override run_claude / run_review /
# run_meta_review / run_verify with test stubs, then drive the dual-loop body
# directly.  Must be called after setup_harness.
source_task_runner_with_loop() {
  local _func_src
  # Read the whole file and apply the /tmp/ isolation substitution
  _func_src=$(cat "$TASK_RUNNER")
  _func_src="${_func_src//\/tmp\//$tmpdir/}"
  # Truncate at (but not including) the outer daemon loop so eval returns
  # immediately; all functions and loop-level constants are defined above it
  _func_src=$(printf '%s\n' "$_func_src" | sed -n '1,/^while true; do$/p' | head -n -1)
  eval "$_func_src"
}

# Assert the test did not leak any NEW /tmp/claude-* files into the real /tmp.
# Prints a FAIL message to stderr and returns 1 if any are found.
# Under the /tmp/→$tmpdir/ substitution used by source_task_runner_helpers,
# this should always pass; failures indicate a substitution gap.
# Files present before the test ran (captured by setup_harness into
# _TMP_LEAK_BASELINE — e.g. the host task-runner daemon's live state files)
# are excluded so the check is robust to a pre-populated /tmp.
assert_no_tmp_leak() {
  local _label="${1:-}"
  local _current _leaked
  # `|| true` guards against a transient non-zero exit from find when a
  # concurrent test removes its own /tmp/tmp.XXXX dir mid-scan — under a
  # caller's `set -euo pipefail` that would otherwise abort the script with
  # status 1 before this assertion is ever evaluated.
  _current=$( { find /tmp -maxdepth 1 -name 'claude-*' 2>/dev/null || true; } | sort)
  if [ -n "${_TMP_LEAK_BASELINE:-}" ]; then
    _leaked=$(comm -23 <(printf '%s\n' "$_current") <(printf '%s\n' "$_TMP_LEAK_BASELINE"))
  else
    _leaked="$_current"
  fi
  if [ -n "$_leaked" ]; then
    local _prefix=""
    [ -n "$_label" ] && _prefix="[$_label] "
    printf 'FAIL: %s/tmp/claude-* files leaked into real /tmp:\n' "$_prefix" >&2
    printf '%s\n' "$_leaked" >&2
    return 1
  fi
  return 0
}
