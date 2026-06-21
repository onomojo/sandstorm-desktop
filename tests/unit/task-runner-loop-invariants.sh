#!/bin/bash
#
# Behavioral loop-invariant harness: drives task-runner.sh main loop
# with function-shadowing stubs to verify loop counter and control-flow
# invariants.
#
# Usage: bash task-runner-loop-invariants.sh <case>
#
# Cases:
#   inner-counter-reset  — verify INNER_ITERATION resets to 0 on each outer
#                          loop iteration (after a verify failure)
#   review-pass-exits    — verify review PASS causes the inner loop to exit
#                          (run_verify is called)
#   meta-review-fallback — verify meta-review is called after 2 consecutive
#                          review failures
#
# Exit code: 0 = all assertions passed, 1 = assertion failed

# -uo (not -e): the dual-loop body calls functions that intentionally return
# non-zero (run_verify returning 1 for failure, etc.).  Keeping -e would abort
# before the $? capture.  -u catches unset variable bugs, -o pipefail catches
# pipeline failures that are not intentional.
set -uo pipefail

CASE="${1:-}"
if [ -z "$CASE" ]; then
  echo "Usage: $0 <case>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="${SCRIPT_DIR}/../fixtures/bash-harness.sh"

source "$HARNESS"
setup_harness
source_task_runner_with_loop

echo "TMPDIR=$tmpdir"

# ---------------------------------------------------------------------------
# Silence loop logging during tests
# ---------------------------------------------------------------------------
log_loop() { :; }

# ---------------------------------------------------------------------------
# Common no-op stubs
# ---------------------------------------------------------------------------
check_for_stop_and_ask() { return 1; }
check_for_token_limit()  { return 1; }
model_args_for_phase()   { RESOLVED_MODEL_ARGS=(); }

