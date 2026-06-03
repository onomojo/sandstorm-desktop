#!/usr/bin/env bash
# Script-backed spec-gate skill (#312).
#
# Wraps the `spec_check` and `spec_refine` MCP tools in a single deterministic
# entry point. Two key behaviors beyond a raw bridge call:
#
#   1. OUTPUT TRIM — the bridge returns a ~25 KB `report` containing the full
#      rendered ticket body + gate table. That rides in orchestrator context
#      forever across sub-turns. We strip `report` and `updatedBody` and
#      emit a minimal JSON: {passed, questions?, gate_summary, cached?,
#      ticket_url?}. Downstream consumers re-fetch body via fetch-ticket.sh
#      when needed.
#
#   2. IDEMPOTENCY — before calling the bridge, check whether the ticket
#      already carries a `spec-ready:sha-<hash>` label whose hash matches
#      the current body hash. If so, return {passed: true, cached: true}
#      without invoking the LLM. Saves an ephemeral Claude call per cached
#      revisit and keeps the tool_result under 200 B.
#
# Usage:
#   sandstorm-spec.sh check  <ticket-id>
#   sandstorm-spec.sh refine <ticket-id>    # user answers on stdin

set -euo pipefail

SUBCOMMAND="${1:-}"
TICKET_ID="${2:-}"
PROJECT_DIR="${PWD}"

if [[ -z "$SUBCOMMAND" || -z "$TICKET_ID" ]]; then
  echo '{"error":"missing_arg","expected":"{check|refine} <ticket-id>"}'
  exit 0
fi

: "${SANDSTORM_BRIDGE_URL:?bridge url not set}"
: "${SANDSTORM_BRIDGE_TOKEN:?bridge token not set}"

call_bridge() {
  curl -fsS -X POST \
    -H "X-Auth-Token: $SANDSTORM_BRIDGE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$1" \
    "$SANDSTORM_BRIDGE_URL/tool-call"
}

# Compute a short hash of the current ticket body. Used both for the
# spec-ready:sha-<hash> label and for idempotency checks.
body_hash() {
  local id="$1"
  local script="$PROJECT_DIR/.sandstorm/scripts/fetch-ticket.sh"
  if [[ ! -x "$script" ]]; then
    echo ""
    return 0
  fi
  "$script" "$id" 2>/dev/null | sha256sum | cut -c1-12
}

# Try to fetch the ticket URL; empty string if unavailable (no-op fallback).
ticket_url() {
  local id="$1"
  if ! command -v gh >/dev/null 2>&1; then
    echo ""
    return 0
  fi
  gh issue view "$id" --json url -q '.url' 2>/dev/null || echo ""
}

# Check whether the ticket carries a matching `spec-ready:sha-<hash>` label.
# Output: prints "hit" on cache hit, "miss" otherwise.
idempotency_check() {
  local id="$1"
  local cur_hash="$2"
  if [[ -z "$cur_hash" ]] || ! command -v gh >/dev/null 2>&1; then
    echo "miss"
    return 0
  fi
  local labels
  labels="$(gh issue view "$id" --json labels -q '.labels[].name' 2>/dev/null || true)"
  if [[ -z "$labels" ]]; then
    echo "miss"
    return 0
  fi
  if echo "$labels" | grep -qxF "spec-ready:sha-$cur_hash"; then
    echo "hit"
    return 0
  fi
  echo "miss"
}

# Add or replace the spec-ready:sha-<hash> label. Strips any existing
# spec-ready:sha-* labels first so the label tracks the current body.
mark_spec_ready() {
  local id="$1"
  local hash="$2"
  if [[ -z "$hash" ]] || ! command -v gh >/dev/null 2>&1; then
    return 0
  fi
  # Best-effort label replacement; don't fail the whole command on label errors.
  local stale
  stale="$(gh issue view "$id" --json labels -q '.labels[].name' 2>/dev/null | grep -E '^spec-ready:sha-' || true)"
  if [[ -n "$stale" ]]; then
    while IFS= read -r lab; do
      [[ -z "$lab" ]] && continue
      gh issue edit "$id" --remove-label "$lab" >/dev/null 2>&1 || true
    done <<<"$stale"
  fi
  gh issue edit "$id" --add-label "spec-ready:sha-$hash" >/dev/null 2>&1 || true
}

# Extract a short, human-scannable summary line from the verbose MCP `report`.
# Looks for the PASS/FAIL header and the count of gate questions if any.
extract_gate_summary() {
  local report="$1"
  if [[ -z "$report" ]]; then
    echo ""
    return 0
  fi
  local verdict=""
  if echo "$report" | grep -qE '## Spec Quality Gate:\s*PASS'; then
    verdict="PASS"
  elif echo "$report" | grep -qE '## Spec Quality Gate:\s*FAIL'; then
    verdict="FAIL"
  fi
  local qcount
  qcount=$(echo "$report" | grep -cE '^[0-9]+\.\s' || true)
  if [[ -n "$verdict" ]]; then
    echo "Gate=$verdict, questions=$qcount"
  else
    echo "Gate verdict not parsed"
  fi
}

