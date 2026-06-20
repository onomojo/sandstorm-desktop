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

  trap 'rm -rf "$tmpdir"' EXIT

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

# Assert no /tmp/claude-* files leaked into the real /tmp directory.
# Prints a FAIL message to stderr and returns 1 if any are found.
# Under the /tmp/→$tmpdir/ substitution used by source_task_runner_helpers,
# this should always pass; failures indicate a substitution gap.
assert_no_tmp_leak() {
  local _label="${1:-}"
  local _leaked
  _leaked=$(find /tmp -maxdepth 1 -name 'claude-*' 2>/dev/null | sort)
  if [ -n "$_leaked" ]; then
    local _prefix=""
    [ -n "$_label" ] && _prefix="[$_label] "
    printf 'FAIL: %s/tmp/claude-* files leaked into real /tmp:\n' "$_prefix" >&2
    printf '%s\n' "$_leaked" >&2
    return 1
  fi
  return 0
}
