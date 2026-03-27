#!/bin/bash
#
# Sandstorm task runner — watches for task triggers, executes them,
# and optionally runs a review/verify dual-loop for code changes.
#
# Dual-loop workflow (activated when code changes are detected):
#
#   OUTER LOOP (max 5 iterations):
#     INNER LOOP (max 5 iterations, resets each outer):
#       Execution Agent → Review Agent (fresh context)
#       If review fails → back to Execution Agent
#       If review passes → exit inner loop
#     VERIFY (runs ONCE after review passes, not on every review iteration):
#       npm test, tsc --noEmit, npm run build
#       If pass → done
#       If fail → fix errors → back to outer loop (inner counter resets)
#
# Runs as PID 1 so all output goes to docker logs.
#

MAX_INNER_ITERATIONS=5
MAX_OUTER_ITERATIONS=5

# ─── Helpers ────────────────────────────────────────────────────────────────

log_loop() {
  echo "[LOOP] $1"
}

# Run the claude CLI with streaming output.
# Args: $1 = prompt file path, $2 = raw log path, $3 = task log path, $4... = extra claude args
run_claude() {
  local prompt_file="$1"
  local raw_log="${2:-/tmp/claude-raw.log}"
  local task_log="${3:-/tmp/claude-task.log}"
  shift 3 2>/dev/null || shift $#
  local extra_args=("$@")

  cat "$prompt_file" \
    | claude --dangerously-skip-permissions --verbose --output-format stream-json \
        "${extra_args[@]}" \
        --include-partial-messages --print -p - 2>&1 \
    | stdbuf -o0 tee -a "$raw_log" \
    | jq -rj --unbuffered '
        if .type == "stream_event" then
          if .event.type == "content_block_delta" and .event.delta.type == "text_delta" then
            .event.delta.text
          elif .event.type == "content_block_start" and .event.content_block.type == "tool_use" then
            "\n── \(.event.content_block.name) ──\n"
          elif .event.type == "content_block_start" and .event.content_block.type == "text" then
            ""
          else
            empty
          end
        elif .type == "assistant" then
          (.message.content[]? |
            if .type == "tool_use" then
              "\n── \(.name) ──\n" +
              (.input |
                if .command then "  $ \(.command)\n"
                elif .file_path then "  \(.file_path)\n"
                elif .pattern then "  \(.pattern)\n"
                elif .prompt then "  \(.prompt | split("\n")[0][:100])\n"
                else "  \(tostring[:120])\n"
                end
              )
            elif .type == "text" then
              .text
            else
              empty
            end
          ) // empty
        elif .type == "result" then
          "\n" + (.result // "") + "\n"
        elif .type == "error" then
          "\n❌ ERROR: " + (.error.message // "unknown error") + "\n"
        else
          empty
        end
      ' 2>/dev/null \
    | stdbuf -o0 tee "$task_log"
  return ${PIPESTATUS[0]}
}

# Check if there are code changes in the workspace.
check_for_diff() {
  local diff_output
  diff_output=$(cd /app && git diff --stat HEAD 2>/dev/null)
  if [ -n "$diff_output" ]; then
    return 0  # changes exist
  fi
  # Also check for untracked files (new files)
  local untracked
  untracked=$(cd /app && git ls-files --others --exclude-standard 2>/dev/null)
  if [ -n "$untracked" ]; then
    return 0  # new files exist
  fi
  return 1  # no changes
}

# Run the review agent with a fresh context.
# Writes review output to /tmp/claude-review-output.txt
# Returns 0 if review passed, 1 if review failed.
run_review() {
  local original_prompt="$1"

  # Capture diffs to files to avoid bash variable size limits and special char mangling
  (cd /app && git diff HEAD 2>/dev/null) > /tmp/claude-review-diff.txt
  (cd /app && git ls-files --others --exclude-standard -z 2>/dev/null | xargs -0 -I{} git diff --no-index /dev/null {} 2>/dev/null || true) > /tmp/claude-review-untracked.txt

  # Build the review prompt from template
  local review_prompt_file="/tmp/claude-review-prompt.txt"
  local template="/usr/bin/review-prompt.md"

  if [ ! -f "$template" ]; then
    # Fallback if template not installed
    template="/app/sandstorm-cli/docker/review-prompt.md"
  fi

  # Assemble the review prompt
  {
    cat "$template"
    echo ""
    echo "## Original Task"
    echo ""
    echo "$original_prompt"
    echo ""
    echo "## Current Diff (staged + unstaged)"
    echo ""
    echo '```diff'
    cat /tmp/claude-review-diff.txt
    if [ -s /tmp/claude-review-untracked.txt ]; then
      echo ""
      echo "# New (untracked) files:"
      cat /tmp/claude-review-untracked.txt
    fi
    echo '```'
  } > "$review_prompt_file"

  log_loop "Starting review agent with fresh context..."

  # Run claude with separate log files to preserve execution agent logs
  run_claude "$review_prompt_file" /tmp/claude-review-raw.log /tmp/claude-review-task.log "${MODEL_ARGS[@]}"
  local review_exit=$?

  rm -f "$review_prompt_file" /tmp/claude-review-diff.txt /tmp/claude-review-untracked.txt

  if [ $review_exit -ne 0 ]; then
    log_loop "Review agent crashed (exit $review_exit), treating as REVIEW_FAIL"
    echo "Review agent crashed with exit code $review_exit" > /tmp/claude-review-output.txt
    return 1
  fi

  # Parse only the last 10 lines for verdict to avoid false matches from quoted format text
  local tail_output
  tail_output=$(tail -10 /tmp/claude-review-task.log 2>/dev/null)

  if echo "$tail_output" | grep -q "REVIEW_PASS"; then
    log_loop "Review verdict: PASS"
    return 0
  elif echo "$tail_output" | grep -q "REVIEW_FAIL"; then
    log_loop "Review verdict: FAIL"
    # Extract the review report for the execution agent
    cp /tmp/claude-review-task.log /tmp/claude-review-output.txt
    return 1
  else
    # No clear verdict — treat as fail to be safe
    log_loop "Review verdict: UNCLEAR (no REVIEW_PASS/REVIEW_FAIL found), treating as FAIL"
    cp /tmp/claude-review-task.log /tmp/claude-review-output.txt
    return 1
  fi
}

# Run verification: tests, type check, build.
# Returns 0 if all pass, 1 if any fail.
run_verify() {
  local verify_log="/tmp/claude-verify.log"
  > "$verify_log"

  log_loop "Running verification suite..."

  local failed=0

  # Step 1: Tests
  log_loop "Verify: running npm test..."
  (cd /app && npm test 2>&1) | tee -a "$verify_log"
  if [ ${PIPESTATUS[0]} -ne 0 ]; then
    log_loop "Verify: tests FAILED"
    failed=1
  else
    log_loop "Verify: tests PASSED"
  fi

  # Step 2: Type check (only if tests passed — fail fast)
  if [ $failed -eq 0 ]; then
    log_loop "Verify: running tsc --noEmit..."
    (cd /app && npx tsc --noEmit 2>&1) | tee -a "$verify_log"
    if [ ${PIPESTATUS[0]} -ne 0 ]; then
      log_loop "Verify: type check FAILED"
      failed=1
    else
      log_loop "Verify: type check PASSED"
    fi
  fi

  # Step 3: Build (only if types passed)
  if [ $failed -eq 0 ]; then
    log_loop "Verify: running npm run build..."
    (cd /app && npm run build 2>&1) | tee -a "$verify_log"
    if [ ${PIPESTATUS[0]} -ne 0 ]; then
      log_loop "Verify: build FAILED"
      failed=1
    else
      log_loop "Verify: build PASSED"
    fi
  fi

  return $failed
}

# ─── Main Loop ──────────────────────────────────────────────────────────────

echo "Waiting for tasks..."

# Signal readiness — entrypoint.sh hands off to us, so we own the marker from here
echo "ready" > /tmp/claude-ready

while true; do
  if [ -f /tmp/claude-task-trigger ]; then
    # Clear readiness marker while task is running
    rm -f /tmp/claude-ready
    rm -f /tmp/claude-task-trigger
    PROMPT=$(cat /tmp/claude-task-prompt.txt 2>/dev/null)
    LABEL=$(echo "$PROMPT" | head -1 | cut -c1-60)

    # Read model selection if provided
    MODEL_ARGS=()
    TASK_MODEL=""
    if [ -f /tmp/claude-task-model.txt ]; then
      TASK_MODEL=$(cat /tmp/claude-task-model.txt 2>/dev/null | tr -d '[:space:]')
      if [ -n "$TASK_MODEL" ]; then
        MODEL_ARGS=(--model "$TASK_MODEL")
      fi
      rm -f /tmp/claude-task-model.txt
    fi

    echo ""
    echo "=========================================="
    echo "  Task: $LABEL"
    if [ ${#MODEL_ARGS[@]} -gt 0 ]; then
      echo "  Model: $TASK_MODEL"
    fi
    echo "=========================================="
    echo "running" > /tmp/claude-task.status
    echo $$ > /tmp/claude-task.pid

    # Truncate the raw log so token data starts fresh for this task
    > /tmp/claude-raw.log

    # ── Step 1: Initial execution pass ──────────────────────────────────

    log_loop "Starting initial execution pass..."
    run_claude /tmp/claude-task-prompt.txt /tmp/claude-raw.log /tmp/claude-task.log "${MODEL_ARGS[@]}"
    EXIT_CODE=${PIPESTATUS[0]}

    if [ $EXIT_CODE -ne 0 ]; then
      log_loop "Initial execution failed (exit $EXIT_CODE), skipping review loop"
      rm -f /tmp/claude-task-prompt.txt
      echo $EXIT_CODE > /tmp/claude-task.exit
      echo "failed" > /tmp/claude-task.status
      rm -f /tmp/claude-task.pid
      echo ""
      echo "=========================================="
      echo "  Task finished (exit: $EXIT_CODE)"
      echo "=========================================="
      echo ""
      echo "ready" > /tmp/claude-ready
      echo "Waiting for tasks..."
      continue
    fi

    # ── Step 2: Check for code changes ──────────────────────────────────

    log_loop "Execution pass 1 complete, checking for code changes..."

    if ! check_for_diff; then
      # No code changes — single-pass task, we're done
      log_loop "No code changes detected, task complete (single-pass)"
      rm -f /tmp/claude-task-prompt.txt
      echo 0 > /tmp/claude-task.exit
      echo "completed" > /tmp/claude-task.status
      rm -f /tmp/claude-task.pid
      echo ""
      echo "=========================================="
      echo "  Task finished (exit: 0) — no code changes, single-pass"
      echo "=========================================="
      echo ""
      echo "ready" > /tmp/claude-ready
      echo "Waiting for tasks..."
      continue
    fi

    log_loop "Code changes detected, entering review loop"

    # ── Step 3: Dual-loop ───────────────────────────────────────────────

    ORIGINAL_PROMPT="$PROMPT"
    OUTER_ITERATION=0
    TASK_DONE=0
    TASK_FAILED=0
    TOTAL_REVIEW_ITERATIONS=0
    TOTAL_VERIFY_RETRIES=0

    while [ $OUTER_ITERATION -lt $MAX_OUTER_ITERATIONS ] && [ $TASK_DONE -eq 0 ] && [ $TASK_FAILED -eq 0 ]; do
      OUTER_ITERATION=$((OUTER_ITERATION + 1))
      INNER_ITERATION=0

      log_loop "Outer iteration $OUTER_ITERATION/$MAX_OUTER_ITERATIONS"

      # ── Inner loop: execution ↔ review ──────────────────────────────

      REVIEW_PASSED=0
      while [ $INNER_ITERATION -lt $MAX_INNER_ITERATIONS ] && [ $REVIEW_PASSED -eq 0 ]; do
        INNER_ITERATION=$((INNER_ITERATION + 1))
        TOTAL_REVIEW_ITERATIONS=$((TOTAL_REVIEW_ITERATIONS + 1))

        log_loop "Review iteration $INNER_ITERATION/$MAX_INNER_ITERATIONS (outer $OUTER_ITERATION/$MAX_OUTER_ITERATIONS)"

        # Run the review agent
        if run_review "$ORIGINAL_PROMPT"; then
          REVIEW_PASSED=1
          log_loop "Review passed at inner iteration $INNER_ITERATION"
        else
          log_loop "Review iteration $INNER_ITERATION/$MAX_INNER_ITERATIONS: FAIL"

          if [ $INNER_ITERATION -ge $MAX_INNER_ITERATIONS ]; then
            log_loop "Inner loop exhausted ($MAX_INNER_ITERATIONS iterations). Needs human intervention."
            TASK_FAILED=1
            break
          fi

          # Feed review feedback back to execution agent
          log_loop "Sending review feedback to execution agent..."
          local_fix_prompt="/tmp/claude-fix-prompt.txt"
          {
            echo "Your code changes were reviewed and issues were found. Please fix the following issues:"
            echo ""
            cat /tmp/claude-review-output.txt
            echo ""
            echo "Original task for context:"
            echo "$ORIGINAL_PROMPT"
            echo ""
            echo "Fix all listed issues. Do not introduce new problems."
          } > "$local_fix_prompt"

          run_claude "$local_fix_prompt" /tmp/claude-raw.log /tmp/claude-task.log "${MODEL_ARGS[@]}"
          fix_exit=$?
          rm -f "$local_fix_prompt"

          if [ $fix_exit -ne 0 ]; then
            log_loop "Execution agent fix pass failed (exit $fix_exit)"
            TASK_FAILED=1
            break
          fi
        fi
      done

      if [ $TASK_FAILED -eq 1 ]; then
        break
      fi

      # ── Verify step ─────────────────────────────────────────────────

      log_loop "Review passed, running verification..."

      if run_verify; then
        log_loop "Verification PASSED"
        log_loop "Task complete after $TOTAL_REVIEW_ITERATIONS review iteration(s), $TOTAL_VERIFY_RETRIES verify retry/retries"
        TASK_DONE=1
      else
        TOTAL_VERIFY_RETRIES=$((TOTAL_VERIFY_RETRIES + 1))
        log_loop "Verify FAILED, outer iteration $OUTER_ITERATION/$MAX_OUTER_ITERATIONS"

        if [ $OUTER_ITERATION -ge $MAX_OUTER_ITERATIONS ]; then
          log_loop "Outer loop exhausted ($MAX_OUTER_ITERATIONS iterations). Needs human intervention."
          TASK_FAILED=1
          break
        fi

        # Feed verify errors back to execution agent for next outer iteration
        log_loop "Sending verify failure to execution agent..."
        local_verify_fix="/tmp/claude-verify-fix-prompt.txt"
        {
          echo "Your code changes passed review but failed verification. Please fix the following errors:"
          echo ""
          cat /tmp/claude-verify.log
          echo ""
          echo "Original task for context:"
          echo "$ORIGINAL_PROMPT"
          echo ""
          echo "Fix the verification failures (test failures, type errors, or build errors). Do not introduce new problems."
        } > "$local_verify_fix"

        run_claude "$local_verify_fix" /tmp/claude-raw.log /tmp/claude-task.log "${MODEL_ARGS[@]}"
        verify_fix_exit=$?
        rm -f "$local_verify_fix"

        if [ $verify_fix_exit -ne 0 ]; then
          log_loop "Execution agent verify-fix pass failed (exit $verify_fix_exit)"
          TASK_FAILED=1
          break
        fi
      fi
    done

    # ── Final status ──────────────────────────────────────────────────

    rm -f /tmp/claude-task-prompt.txt
    rm -f /tmp/claude-review-output.txt
    rm -f /tmp/claude-review-raw.log
    rm -f /tmp/claude-review-task.log
    rm -f /tmp/claude-verify.log

    # Write loop iteration counts for the task watcher to read
    echo "${TOTAL_REVIEW_ITERATIONS}" > /tmp/claude-task.review-iterations
    echo "${TOTAL_VERIFY_RETRIES}" > /tmp/claude-task.verify-retries

    if [ $TASK_DONE -eq 1 ]; then
      echo 0 > /tmp/claude-task.exit
      echo "completed" > /tmp/claude-task.status
      EXIT_CODE=0
    else
      echo 1 > /tmp/claude-task.exit
      echo "failed" > /tmp/claude-task.status
      EXIT_CODE=1
    fi
    rm -f /tmp/claude-task.pid

    echo ""
    echo "=========================================="
    echo "  Task finished (exit: $EXIT_CODE)"
    if [ $TASK_DONE -eq 1 ]; then
      echo "  Review iterations: $TOTAL_REVIEW_ITERATIONS"
      echo "  Verify retries: $TOTAL_VERIFY_RETRIES"
    elif [ $TASK_FAILED -eq 1 ]; then
      echo "  STATUS: NEEDS HUMAN INTERVENTION"
      echo "  Review iterations: $TOTAL_REVIEW_ITERATIONS"
      echo "  Verify retries: $TOTAL_VERIFY_RETRIES"
    fi
    echo "=========================================="
    echo ""
    # Re-signal readiness for next task
    echo "ready" > /tmp/claude-ready
    echo "Waiting for tasks..."
  fi
  sleep 1
done
