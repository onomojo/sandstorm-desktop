#!/usr/bin/env bash
# Script-backed review-and-pr compound skill (Ticket D continuation).
# Two subcommands:
#
#   review-and-pr.sh preview <stack-id>
#     -> prints the uncommitted diff from the stack workspace
#
#   review-and-pr.sh publish <stack-id> "<pr-title>"   (body on stdin)
#     -> push_stack + project create-pr.sh + set_pr, all in one shot
#
# The model is responsible for phase separation and for authoring the
# title + body; the script handles the deterministic wiring.

set -euo pipefail

SUBCOMMAND="${1:-}"
STACK_ID="${2:-}"

if [[ -z "$SUBCOMMAND" || -z "$STACK_ID" ]]; then
  echo "ERROR phase=args reason=missing expected=\"{preview|publish} <stack-id> [<title>]\""
  exit 0
fi

: "${SANDSTORM_BRIDGE_URL:?bridge url not set}"
: "${SANDSTORM_BRIDGE_TOKEN:?bridge token not set}"

call_bridge() {
  # $1 = name, $2 = input-json
  local payload
  payload=$(jq -cn --arg name "$1" --argjson input "$2" '{name:$name, input:$input}')
  curl -fsS -X POST \
    -H "X-Auth-Token: $SANDSTORM_BRIDGE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "$SANDSTORM_BRIDGE_URL/tool-call"
}

case "$SUBCOMMAND" in
  preview)
    DIFF_RESP="$(call_bridge get_diff "{\"stackId\":\"$STACK_ID\"}" 2>/dev/null || echo '{"error":"call_failed"}')"
    if echo "$DIFF_RESP" | jq -e '.error' >/dev/null 2>&1; then
      REASON="$(echo "$DIFF_RESP" | jq -r '.error')"
      echo "ERROR phase=preview reason=\"$REASON\" id=$STACK_ID"
      exit 0
    fi
    DIFF="$(echo "$DIFF_RESP" | jq -r '.result // ""')"
    if [[ -z "${DIFF//[[:space:]]/}" ]]; then
      echo "DIFF_EMPTY id=$STACK_ID"
      exit 0
    fi
    echo "$DIFF"
    ;;

  publish)
    PR_TITLE="${3:-}"
    if [[ -z "$PR_TITLE" ]]; then
      echo "ERROR phase=publish reason=missing_title expected=\"publish <stack-id> '<title>'\""
      exit 0
    fi
    # Body from stdin (possibly empty — still allowed, body is optional on gh pr create).
    PR_BODY=""
    if [[ ! -t 0 ]]; then
      PR_BODY="$(cat)"
    fi

    # 1) push_stack via bridge (runs the CLI push + branch push).
    PUSH_RESP="$(call_bridge push_stack "{\"stackId\":\"$STACK_ID\"}" 2>/dev/null || echo '{"error":"call_failed"}')"
    if echo "$PUSH_RESP" | jq -e '.error' >/dev/null 2>&1; then
      REASON="$(echo "$PUSH_RESP" | jq -r '.error')"
      echo "ERROR phase=push reason=\"$REASON\" id=$STACK_ID"
      exit 0
    fi

    # 2) Open the PR via the project's create-pr.sh helper.
    CREATE_SCRIPT="$PWD/.sandstorm/scripts/create-pr.sh"
    if [[ ! -x "$CREATE_SCRIPT" ]]; then
      echo "ERROR phase=pr_create reason=\"project .sandstorm/scripts/create-pr.sh missing or not executable\" id=$STACK_ID"
      exit 0
    fi
    # Pass body via --body-file to handle arbitrary length / special chars.
    BODY_FILE="$(mktemp)"
    trap 'rm -f "$BODY_FILE"' EXIT
    printf '%s' "$PR_BODY" >"$BODY_FILE"
    PR_OUTPUT="$("$CREATE_SCRIPT" --title "$PR_TITLE" --body-file "$BODY_FILE" 2>&1)" || {
      echo "ERROR phase=pr_create reason=\"$(echo "$PR_OUTPUT" | tr '\n' ' ' | head -c 300)\" id=$STACK_ID"
      exit 0
    }

    # Parse the PR URL and number from create-pr.sh output. It typically prints
    # the URL like https://github.com/org/repo/pull/123 on its last line.
    PR_URL="$(printf '%s\n' "$PR_OUTPUT" | grep -oE 'https://github\.com/[^[:space:]]+/pull/[0-9]+' | tail -1)"
    if [[ -z "$PR_URL" ]]; then
      echo "ERROR phase=pr_create reason=\"no_pr_url_in_output\" output=\"$(printf '%s' "$PR_OUTPUT" | tr '\n' ' ' | head -c 200)\" id=$STACK_ID"
      exit 0
    fi
    PR_NUMBER="$(echo "$PR_URL" | grep -oE '[0-9]+$')"

    # 3) Record the PR against the stack.
    SET_PR_INPUT=$(jq -cn --arg s "$STACK_ID" --arg u "$PR_URL" --argjson n "$PR_NUMBER" \
      '{stackId:$s, prUrl:$u, prNumber:$n}')
    SET_RESP="$(call_bridge set_pr "$SET_PR_INPUT" 2>/dev/null || echo '{"error":"call_failed"}')"
    if echo "$SET_RESP" | jq -e '.error' >/dev/null 2>&1; then
      REASON="$(echo "$SET_RESP" | jq -r '.error')"
      # PR is already live even if we couldn't record it; report the URL.
      echo "ERROR phase=set_pr reason=\"$REASON\" id=$STACK_ID pr=$PR_NUMBER url=$PR_URL"
      exit 0
    fi

    echo "OK stack=$STACK_ID pr=$PR_NUMBER url=$PR_URL"
    ;;

  *)
    echo "ERROR phase=args reason=unknown_subcommand got=\"$SUBCOMMAND\" expected=\"preview|publish\""
    exit 0
    ;;
esac
