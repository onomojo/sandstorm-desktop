#!/usr/bin/env bash
# Produces a compact structured report of a stack's dual-loop state.
# Reads artifacts directly from the stack's claude container via docker exec
# so the orchestrator gets a ~2KB summary instead of the ~100KB of raw logs
# it would otherwise pull in via Bash exploration.
#
# Output format: section-labeled KEY=VALUE lines and short indented blocks.
# Stable enough for a human to scan, simple enough for downstream tooling
# to parse.

set -u

STACK_ID="${1:-}"
if [[ -z "$STACK_ID" ]]; then
  echo "ERROR reason=stack_id_missing"
  exit 0
fi

: "${SANDSTORM_BRIDGE_URL:?bridge url not set}"
: "${SANDSTORM_BRIDGE_TOKEN:?bridge token not set}"

call_bridge() {
  curl -fsS -X POST \
    -H "X-Auth-Token: $SANDSTORM_BRIDGE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\",\"input\":$2}" \
    "$SANDSTORM_BRIDGE_URL/tool-call"
}

# Resolve the stack id through list_stacks the same way check-and-resume does,
# so "250" resolves to "250-scheduled-automation" (or similar) automatically.
RESOLVED_ID="$STACK_ID"
LIST_JSON="$(call_bridge list_stacks '{}' 2>/dev/null || echo '{"result":[]}')"
MATCHES="$(echo "$LIST_JSON" | jq -r --arg q "$STACK_ID" '
  (.result // .result.stacks // []) | .[]? |
  (.name // .id // empty) | select(type == "string") |
  select(. == $q or startswith($q + "-") or startswith($q))
')"
MATCH_COUNT=$(printf '%s\n' "$MATCHES" | grep -c . || true)
if [[ "$MATCH_COUNT" -eq 1 ]]; then
  RESOLVED_ID="$(printf '%s\n' "$MATCHES" | head -1)"
elif [[ "$MATCH_COUNT" -gt 1 ]]; then
  JOINED=$(printf '%s\n' "$MATCHES" | paste -sd, -)
  echo "AMBIGUOUS id=$STACK_ID matches=$JOINED"
  exit 0
fi

# Find the claude container for this stack. Docker compose naming is
# <compose-project>-<stack-id>-claude-1. Match the suffix to avoid
# depending on the compose-project prefix.
CLAUDE_CTR="$(docker ps --format '{{.Names}}' | grep -- "-${RESOLVED_ID}-claude-1$" | head -1 || true)"
if [[ -z "$CLAUDE_CTR" ]]; then
  echo "NOT_FOUND id=$RESOLVED_ID reason=claude_container_missing"
  exit 0
fi

# All the dual-loop artifacts live at /tmp/ inside the claude container.
# Read them in one docker exec so we don't pay for N process spawns; the
# inner script prints everything pre-labeled.
REPORT="$(docker exec -i "$CLAUDE_CTR" bash -s <<'INNER' 2>/dev/null
set +e
section() { printf '\n=== %s ===\n' "$1"; }

if [[ ! -f /tmp/claude-task.status && ! -f /tmp/claude-phase-timing.txt ]]; then
  echo "NO_ARTIFACTS"
  exit 0
fi

STATUS=$(cat /tmp/claude-task.status 2>/dev/null || echo unknown)
ITERS=$(cat /tmp/claude-task.review-iterations 2>/dev/null || echo ?)
RETRIES=$(cat /tmp/claude-task.verify-retries 2>/dev/null || echo ?)
EXIT=$(cat /tmp/claude-task.exit 2>/dev/null || echo ?)
LABEL=$(cat /tmp/claude-task-label.txt 2>/dev/null || echo ?)

echo "STATUS=$STATUS"
echo "REVIEW_ITERATIONS=$ITERS"
echo "VERIFY_RETRIES=$RETRIES"
echo "TASK_EXIT_CODE=$EXIT"
echo "TASK_LABEL=$LABEL"

section "PHASE_TIMING"
if [[ -f /tmp/claude-phase-timing.txt ]]; then
  # Pair adjacent start/finish lines by iteration (4 lines per iter)
  awk '
    /execution_started/  { n++; exec_start=$0 }
    /execution_finished/ { exec_end=$0;
      sub(/.*=/,"",exec_start); sub(/.*=/,"",exec_end);
      printf "iter %d exec: %s -> %s\n", n, exec_start, exec_end }
    /review_started/     { rev_start=$0 }
    /review_finished/    { rev_end=$0;
      sub(/.*=/,"",rev_start); sub(/.*=/,"",rev_end);
      printf "iter %d rev : %s -> %s\n", n, rev_start, rev_end }
  ' /tmp/claude-phase-timing.txt
else
  echo "(missing)"
fi

section "VERDICTS"
shopt -s nullglob
for f in /tmp/claude-review-verdict-*.txt; do
  n=$(basename "$f" | sed 's/[^0-9]//g')
  # grep -c prints the count regardless of exit code; the `| head -1`
  # guarantees a single number in the capture even if grep exits non-zero.
  pass=$(grep -c "REVIEW_PASS" "$f" 2>/dev/null | head -1)
  fail=$(grep -c "REVIEW_FAIL" "$f" 2>/dev/null | head -1)
  size=$(stat -c%s "$f" 2>/dev/null || echo 0)
  # Last non-empty line — the "verdict sentence"
  last=$(grep -v '^[[:space:]]*$' "$f" | tail -1)
  # Truncate long lines for output compactness
  last=$(printf '%s' "$last" | cut -c1-180)
  printf 'iter %s bytes=%d REVIEW_PASS=%s REVIEW_FAIL=%s last_line=%q\n' "$n" "$size" "$pass" "$fail" "$last"
done

section "EXECUTION_SUMMARY_HEAD"
if [[ -f /tmp/claude-execution-summary.txt ]]; then
  head -40 /tmp/claude-execution-summary.txt
else
  echo "(missing)"
fi

section "TASK_LOG_TAIL"
if [[ -f /tmp/claude-task.log ]]; then
  tail -30 /tmp/claude-task.log
else
  echo "(missing)"
fi
INNER
)"

if [[ -z "$REPORT" ]]; then
  echo "ERROR id=$RESOLVED_ID reason=docker_exec_failed"
  exit 0
fi

echo "STACK=$RESOLVED_ID"
echo "CLAUDE_CONTAINER=$CLAUDE_CTR"
echo "$REPORT"
