#!/usr/bin/env bash
# Run trigger evals for every Sandstorm skill that has an authored
# eval set under docs/skill-evals/<skill>/trigger-eval.json. Writes one
# results directory per skill under docs/skill-evals/results/<model>/<skill>/.
#
# Usage:
#   scripts/run-all-skill-evals.sh <model-id> [--max-iterations N]
#
# Example:
#   scripts/run-all-skill-evals.sh claude-opus-4-6
#   scripts/run-all-skill-evals.sh claude-opus-4-7

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <model-id> [extra args passed through to skill-eval.sh]" >&2
  exit 2
fi

MODEL_ID="$1"; shift

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVALS_DIR="$REPO_ROOT/docs/skill-evals"

SKILLS=()
while IFS= read -r f; do
  SKILLS+=("$(basename "$(dirname "$f")")")
done < <(find "$EVALS_DIR" -mindepth 2 -maxdepth 2 -name 'trigger-eval.json' | sort)

if [[ ${#SKILLS[@]} -eq 0 ]]; then
  echo "No trigger-eval.json files found under $EVALS_DIR" >&2
  exit 1
fi

echo "Model: $MODEL_ID" >&2
echo "Skills to eval: ${SKILLS[*]}" >&2

FAILED=()
for skill in "${SKILLS[@]}"; do
  echo "" >&2
  echo "===== $skill =====" >&2
  if ! "$REPO_ROOT/scripts/skill-eval.sh" "$skill" "$MODEL_ID" "$@"; then
    FAILED+=("$skill")
  fi
done

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "" >&2
  echo "Skills with non-zero exit: ${FAILED[*]}" >&2
  exit 1
fi
echo "" >&2
echo "All skill evals completed. Results in $EVALS_DIR/results/$MODEL_ID/" >&2