# ---------------------------------------------------------------------------
# run_dual_loop — initialize loop variables and execute the outer/inner
# review+verify loop.  Stubs defined in each case block control behavior.
# Reads: $PROMPT (set per case), $tmpdir (set by setup_harness).
# Writes: TASK_DONE, TASK_FAILED, INNER_ITERATION, OUTER_ITERATION, etc.
# ---------------------------------------------------------------------------
run_dual_loop() {
  ORIGINAL_PROMPT="$PROMPT"
  OUTER_ITERATION=0
  TASK_DONE=0
  TASK_FAILED=0
  TASK_NEEDS_HUMAN=0
  TASK_TOKEN_LIMITED=0
  TOTAL_REVIEW_ITERATIONS=0
  TOTAL_VERIFY_RETRIES=0
  VERIFY_BLOCKED_ENVIRONMENTAL=0
  CONSECUTIVE_REVIEW_FAILS=0
  META_REVIEW_FIRED_REVIEW=0
  META_REVIEW_FIRED_VERIFY=0
  META_REVIEW_STALE_TEST=0
  MAX_OUTER_ITERATIONS=5
  MAX_INNER_ITERATIONS=5
  MAX_TOTAL_REVIEW_ITERATIONS=5
  MAX_VERIFY_RETRIES=2

  while [ $OUTER_ITERATION -lt $MAX_OUTER_ITERATIONS ] && [ $TASK_DONE -eq 0 ] && [ $TASK_FAILED -eq 0 ]; do
    OUTER_ITERATION=$((OUTER_ITERATION + 1))
    INNER_ITERATION=0

    REVIEW_PASSED=0
    while [ $INNER_ITERATION -lt $MAX_INNER_ITERATIONS ] && [ $TOTAL_REVIEW_ITERATIONS -lt $MAX_TOTAL_REVIEW_ITERATIONS ] && [ $REVIEW_PASSED -eq 0 ]; do
      INNER_ITERATION=$((INNER_ITERATION + 1))
      TOTAL_REVIEW_ITERATIONS=$((TOTAL_REVIEW_ITERATIONS + 1))
      echo "${TOTAL_REVIEW_ITERATIONS}" > "${tmpdir}/claude-task.review-iterations"

      if run_review "$ORIGINAL_PROMPT" "$TOTAL_REVIEW_ITERATIONS"; then
        echo "REVIEW_PASS" > "${tmpdir}/claude-review-verdict-${TOTAL_REVIEW_ITERATIONS}.txt"
        if check_for_token_limit "${tmpdir}/claude-review-raw.log"; then
          TASK_TOKEN_LIMITED=1; TASK_FAILED=1; break
        fi
        REVIEW_PASSED=1
        CONSECUTIVE_REVIEW_FAILS=0
      else
        cp "${tmpdir}/claude-review-output.txt" "${tmpdir}/claude-review-verdict-${TOTAL_REVIEW_ITERATIONS}.txt" 2>/dev/null || echo "REVIEW_FAIL" > "${tmpdir}/claude-review-verdict-${TOTAL_REVIEW_ITERATIONS}.txt"
        if check_for_token_limit "${tmpdir}/claude-review-raw.log"; then
          TASK_TOKEN_LIMITED=1; TASK_FAILED=1; break
        fi
        CONSECUTIVE_REVIEW_FAILS=$((CONSECUTIVE_REVIEW_FAILS + 1))
        if [ $INNER_ITERATION -ge $MAX_INNER_ITERATIONS ]; then
          TASK_FAILED=1; break
        elif [ $TOTAL_REVIEW_ITERATIONS -ge $MAX_TOTAL_REVIEW_ITERATIONS ]; then
          TASK_FAILED=1; break
        fi
        if [ $CONSECUTIVE_REVIEW_FAILS -ge 2 ] && [ $META_REVIEW_FIRED_REVIEW -eq 0 ]; then
          META_REVIEW_FIRED_REVIEW=1
          if ! run_meta_review "review" "$TOTAL_REVIEW_ITERATIONS"; then
            if check_for_token_limit "${tmpdir}/claude-meta-review-raw.log" 2>/dev/null; then
              TASK_TOKEN_LIMITED=1; TASK_FAILED=1; break
            fi
            TASK_NEEDS_HUMAN=1; TASK_FAILED=1; break
          fi
        fi
        local_fix_prompt="${tmpdir}/claude-fix-prompt.txt"
        printf '' > "$local_fix_prompt"
        run_agent "$local_fix_prompt" "${tmpdir}/claude-raw.log" "${tmpdir}/claude-task.log" execution "$TOTAL_REVIEW_ITERATIONS"
        fix_exit=$?
        rm -f "$local_fix_prompt"
        if check_for_token_limit "${tmpdir}/claude-raw.log"; then
          TASK_TOKEN_LIMITED=1; TASK_FAILED=1; break
        fi
        if check_for_stop_and_ask "${tmpdir}/claude-task.log"; then
          TASK_NEEDS_HUMAN=1; TASK_FAILED=1; break
        fi
        if [ $fix_exit -ne 0 ]; then
          TASK_FAILED=1; break
        fi
      fi
    done

    if [ $TASK_FAILED -eq 0 ] && [ $REVIEW_PASSED -eq 0 ]; then
      TASK_FAILED=1
    fi
    if [ $TASK_FAILED -eq 1 ]; then break; fi

    run_verify
    verify_result=$?
    VERIFY_INDEX=$((TOTAL_VERIFY_RETRIES + 1))
    {
      if [ "$verify_result" -eq 0 ]; then echo "VERIFY_PASS"; else echo "VERIFY_FAIL"; fi
      cat "${tmpdir}/claude-verify.log" 2>/dev/null || true
    } > "${tmpdir}/claude-verify-output-${VERIFY_INDEX}.txt" 2>/dev/null || true

    if [ $verify_result -eq 0 ]; then
      TASK_DONE=1
    elif [ $verify_result -eq 2 ]; then
      VERIFY_BLOCKED_ENVIRONMENTAL=1; TASK_FAILED=1; break
    else
      TOTAL_VERIFY_RETRIES=$((TOTAL_VERIFY_RETRIES + 1))
      echo "${TOTAL_VERIFY_RETRIES}" > "${tmpdir}/claude-task.verify-retries"
      if [ $OUTER_ITERATION -ge $MAX_OUTER_ITERATIONS ]; then
        TASK_FAILED=1; break
      fi
      local_verify_fix="${tmpdir}/claude-verify-fix-prompt.txt"
      printf '' > "$local_verify_fix"
      run_agent "$local_verify_fix" "${tmpdir}/claude-raw.log" "${tmpdir}/claude-task.log" execution "$((TOTAL_REVIEW_ITERATIONS + 1))"
      verify_fix_exit=$?
      rm -f "$local_verify_fix"
      if check_for_token_limit "${tmpdir}/claude-raw.log"; then
        TASK_TOKEN_LIMITED=1; TASK_FAILED=1; break
      fi
      if check_for_stop_and_ask "${tmpdir}/claude-task.log"; then
        TASK_NEEDS_HUMAN=1; TASK_FAILED=1; break
      fi
      if [ $verify_fix_exit -ne 0 ]; then
        TASK_FAILED=1; break
      fi
    fi
  done
}

