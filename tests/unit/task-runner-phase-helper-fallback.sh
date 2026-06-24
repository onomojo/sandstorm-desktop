#!/bin/bash
#
# Behavioral test: verifies that task-runner.sh can locate phase-model-helper.sh
# via the TASK_RUNNER-based third fallback when the two standard paths
# (/usr/bin/phase-model-helper.sh and /app/sandstorm-cli/docker/phase-model-helper.sh)
# are not present.
#
# This covers the Fix 2 scenario from issue #705: B3 bash harnesses running on a
# bare host without the repo mounted at /app must still find the helper.
#
# Exit code: 0 = fallback works, 1 = fallback failed

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
# Extract the helper-function block from task-runner.sh (same approach as the
# smoke tests) and replace the two hardcoded paths with paths that do not exist
# so only the TASK_RUNNER-based third fallback can succeed.
# ---------------------------------------------------------------------------
FUNC_SOURCE=$(sed -n '1,/^# ─── Main Loop/p' "$TASK_RUNNER" | head -n -1)

FAKE="$tmpdir/absent-helper.sh"   # intentionally absent
FUNC_SOURCE="${FUNC_SOURCE//\/usr\/bin\/phase-model-helper.sh/$FAKE}"
FUNC_SOURCE="${FUNC_SOURCE//\/app\/sandstorm-cli\/docker\/phase-model-helper.sh/$FAKE}"

# Export TASK_RUNNER — this is what the harness does (setup_harness exports it)
# and what makes the third fallback in task-runner.sh work when eval'd.
export TASK_RUNNER

# ---------------------------------------------------------------------------
# Evaluate the modified block.  If the third fallback resolves correctly,
# source "$_phase_helper" will load the real phase-model-helper.sh and
# define model_args_for_phase.
# ---------------------------------------------------------------------------
eval "$FUNC_SOURCE"

if declare -f model_args_for_phase > /dev/null 2>&1; then
  echo "PASS: model_args_for_phase defined — TASK_RUNNER-based fallback resolved the helper"
else
  echo "FAIL: model_args_for_phase NOT defined after eval (TASK_RUNNER fallback failed)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Secondary check: call model_args_for_phase to ensure it's functional
# ---------------------------------------------------------------------------
RESOLVED_MODEL_ARGS=()
PHASE_ROUTING_JSON=""
PHASE_MODELS_JSON=""
model_args_for_phase "execution" "" ""
echo "PASS: model_args_for_phase callable after TASK_RUNNER-based sourcing"

echo ""
echo "PASS: all phase-helper TASK_RUNNER fallback assertions passed"
exit 0