# Extract the top-level gate questions from the report. Returns a JSON
# array (possibly empty). Conservative: only grabs numbered questions under
# a "Questions" / "Gaps" heading.
extract_questions() {
  local report="$1"
  if [[ -z "$report" ]]; then
    echo "[]"
    return 0
  fi
  # Pull lines of the form `1. <text>`, `2. <text>`, etc., that appear AFTER
  # a "Questions" heading. This is a best-effort parse — if it finds nothing,
  # downstream still gets the pass/fail verdict from gate_summary.
  printf '%s\n' "$report" | awk '
    BEGIN { capture=0 }
    /### (Questions|Gaps)/ { capture=1; next }
    /^## / { capture=0 }
    capture && /^[0-9]+\./ {
      sub(/^[0-9]+\.\s*/, "")
      print
    }
  ' | jq -R -s 'split("\n") | map(select(length > 0))'
}

# Emit a trimmed JSON result merging verdict, summary, questions, and
# metadata. Never include the original `report` or `updatedBody` fields.
emit_trimmed() {
  local passed="$1"
  local report="$2"
  local url="$3"
  local cached="$4"
  local summary
  summary=$(extract_gate_summary "$report")
  local questions
  questions=$(extract_questions "$report")
  jq -cn \
    --argjson passed "$passed" \
    --arg summary "$summary" \
    --argjson questions "$questions" \
    --arg url "$url" \
    --argjson cached "$cached" \
    '{
      passed: $passed,
      gate_summary: $summary,
      questions: $questions,
      ticket_url: (if $url == "" then null else $url end),
      cached: $cached
    }'
}

case "$SUBCOMMAND" in
  check|refine)
    CUR_HASH="$(body_hash "$TICKET_ID")"
    URL="$(ticket_url "$TICKET_ID")"

    # Idempotency short-circuit (check only — refine is user-initiated
    # intent, assume the user wants to re-run even if the label is present).
    if [[ "$SUBCOMMAND" == "check" ]]; then
      HIT="$(idempotency_check "$TICKET_ID" "$CUR_HASH")"
      if [[ "$HIT" == "hit" ]]; then
        jq -cn \
          --arg summary "cached (body unchanged since last PASS)" \
          --arg url "$URL" \
          '{passed: true, gate_summary: $summary, questions: [], ticket_url: (if $url == "" then null else $url end), cached: true}'
        exit 0
      fi
    fi

    if [[ "$SUBCOMMAND" == "check" ]]; then
      INPUT=$(jq -cn --arg t "$TICKET_ID" --arg d "$PROJECT_DIR" \
        '{name:"spec_check", input:{ticketId:$t, projectDir:$d}}')
    else
      USER_ANSWERS=""
      if [[ ! -t 0 ]]; then
        USER_ANSWERS="$(cat)"
      fi
      INPUT=$(jq -cn \
        --arg t "$TICKET_ID" \
        --arg d "$PROJECT_DIR" \
        --arg u "$USER_ANSWERS" \
        '{name:"spec_refine", input:{ticketId:$t, projectDir:$d, userAnswers:$u}}')
    fi

    RESP="$(call_bridge "$INPUT" 2>/dev/null || echo '{"error":"call_failed"}')"

    # Extract the inner result if present, otherwise pass through the error.
    RESULT="$(echo "$RESP" | jq -c '.result // {error: (.error // "unknown_error")}')"
    if echo "$RESULT" | jq -e '.error' >/dev/null 2>&1; then
      # Pass errors through verbatim; callers expect to see them.
      echo "$RESULT"
      exit 0
    fi

    PASSED="$(echo "$RESULT" | jq -c '.passed // false')"
    REPORT="$(echo "$RESULT" | jq -r '.report // ""')"

    # On PASS, tag the ticket with spec-ready:sha-<hash> so subsequent checks
    # short-circuit. Refine's `updatedBody` is already committed to GitHub by
    # the MCP handler, so the hash we compute now reflects the new body.
    if [[ "$PASSED" == "true" && -n "$CUR_HASH" ]]; then
      # For refine, re-fetch body hash since the MCP handler updated the ticket.
      if [[ "$SUBCOMMAND" == "refine" ]]; then
        CUR_HASH="$(body_hash "$TICKET_ID")"
      fi
      mark_spec_ready "$TICKET_ID" "$CUR_HASH"
    fi

    emit_trimmed "$PASSED" "$REPORT" "$URL" "false"
    ;;

  *)
    echo '{"error":"unknown_subcommand","got":"'"$SUBCOMMAND"'","expected":"check|refine"}'
    exit 0
    ;;
esac
