#!/usr/bin/env bash
# Compound skill: spec + dispatch end-to-end (#312 refactor).
#
# Thin wrapper over the two primitives. No LLM logic here, no
# duplication of the gate loop. Calls:
#   - sandstorm-spec.sh check/refine  (primitive 1)
#   - sandstorm-dispatch.sh           (primitive 2)
#
# Usage:
#   spec-and-dispatch.sh check  <ticket-id>
#   spec-and-dispatch.sh refine <ticket-id>                 # answers on stdin
#   spec-and-dispatch.sh create <ticket-id> <stack-name>
#
# `create` requires the ticket to already be gate-ready. It's a pure
# dispatch pass-through to the dispatch primitive.

set -euo pipefail

SUBCOMMAND="${1:-}"
TICKET_ID="${2:-}"

if [[ -z "$SUBCOMMAND" || -z "$TICKET_ID" ]]; then
  echo '{"error":"missing_arg","expected":"{check|refine|create} <ticket-id> [<stack-name>]"}'
  exit 0
fi

: "${SANDSTORM_SKILLS_DIR:?SANDSTORM_SKILLS_DIR not set}"

SPEC_SCRIPT="$SANDSTORM_SKILLS_DIR/sandstorm-spec/scripts/sandstorm-spec.sh"
DISPATCH_SCRIPT="$SANDSTORM_SKILLS_DIR/sandstorm-dispatch/scripts/dispatch.sh"

if [[ ! -x "$SPEC_SCRIPT" ]]; then
  echo '{"error":"missing_primitive","script":"sandstorm-spec.sh","hint":"run sandstorm init or reinstall"}'
  exit 0
fi
if [[ ! -x "$DISPATCH_SCRIPT" ]]; then
  echo '{"error":"missing_primitive","script":"sandstorm-dispatch.sh","hint":"run sandstorm init or reinstall"}'
  exit 0
fi

case "$SUBCOMMAND" in
  check)
    # Pure delegation to the spec primitive.
    "$SPEC_SCRIPT" check "$TICKET_ID"
    ;;

  refine)
    # Pass stdin through to the spec primitive's refine mode.
    if [[ ! -t 0 ]]; then
      cat | "$SPEC_SCRIPT" refine "$TICKET_ID"
    else
      "$SPEC_SCRIPT" refine "$TICKET_ID" </dev/null
    fi
    ;;

  create)
    STACK_NAME="${3:-}"
    if [[ -n "$STACK_NAME" ]]; then
      "$DISPATCH_SCRIPT" "$TICKET_ID" --stack-name "$STACK_NAME"
    else
      "$DISPATCH_SCRIPT" "$TICKET_ID"
    fi
    ;;

  *)
    echo '{"error":"unknown_subcommand","got":"'"$SUBCOMMAND"'","expected":"check|refine|create"}'
    exit 0
    ;;
esac
