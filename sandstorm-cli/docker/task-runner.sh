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
#       Runs .sandstorm/verify.sh (project-configurable)
#       If pass → done
#       If fail → fix errors → back to outer loop (inner counter resets)
#       If no verify.sh exists → skip verification, treat as pass
#
# Runs as PID 1 so all output goes to docker logs.
#

MAX_INNER_ITERATIONS=5
MAX_OUTER_ITERATIONS=5
MAX_TOTAL_REVIEW_ITERATIONS=5  # global cap across all outer/inner iterations combined
MAX_VERIFY_RETRIES=2            # consecutive verify-fail cap before halting as environmental

# ─── Helpers ────────────────────────────────────────────────────────────────

log_loop() {
  echo "[LOOP] $1"
}

# Check if the execution agent emitted a STOP_AND_ASK signal in its output.
# If found, writes the reason to /tmp/claude-stop-reason.txt and returns 0.
# Returns 1 if no STOP_AND_ASK found.
check_for_stop_and_ask() {
  local log_file="${1:-/tmp/claude-task.log}"
  local stop_line
  stop_line=$(grep -m1 'STOP_AND_ASK:' "$log_file" 2>/dev/null)
  if [ -n "$stop_line" ]; then
    local reason
    reason=$(echo "$stop_line" | sed 's/.*STOP_AND_ASK:[[:space:]]*//')
    echo "$reason" > /tmp/claude-stop-reason.txt
    log_loop "Agent signaled STOP_AND_ASK: $reason"
    return 0
  fi
  return 1
}

