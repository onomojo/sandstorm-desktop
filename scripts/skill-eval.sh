#!/usr/bin/env bash
# Run the trigger-eval for a single Sandstorm skill and save results.
#
# Thin wrapper around skill-creator's run_loop.py. We don't re-implement
# the eval runner here — the whole point of #285 is to standardize on the
# official tool so every skill goes through the same code path.
#
# Usage:
#   scripts/skill-eval.sh <skill-name> <model-id> [--max-iterations N]
#
# Example:
#   scripts/skill-eval.sh check-and-resume-stack claude-opus-4-6
#   scripts/skill-eval.sh check-and-resume-stack claude-opus-4-7 --max-iterations 3

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <skill-name> <model-id> [--max-iterations N] [--runs-per-query N]" >&2
  exit 2
fi

SKILL_NAME="$1"; shift
MODEL_ID="$1"; shift

# Default: one iteration (baseline measurement, no description tuning).
# Raise to ≥3 to invoke run_loop's improvement pass when a skill is under-triggering.
MAX_ITER=1
RUNS_PER_QUERY=3
HOLDOUT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-iterations) MAX_ITER="$2"; shift 2 ;;
    --runs-per-query) RUNS_PER_QUERY="$2"; shift 2 ;;
    --holdout) HOLDOUT="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_PATH="$REPO_ROOT/sandstorm-cli/skills/$SKILL_NAME"
EVAL_SET="$REPO_ROOT/docs/skill-evals/$SKILL_NAME/trigger-eval.json"

if [[ ! -f "$SKILL_PATH/SKILL.md" ]]; then
  echo "ERROR: no SKILL.md at $SKILL_PATH" >&2
  exit 1
fi
if [[ ! -f "$EVAL_SET" ]]; then
  echo "ERROR: no eval set at $EVAL_SET (see docs/skill-evals/README.md)" >&2
  exit 1
fi

# skill-creator is installed as a Claude Code plugin. Both cache and
# marketplace paths contain the same module tree; prefer cache (used at
# runtime) with marketplace as fallback.
SKILL_CREATOR=""
for candidate in \
  "$HOME/.claude/plugins/cache/claude-plugins-official/skill-creator/unknown/skills/skill-creator" \
  "$HOME/.claude/plugins/marketplaces/claude-plugins-official/plugins/skill-creator/skills/skill-creator"; do
  if [[ -f "$candidate/scripts/run_loop.py" ]]; then
    SKILL_CREATOR="$candidate"
    break
  fi
done
if [[ -z "$SKILL_CREATOR" ]]; then
  echo "ERROR: skill-creator plugin not installed" >&2
  echo "  run: claude plugin install skill-creator@claude-plugins-official" >&2
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: 'claude' CLI not on PATH" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not on PATH" >&2
  exit 1
fi
if ! python3 -c 'import anthropic' >/dev/null 2>&1; then
  echo "ERROR: python3 can't import 'anthropic' (pip install anthropic)" >&2
  exit 1
fi
if [[ "$MAX_ITER" -gt 1 && -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "ERROR: --max-iterations >1 runs description improvement, which needs ANTHROPIC_API_KEY" >&2
  exit 1
fi

TIMESTAMP="$(date -u +'%Y-%m-%dT%H%M%SZ')"
RESULTS_ROOT="$REPO_ROOT/docs/skill-evals/results/$MODEL_ID/$SKILL_NAME"
mkdir -p "$RESULTS_ROOT"

echo "Running trigger eval: skill=$SKILL_NAME model=$MODEL_ID iterations=$MAX_ITER" >&2
echo "  eval set:    $EVAL_SET" >&2
echo "  skill path:  $SKILL_PATH" >&2
echo "  results dir: $RESULTS_ROOT" >&2

cd "$SKILL_CREATOR"
python3 -m scripts.run_loop \
  --eval-set "$EVAL_SET" \
  --skill-path "$SKILL_PATH" \
  --model "$MODEL_ID" \
  --max-iterations "$MAX_ITER" \
  --runs-per-query "$RUNS_PER_QUERY" \
  --holdout "$HOLDOUT" \
  --results-dir "$RESULTS_ROOT" \
  --report none \
  --verbose

# Symlink the newest timestamped subdir as 'latest' so downstream tools
# (CI comment bots, dashboards) always have a stable path to the last run.
LATEST="$(ls -1dt "$RESULTS_ROOT"/*/ 2>/dev/null | head -1 || true)"
if [[ -n "$LATEST" ]]; then
  ln -snf "$(basename "$LATEST")" "$RESULTS_ROOT/latest"
fi