# ---------------------------------------------------------------------------
# Case: inner-counter-reset
#
# Flow:
#   outer iter 1:
#     inner iter 1: review passes → run_verify returns 1 (fail)
#   outer iter 2:
#     inner iter 1: review passes → run_verify returns 0 (pass)
#
# Assertion: INNER_ITERATION was 1 at both review calls (reset between outer
# iterations). We capture it via a global counter.
# ---------------------------------------------------------------------------
if [ "$CASE" = "inner-counter-reset" ]; then
  INNER_AT_REVIEW_CALL_1=""
  INNER_AT_REVIEW_CALL_2=""
  REVIEW_CALL_COUNT=0
  VERIFY_CALL_COUNT=0

  run_agent() {
    local _prompt_file="$1"; local _raw_log="$2"; local _task_log="$3"
    > "$_raw_log"; > "$_task_log"; return 0
  }

  run_review() {
    REVIEW_CALL_COUNT=$((REVIEW_CALL_COUNT + 1))
    if [ $REVIEW_CALL_COUNT -eq 1 ]; then
      INNER_AT_REVIEW_CALL_1=$INNER_ITERATION
    elif [ $REVIEW_CALL_COUNT -eq 2 ]; then
      INNER_AT_REVIEW_CALL_2=$INNER_ITERATION
    fi
    # Always pass review
    # run_review must write claude-review-raw.log for token check
    > "${tmpdir}/claude-review-raw.log"
    > "${tmpdir}/claude-review-task.log"
    return 0
  }

  run_verify() {
    VERIFY_CALL_COUNT=$((VERIFY_CALL_COUNT + 1))
    > "${tmpdir}/claude-verify.log"
    if [ $VERIFY_CALL_COUNT -eq 1 ]; then
      return 1   # first verify: fail → triggers outer loop second iteration
    fi
    return 0   # second verify: pass → TASK_DONE=1
  }

  run_meta_review() { return 0; }
  check_for_diff() { return 0; }

  PROMPT="Test prompt for inner-counter-reset"
  MODEL_ARGS=(); RESUME_ARGS=(); AGENT_BACKEND="claude"
  OPENCODE_MODEL=""; PHASE_ROUTING_JSON=""; PHASE_MODELS_JSON=""

  echo "running" > "${tmpdir}/claude-task.status"
  echo "$$" > "${tmpdir}/claude-task.pid"
  > "${tmpdir}/claude-raw.log"
  > "${tmpdir}/claude-tokens-execution"
  > "${tmpdir}/claude-tokens-review"
  > "${tmpdir}/claude-phase-timing.txt"
  echo "0" > "${tmpdir}/claude-task.review-iterations"
  echo "0" > "${tmpdir}/claude-task.verify-retries"

  run_agent "${tmpdir}/claude-task-prompt.txt" "${tmpdir}/claude-raw.log" "${tmpdir}/claude-task.log" execution 1
  EXIT_CODE=0
  > "${tmpdir}/claude-execute-output-0.txt"
  > "${tmpdir}/claude-execution-summary.txt"

  run_dual_loop

  # Assertions
  FAIL=0
  if [ "$INNER_AT_REVIEW_CALL_1" != "1" ]; then
    echo "FAIL: INNER_ITERATION at first review call was '$INNER_AT_REVIEW_CALL_1' (expected 1)" >&2
    FAIL=1
  else
    echo "PASS: INNER_ITERATION was 1 at first review call (outer iter 1)"
  fi

  if [ "$INNER_AT_REVIEW_CALL_2" != "1" ]; then
    echo "FAIL: INNER_ITERATION at second review call was '$INNER_AT_REVIEW_CALL_2' (expected 1, proving reset)" >&2
    FAIL=1
  else
    echo "PASS: INNER_ITERATION was 1 at second review call (outer iter 2, proves reset)"
  fi

  if [ "$TASK_DONE" != "1" ]; then
    echo "FAIL: task did not complete (TASK_DONE=$TASK_DONE, TASK_FAILED=$TASK_FAILED)" >&2
    FAIL=1
  else
    echo "PASS: task completed successfully"
  fi

  assert_no_tmp_leak "inner-counter-reset"
  [ $FAIL -eq 0 ] && echo "" && echo "PASS: all inner-counter-reset assertions passed" && exit 0
  exit 1