# Run the claude CLI with streaming output.
# Args: $1 = prompt file path, $2 = raw log path, $3 = task log path, $4 = phase (execution|review|verify), $5 = iteration (1-based), $6... = extra claude args
run_claude() {
  local prompt_file="$1"
  local raw_log="${2:-/tmp/claude-raw.log}"
  local task_log="${3:-/tmp/claude-task.log}"
  local phase="${4:-execution}"
  local iteration="${5:-1}"
  shift 5 2>/dev/null || shift $#
  local extra_args=("$@")

  local token_file="/tmp/claude-tokens-${phase}"
  local counter_script="/usr/bin/token-counter.sh"
  if [ ! -f "$counter_script" ]; then
    counter_script="/app/sandstorm-cli/docker/token-counter.sh"
  fi

  cat "$prompt_file" \
    | claude --dangerously-skip-permissions --verbose --output-format stream-json \
        --mcp-config /tmp/sandstorm-mcp.json --strict-mcp-config \
        "${extra_args[@]}" \
        --include-partial-messages --print -p - 2>&1 \
    | stdbuf -o0 tee -a "$raw_log" \
    | stdbuf -o0 tee >(bash "$counter_script" "$token_file" "$iteration" "$phase") \
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
# Args: $1 = original prompt, $2 = iteration number (1-based)
run_review() {
  local original_prompt="$1"
  local iteration="${2:-1}"

  # Build the review prompt from template
  local review_prompt_file="/tmp/claude-review-prompt.txt"
  local template=""

  # Check for per-project review prompt first
  if [ -f "/app/.sandstorm/review-prompt.md" ] && [ -s "/app/.sandstorm/review-prompt.md" ]; then
    template="/app/.sandstorm/review-prompt.md"
    log_loop "Using per-project review prompt: $template"
  elif [ -f "/app/.sandstorm/review-prompt.md" ] && [ ! -s "/app/.sandstorm/review-prompt.md" ]; then
    log_loop "WARNING: /app/.sandstorm/review-prompt.md exists but is empty, falling back to built-in default"
  fi

  # Fall back to built-in default
  if [ -z "$template" ]; then
    template="/usr/bin/review-prompt.md"
    if [ ! -f "$template" ]; then
      # Fallback if template not installed
      template="/app/sandstorm-cli/docker/review-prompt.md"
    fi
  fi

  # Assemble the review prompt (template + original task only — no diff content)
  # The review agent discovers changes itself via git status / git diff
  {
    cat "$template"
    echo ""
    echo "## Original Task"
    echo ""
    echo "$original_prompt"
  } > "$review_prompt_file"

  log_loop "Starting review agent with fresh context..."

  # Run claude with separate log files to preserve execution agent logs
  run_claude "$review_prompt_file" /tmp/claude-review-raw.log /tmp/claude-review-task.log review "$iteration" "${MODEL_ARGS[@]}"
  local review_exit=$?

  rm -f "$review_prompt_file"

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

# Classify test results: checks if vitest output indicates all tests passed
# but only has infrastructure errors (uncaught exceptions, permission errors).
# Returns 0 if infrastructure-only errors detected, 1 otherwise.
is_infra_error_only() {
  local log_file="$1"

  # Check if there are actual test file failures (e.g. "Test Files  2 failed")
  if grep -qE 'Test Files.*failed' "$log_file"; then
    return 1  # Real test failures
  fi

  # Check if there are actual test case failures (e.g. "Tests  3 failed")
  if grep -qE '^\s*Tests.*failed' "$log_file"; then
    return 1  # Real test failures
  fi

  # Check for infrastructure error signatures
  local has_infra_errors=false
  if grep -qE 'EACCES: permission denied' "$log_file"; then
    has_infra_errors=true
  fi
  if grep -qE 'Uncaught Exception|Unhandled Error' "$log_file"; then
    has_infra_errors=true
  fi
  # Check for missing binary / command not found (shell-level, not test-level, failures)
  if grep -qE '(command not found|: not found|executable file not found in \$PATH)' "$log_file"; then
    has_infra_errors=true
  fi

  if [ "$has_infra_errors" = true ]; then
    return 0  # Infrastructure errors only
  fi

  return 1  # Unknown failure — treat as real
}

# Run verification using the project's .sandstorm/verify.sh script.
# Returns: 0 = all pass (or no verify.sh), 1 = failure (retryable), 2 = infrastructure error (halt)
run_verify() {
  local verify_script="/app/.sandstorm/verify.sh"
  local verify_log="/tmp/claude-verify.log"
  > "$verify_log"

  # If no verify.sh exists, skip verification entirely
  if [ ! -f "$verify_script" ]; then
    log_loop "No .sandstorm/verify.sh found — skipping verification"
    return 0
  fi

  log_loop "Running verification suite (.sandstorm/verify.sh)..."

  # Run the project's verify script, redirect all output to log only
  (cd /app && bash "$verify_script" 2>&1) >> "$verify_log"
  local exit_code=$?

  if [ $exit_code -eq 0 ]; then
    echo "VERIFY_PASS"
    return 0
  fi

  # Check if this is an infrastructure error vs real failure
  if is_infra_error_only "$verify_log"; then
    echo "VERIFY_FAIL"
    tail -n 50 "$verify_log"
    log_loop "Verify: infrastructure errors detected (e.g. permission denied) — halting, not retrying"
    return 2
  fi

  echo "VERIFY_FAIL"
  tail -n 50 "$verify_log"
  log_loop "Verify: FAILED (exit code $exit_code)"
  return 1
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

    # Truncate the raw log and token files so data starts fresh for this task
    > /tmp/claude-raw.log
    > /tmp/claude-tokens-execution
    > /tmp/claude-tokens-review

    # Clean up numbered metadata files from previous tasks
    rm -f /tmp/claude-review-verdict-*.txt
    rm -f /tmp/claude-verify-output-*.txt
    rm -f /tmp/claude-execution-summary.txt
    rm -f /tmp/claude-phase-timing.txt

    # Initialize phase timing file
    > /tmp/claude-phase-timing.txt

    # Initialize iteration count files for live monitoring
    echo "0" > /tmp/claude-task.review-iterations
    echo "0" > /tmp/claude-task.verify-retries

    # ── Step 1: Initial execution pass ──────────────────────────────────

    log_loop "Starting initial execution pass..."
    echo "execution_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/claude-phase-timing.txt
    run_claude /tmp/claude-task-prompt.txt /tmp/claude-raw.log /tmp/claude-task.log execution 1 "${MODEL_ARGS[@]}"
    EXIT_CODE=${PIPESTATUS[0]}
    echo "execution_finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/claude-phase-timing.txt

    # Capture execution summary (last 50 lines of task log)
    tail -50 /tmp/claude-task.log 2>/dev/null > /tmp/claude-execution-summary.txt

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

    # ── Step 2: Check for STOP_AND_ASK before anything else ────────────

    log_loop "Execution pass 1 complete, checking for STOP_AND_ASK..."

    # Check if the agent signaled it cannot proceed without human input.
    # Must run before check_for_diff: agent may emit STOP_AND_ASK with no
    # code changes (e.g. task is out of scope from the start).
    if check_for_stop_and_ask /tmp/claude-task.log; then
      log_loop "STOP_AND_ASK detected during initial execution — halting, needs human intervention"
      rm -f /tmp/claude-task-prompt.txt
      echo 1 > /tmp/claude-task.exit
      echo "needs_human" > /tmp/claude-task.status
      rm -f /tmp/claude-task.pid
      echo ""
      echo "=========================================="
      echo "  Task finished (exit: 1)"
      echo "  STATUS: NEEDS HUMAN INTERVENTION"
      echo "  Reason: $(cat /tmp/claude-stop-reason.txt 2>/dev/null)"
      echo "=========================================="
      echo ""
      echo "ready" > /tmp/claude-ready
      echo "Waiting for tasks..."
      continue
    fi

    # ── Step 3: Check for code changes ──────────────────────────────────

    log_loop "Checking for code changes..."

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

    # ── Step 4: Dual-loop ───────────────────────────────────────────────

    ORIGINAL_PROMPT="$PROMPT"
    OUTER_ITERATION=0
    TASK_DONE=0
    TASK_FAILED=0
    TASK_NEEDS_HUMAN=0
    TOTAL_REVIEW_ITERATIONS=0
    TOTAL_VERIFY_RETRIES=0
    VERIFY_BLOCKED_ENVIRONMENTAL=0

    while [ $OUTER_ITERATION -lt $MAX_OUTER_ITERATIONS ] && [ $TASK_DONE -eq 0 ] && [ $TASK_FAILED -eq 0 ]; do
      OUTER_ITERATION=$((OUTER_ITERATION + 1))
      INNER_ITERATION=0

      log_loop "Outer iteration $OUTER_ITERATION/$MAX_OUTER_ITERATIONS"

      # ── Inner loop: execution ↔ review ──────────────────────────────

      REVIEW_PASSED=0
      while [ $INNER_ITERATION -lt $MAX_INNER_ITERATIONS ] && [ $TOTAL_REVIEW_ITERATIONS -lt $MAX_TOTAL_REVIEW_ITERATIONS ] && [ $REVIEW_PASSED -eq 0 ]; do
        INNER_ITERATION=$((INNER_ITERATION + 1))
        TOTAL_REVIEW_ITERATIONS=$((TOTAL_REVIEW_ITERATIONS + 1))
        # Update iteration count file for live monitoring
        echo "${TOTAL_REVIEW_ITERATIONS}" > /tmp/claude-task.review-iterations

        log_loop "Review iteration $INNER_ITERATION/$MAX_INNER_ITERATIONS (outer $OUTER_ITERATION/$MAX_OUTER_ITERATIONS)"

        # Record review phase start (overwrite each iteration — last one wins)
        echo "review_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/claude-phase-timing.txt

        # Run the review agent
        if run_review "$ORIGINAL_PROMPT" "$TOTAL_REVIEW_ITERATIONS"; then
          echo "review_finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/claude-phase-timing.txt
          # Save numbered review verdict
          echo "REVIEW_PASS" > "/tmp/claude-review-verdict-${TOTAL_REVIEW_ITERATIONS}.txt"
          REVIEW_PASSED=1
          log_loop "Review passed at inner iteration $INNER_ITERATION"
        else
          echo "review_finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/claude-phase-timing.txt
          # Save numbered review verdict (copy full review output)
          cp /tmp/claude-review-output.txt "/tmp/claude-review-verdict-${TOTAL_REVIEW_ITERATIONS}.txt" 2>/dev/null || echo "REVIEW_FAIL" > "/tmp/claude-review-verdict-${TOTAL_REVIEW_ITERATIONS}.txt"
          log_loop "Review iteration $INNER_ITERATION/$MAX_INNER_ITERATIONS: FAIL"

          if [ $INNER_ITERATION -ge $MAX_INNER_ITERATIONS ]; then
            log_loop "Inner loop exhausted ($MAX_INNER_ITERATIONS iterations). Needs human intervention."
            TASK_FAILED=1
            break
          elif [ $TOTAL_REVIEW_ITERATIONS -ge $MAX_TOTAL_REVIEW_ITERATIONS ]; then
            log_loop "Global review cap reached ($TOTAL_REVIEW_ITERATIONS/$MAX_TOTAL_REVIEW_ITERATIONS total). Needs human intervention."
            TASK_FAILED=1
            break
          fi

          # Feed review feedback back to execution agent
          log_loop "Sending review feedback to execution agent..."
          echo "execution_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/claude-phase-timing.txt
          local_fix_prompt="/tmp/claude-fix-prompt.txt"
          {
            echo "Your code changes were reviewed and issues were found. Please fix the following issues:"
            echo ""
            cat /tmp/claude-review-output.txt
            echo ""
            echo "## Original Task (verbatim — defines your scope)"
            echo ""
            echo "$ORIGINAL_PROMPT"
            echo ""
            echo "## Files Already Modified"
            echo ""
            echo "The following files have already been changed in this task (these are the"
            echo "in-scope files you should be working within — do not touch files outside"
            echo "this list unless they are clearly in scope for the task):"
            echo ""
            (cd /app && git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null) | sort -u | while IFS= read -r f; do echo "  - $f"; done
            echo ""
            echo "## Scope Constraints — MANDATORY"
            echo ""
            echo "- Fix ONLY the issues listed in the review above."
            echo "- Do NOT modify any file that is not in scope for the original task."
            echo "- Do NOT modify tests to make them pass — fix the production code instead."
            echo "- Do NOT loosen test assertions, skip test cases, or weaken error checks."
            echo "- If you determine that the review cannot be satisfied without modifying"
            echo "  out-of-scope files, output exactly:"
            echo "    STOP_AND_ASK: <one-sentence reason naming the out-of-scope file>"
            echo "  on its own line, then stop immediately. Do not make any further changes."
          } > "$local_fix_prompt"

          run_claude "$local_fix_prompt" /tmp/claude-raw.log /tmp/claude-task.log execution "$TOTAL_REVIEW_ITERATIONS" "${MODEL_ARGS[@]}"
          fix_exit=$?
          echo "execution_finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/claude-phase-timing.txt
          rm -f "$local_fix_prompt"

          if check_for_stop_and_ask /tmp/claude-task.log; then
            log_loop "STOP_AND_ASK detected after review feedback — halting, needs human intervention"
            TASK_NEEDS_HUMAN=1
            TASK_FAILED=1
            break
          fi

          if [ $fix_exit -ne 0 ]; then
            log_loop "Execution agent fix pass failed (exit $fix_exit)"
            TASK_FAILED=1
            break
          fi
        fi
      done

      # If inner loop exited because global review cap was hit (while condition false),
      # REVIEW_PASSED remains 0 — catch it here before proceeding to verify.
      if [ $TASK_FAILED -eq 0 ] && [ $REVIEW_PASSED -eq 0 ]; then
        log_loop "Global review cap ($MAX_TOTAL_REVIEW_ITERATIONS total) reached without a passing review. Needs human intervention."
        TASK_FAILED=1
      fi

      if [ $TASK_FAILED -eq 1 ]; then
        break
      fi

      # ── Verify step ─────────────────────────────────────────────────

      log_loop "Review passed, running verification..."

      echo "verify_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/claude-phase-timing.txt
      run_verify
      verify_result=$?
      echo "verify_finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/claude-phase-timing.txt

      # Save numbered verify output
      VERIFY_INDEX=$((TOTAL_VERIFY_RETRIES + 1))
      cp /tmp/claude-verify.log "/tmp/claude-verify-output-${VERIFY_INDEX}.txt" 2>/dev/null

      if [ $verify_result -eq 0 ]; then
        log_loop "Verification PASSED"
        log_loop "Task complete after $TOTAL_REVIEW_ITERATIONS review iteration(s), $TOTAL_VERIFY_RETRIES verify retry/retries"
        TASK_DONE=1
      elif [ $verify_result -eq 2 ]; then
        # Infrastructure error — not caused by the code changes, don't retry
        log_loop "Verification hit an infrastructure error (not a code issue). Halting — needs human intervention."
        log_loop "All tests passed but the process failed due to environment issues (e.g. permission denied)."
        log_loop "This is NOT a failure in the code changes. Do not retry."
        VERIFY_FAIL_FINGERPRINT=$(grep -m1 -E 'command not found|: not found|executable file not found|EACCES|permission denied|Uncaught Exception|Unhandled Error' /tmp/claude-verify.log 2>/dev/null | head -c 200 || true)
        log_loop "Failure fingerprint: ${VERIFY_FAIL_FINGERPRINT}"
        printf 'VERIFY_FAIL_FINGERPRINT: %s\n' "${VERIFY_FAIL_FINGERPRINT}" > /tmp/claude-verify-environmental.txt
        VERIFY_BLOCKED_ENVIRONMENTAL=1
        TASK_FAILED=1
        break
      else
        TOTAL_VERIFY_RETRIES=$((TOTAL_VERIFY_RETRIES + 1))
        # Update verify retries file for live monitoring
        echo "${TOTAL_VERIFY_RETRIES}" > /tmp/claude-task.verify-retries
        log_loop "Verify FAILED, outer iteration $OUTER_ITERATION/$MAX_OUTER_ITERATIONS"

        # Capture first notable error line for diagnostics (best-effort)
        VERIFY_FAIL_FINGERPRINT=$(grep -m1 -E 'Error|error|FAIL|fail|not found|command not found' /tmp/claude-verify.log 2>/dev/null | head -c 200 || true)

        if [ $TOTAL_VERIFY_RETRIES -ge $MAX_VERIFY_RETRIES ]; then
          log_loop "Verify has failed $TOTAL_VERIFY_RETRIES time(s). Likely environmental or unresolvable. Halting — needs human intervention."
          log_loop "Failure fingerprint: ${VERIFY_FAIL_FINGERPRINT}"
          printf 'VERIFY_FAIL_FINGERPRINT: %s\n' "${VERIFY_FAIL_FINGERPRINT}" > /tmp/claude-verify-environmental.txt
          VERIFY_BLOCKED_ENVIRONMENTAL=1
          TASK_FAILED=1
          break
        fi

        if [ $OUTER_ITERATION -ge $MAX_OUTER_ITERATIONS ]; then
          log_loop "Outer loop exhausted ($MAX_OUTER_ITERATIONS iterations). Needs human intervention."
          TASK_FAILED=1
          break
        fi

        # Feed verify errors back to execution agent for next outer iteration
        log_loop "Sending verify failure to execution agent..."
        echo "execution_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/claude-phase-timing.txt
        local_verify_fix="/tmp/claude-verify-fix-prompt.txt"
        {
          echo "Your code changes passed review but failed verification. Please fix the following errors:"
          echo ""
          cat /tmp/claude-verify.log
          echo ""
          echo "## Original Task (verbatim — defines your scope)"
          echo ""
          echo "$ORIGINAL_PROMPT"
          echo ""
          echo "## Files Already Modified"
          echo ""
          echo "The following files have already been changed in this task (these are the"
          echo "in-scope files you should be working within — do not touch files outside"
          echo "this list unless they are clearly in scope for the task):"
          echo ""
          (cd /app && git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null) | sort -u | while IFS= read -r f; do echo "  - $f"; done
          echo ""
          echo "## Scope Constraints — MANDATORY"
          echo ""
          echo "- Fix ONLY the verification failures listed above."
          echo "- Do NOT modify any file that is not in scope for the original task."
          echo "- Do NOT modify tests to make them pass — fix the production code instead."
          echo "- Do NOT loosen test assertions, skip test cases, or weaken error checks."
          echo "- If you determine that verify cannot pass without modifying out-of-scope"
          echo "  files or tests, output exactly:"
          echo "    STOP_AND_ASK: <one-sentence reason naming the out-of-scope file>"
          echo "  on its own line, then stop immediately. Do not make any further changes."
        } > "$local_verify_fix"

        run_claude "$local_verify_fix" /tmp/claude-raw.log /tmp/claude-task.log execution "$((TOTAL_REVIEW_ITERATIONS + 1))" "${MODEL_ARGS[@]}"
        verify_fix_exit=$?
        echo "execution_finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /tmp/claude-phase-timing.txt
        rm -f "$local_verify_fix"

        if check_for_stop_and_ask /tmp/claude-task.log; then
          log_loop "STOP_AND_ASK detected after verify failure — halting, needs human intervention"
          TASK_NEEDS_HUMAN=1
          TASK_FAILED=1
          break
        fi

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
    # NOTE: Do NOT delete numbered verdict/verify/summary/timing files —
    # they are read by the task-watcher for persistent metadata archival.

    # Write loop iteration counts for the task watcher to read
    echo "${TOTAL_REVIEW_ITERATIONS}" > /tmp/claude-task.review-iterations
    echo "${TOTAL_VERIFY_RETRIES}" > /tmp/claude-task.verify-retries

    if [ $TASK_DONE -eq 1 ]; then
      echo 0 > /tmp/claude-task.exit
      echo "completed" > /tmp/claude-task.status
      EXIT_CODE=0
    elif [ $TASK_NEEDS_HUMAN -eq 1 ]; then
      echo 1 > /tmp/claude-task.exit
      echo "needs_human" > /tmp/claude-task.status
      EXIT_CODE=1
    elif [ $VERIFY_BLOCKED_ENVIRONMENTAL -eq 1 ]; then
      echo 1 > /tmp/claude-task.exit
      echo "verify_blocked_environmental" > /tmp/claude-task.status
      EXIT_CODE=1
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
    elif [ $TASK_NEEDS_HUMAN -eq 1 ]; then
      echo "  STATUS: NEEDS HUMAN INTERVENTION (STOP_AND_ASK)"
      echo "  Reason: $(cat /tmp/claude-stop-reason.txt 2>/dev/null)"
      echo "  Review iterations: $TOTAL_REVIEW_ITERATIONS"
      echo "  Verify retries: $TOTAL_VERIFY_RETRIES"
    elif [ $VERIFY_BLOCKED_ENVIRONMENTAL -eq 1 ]; then
      echo "  STATUS: VERIFY BLOCKED — ENVIRONMENTAL FAILURE"
      echo "  Fingerprint: $(cat /tmp/claude-verify-environmental.txt 2>/dev/null || echo '(none captured)')"
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