fi

# ---------------------------------------------------------------------------
# Case: review-pass-exits
#
# Flow: run_review passes on first call → REVIEW_PASSED=1 → inner loop exits
#       → run_verify is called.
# Assertion: verify called exactly once, loop exits with TASK_DONE=1.
# ---------------------------------------------------------------------------
if [ "$CASE" = "review-pass-exits" ]; then
  REVIEW_CALL_COUNT=0
  VERIFY_CALL_COUNT=0

  run_agent() {
    local _prompt_file="$1"; local _raw_log="$2"; local _task_log="$3"
    > "$_raw_log"; > "$_task_log"; return 0
  }

  run_review() {
    REVIEW_CALL_COUNT=$((REVIEW_CALL_COUNT + 1))
    > "${tmpdir}/claude-review-raw.log"
    > "${tmpdir}/claude-review-task.log"
    return 0   # always pass
  }

  run_verify() {
    VERIFY_CALL_COUNT=$((VERIFY_CALL_COUNT + 1))
    > "${tmpdir}/claude-verify.log"
    return 0   # pass
  }

  run_meta_review() { return 0; }
  check_for_diff() { return 0; }

  PROMPT="Test prompt for review-pass-exits"
  MODEL_ARGS=(); RESUME_ARGS=(); AGENT_BACKEND="claude"
  OPENCODE_MODEL=""; PHASE_ROUTING_JSON=""; PHASE_MODELS_JSON=""

  echo "running" > "${tmpdir}/claude-task.status"
  echo "$$" > "${tmpdir}/claude-task.pid"
  > "${tmpdir}/claude-raw.log"
  > "${tmpdir}/claude-tokens-execution"
  > "${tmpdir}/claude-tokens-review"
  > "${tmpdir}/claude-phase-timing.txt"
  echo "0" > "${tmpdir}/claude-task.review-iterations"
  echo "0" > "${tmpdir}/claude-task.verify-retries"

  run_agent "${tmpdir}/claude-task-prompt.txt" "${tmpdir}/claude-raw.log" "${tmpdir}/claude-task.log" execution 1
  EXIT_CODE=0
  > "${tmpdir}/claude-execute-output-0.txt"
  > "${tmpdir}/claude-execution-summary.txt"

  run_dual_loop

  FAIL=0
  if [ "$REVIEW_CALL_COUNT" != "1" ]; then
    echo "FAIL: run_review called $REVIEW_CALL_COUNT times (expected 1)" >&2
    FAIL=1
  else
    echo "PASS: run_review called exactly once"
  fi

  if [ "$VERIFY_CALL_COUNT" != "1" ]; then
    echo "FAIL: run_verify called $VERIFY_CALL_COUNT times (expected 1)" >&2
    FAIL=1
  else
    echo "PASS: run_verify called after review pass"
  fi

  if [ "$TASK_DONE" != "1" ]; then
    echo "FAIL: task did not complete (TASK_DONE=$TASK_DONE)" >&2
    FAIL=1
  else
    echo "PASS: task completed"
  fi

  assert_no_tmp_leak "review-pass-exits"
  [ $FAIL -eq 0 ] && echo "" && echo "PASS: all review-pass-exits assertions passed" && exit 0
  exit 1
fi

# ---------------------------------------------------------------------------
# Case: meta-review-fallback
#
# Flow:
#   review fails twice consecutively → META_REVIEW_FIRED_REVIEW=0 → run_meta_review
#   called with "review" context.  meta-review returns 0 (VIABLE) → loop continues.
# Assertion: run_meta_review called exactly once after 2 review failures.
# ---------------------------------------------------------------------------
if [ "$CASE" = "meta-review-fallback" ]; then
  REVIEW_CALL_COUNT=0
  META_REVIEW_CALL_COUNT=0
  VERIFY_CALL_COUNT=0

  run_agent() {
    local _prompt_file="$1"; local _raw_log="$2"; local _task_log="$3"
    > "$_raw_log"; > "$_task_log"; return 0
  }

  run_review() {
    REVIEW_CALL_COUNT=$((REVIEW_CALL_COUNT + 1))
    > "${tmpdir}/claude-review-raw.log"
    > "${tmpdir}/claude-review-task.log"
    > "${tmpdir}/claude-review-output.txt"
    if [ $REVIEW_CALL_COUNT -le 2 ]; then
      return 1   # first two: fail → trigger meta-review
    fi
    return 0   # third: pass → inner loop exits
  }

  run_meta_review() {
    META_REVIEW_CALL_COUNT=$((META_REVIEW_CALL_COUNT + 1))
    > "${tmpdir}/claude-meta-review-raw.log"
    return 0   # VIABLE
  }

  run_verify() {
    VERIFY_CALL_COUNT=$((VERIFY_CALL_COUNT + 1))
    > "${tmpdir}/claude-verify.log"
    return 0
  }

  check_for_diff() { return 0; }

  PROMPT="Test prompt for meta-review-fallback"
  MODEL_ARGS=(); RESUME_ARGS=(); AGENT_BACKEND="claude"
  OPENCODE_MODEL=""; PHASE_ROUTING_JSON=""; PHASE_MODELS_JSON=""

  echo "running" > "${tmpdir}/claude-task.status"
  echo "$$" > "${tmpdir}/claude-task.pid"
  > "${tmpdir}/claude-raw.log"
  > "${tmpdir}/claude-tokens-execution"
  > "${tmpdir}/claude-tokens-review"
  > "${tmpdir}/claude-phase-timing.txt"
  echo "0" > "${tmpdir}/claude-task.review-iterations"
  echo "0" > "${tmpdir}/claude-task.verify-retries"

  run_agent "${tmpdir}/claude-task-prompt.txt" "${tmpdir}/claude-raw.log" "${tmpdir}/claude-task.log" execution 1
  EXIT_CODE=0
  > "${tmpdir}/claude-execute-output-0.txt"
  > "${tmpdir}/claude-execution-summary.txt"

  run_dual_loop

  FAIL=0
  if [ "$META_REVIEW_CALL_COUNT" != "1" ]; then
    echo "FAIL: run_meta_review called $META_REVIEW_CALL_COUNT times (expected 1 after 2 review fails)" >&2
    FAIL=1
  else
    echo "PASS: run_meta_review called exactly once after 2 consecutive review failures"
  fi

  if [ "$REVIEW_CALL_COUNT" != "3" ]; then
    echo "FAIL: run_review called $REVIEW_CALL_COUNT times (expected 3: fail, fail, pass)" >&2
    FAIL=1
  else
    echo "PASS: run_review called 3 times (2 fails then 1 pass)"
  fi

  if [ "$TASK_DONE" != "1" ]; then
    echo "FAIL: task did not complete (TASK_DONE=$TASK_DONE, TASK_FAILED=$TASK_FAILED)" >&2
    FAIL=1
  else
    echo "PASS: task completed after meta-review guided the loop to resolution"
  fi

  assert_no_tmp_leak "meta-review-fallback"
  [ $FAIL -eq 0 ] && echo "" && echo "PASS: all meta-review-fallback assertions passed" && exit 0
  exit 1
fi

echo "Unknown case: $CASE" >&2
exit 1
