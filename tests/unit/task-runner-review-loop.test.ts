import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { spawnSync } from 'child_process'

/**
 * Tests for the dual-loop review workflow in task-runner.sh.
 *
 * These tests verify the script's structure, loop constants, and key
 * behavioral patterns by inspecting the script content. Integration
 * testing of the actual loop execution happens in the Docker environment.
 */

const taskRunnerPath = resolve(__dirname, '../../sandstorm-cli/docker/task-runner.sh')
const taskRunner = readFileSync(taskRunnerPath, 'utf-8')
const lines = taskRunner.split('\n')

describe('task-runner.sh dual-loop workflow', () => {
  // ── Loop constants ───────────────────────────────────────────────────

  describe('loop constants', () => {
    it('defines MAX_INNER_ITERATIONS=5', () => {
      expect(taskRunner).toContain('MAX_INNER_ITERATIONS=5')
    })

    it('defines MAX_OUTER_ITERATIONS=5', () => {
      expect(taskRunner).toContain('MAX_OUTER_ITERATIONS=5')
    })
  })

  // ── Diff detection ───────────────────────────────────────────────────

  describe('diff detection', () => {
    it('has a check_for_diff function', () => {
      expect(taskRunner).toContain('check_for_diff()')
    })

    it('uses git diff to detect changes', () => {
      expect(taskRunner).toContain('git diff --stat HEAD')
    })

    it('checks for untracked files', () => {
      expect(taskRunner).toContain('git ls-files --others --exclude-standard')
    })

    it('skips the review loop when no diff is detected', () => {
      expect(taskRunner).toContain('No code changes detected, task complete (single-pass)')
    })

    it('enters the review loop when changes are detected', () => {
      expect(taskRunner).toContain('Code changes detected, entering review loop')
    })
  })

  // ── Review agent ─────────────────────────────────────────────────────

  describe('review agent', () => {
    it('has a run_review function', () => {
      expect(taskRunner).toContain('run_review()')
    })

    it('does not embed a diff in the review agent prompt', () => {
      // The review agent discovers changes itself via git tools — no diff is embedded
      expect(taskRunner).not.toContain('cat /tmp/claude-review-diff.txt')
      expect(taskRunner).not.toContain('Current Diff (staged + unstaged)')
    })

    it('uses the review-prompt.md template', () => {
      expect(taskRunner).toContain('review-prompt.md')
    })

    it('passes original task description to the review agent', () => {
      expect(taskRunner).toContain('Original Task')
    })

    it('parses REVIEW_PASS verdict', () => {
      expect(taskRunner).toContain('REVIEW_PASS')
    })

    it('parses REVIEW_FAIL verdict', () => {
      expect(taskRunner).toContain('REVIEW_FAIL')
    })

    it('treats unclear review output as failure', () => {
      expect(taskRunner).toContain('UNCLEAR (no REVIEW_PASS/REVIEW_FAIL found), treating as FAIL')
    })

    it('treats review agent crash as failure', () => {
      expect(taskRunner).toContain('Review agent crashed')
    })
  })

  // ── Verify step ──────────────────────────────────────────────────────

  describe('verify step', () => {
    it('has a run_verify function', () => {
      expect(taskRunner).toContain('run_verify()')
    })

    it('uses .sandstorm/verify.sh script', () => {
      expect(taskRunner).toContain('.sandstorm/verify.sh')
    })

    it('skips verification when no verify.sh exists', () => {
      expect(taskRunner).toContain('No .sandstorm/verify.sh found')
    })

    it('runs the verify script with bash', () => {
      expect(taskRunner).toContain('bash "$verify_script"')
    })
  })

  // ── Verify exit code handling ────────────────────────────────────────

  describe('verify PIPESTATUS handling', () => {
    it('uses PIPESTATUS to capture real exit codes from tee pipelines', () => {
      // run_claude has one, plus 1 in run_verify = at least 2
      const matches = taskRunner.match(/PIPESTATUS\[0\]/g)
      expect(matches).not.toBeNull()
      expect(matches!.length).toBeGreaterThanOrEqual(2)
    })
  })

  // ── Review log isolation ───────────────────────────────────────────

  describe('review log isolation', () => {
    it('uses separate raw log for review agent', () => {
      expect(taskRunner).toContain('/tmp/claude-review-raw.log')
    })

    it('uses separate task log for review agent', () => {
      expect(taskRunner).toContain('/tmp/claude-review-task.log')
    })

    it('parses verdict from review-specific task log', () => {
      expect(taskRunner).toContain('tail -10 /tmp/claude-review-task.log')
    })

    it('cleans up review log files', () => {
      expect(taskRunner).toContain('rm -f /tmp/claude-review-raw.log')
      expect(taskRunner).toContain('rm -f /tmp/claude-review-task.log')
    })
  })

  // ── Diff handling ──────────────────────────────────────────────────

  describe('review diff handling', () => {
    it('does NOT create a temp diff file', () => {
      expect(taskRunner).not.toContain('> /tmp/claude-review-diff.txt')
    })

    it('does NOT create a temp untracked diff file', () => {
      expect(taskRunner).not.toContain('> /tmp/claude-review-untracked.txt')
    })

    it('does NOT embed diff content in the review prompt', () => {
      expect(taskRunner).not.toContain('cat /tmp/claude-review-diff.txt')
      expect(taskRunner).not.toContain('Current Diff (staged + unstaged)')
    })

    it('assembles review prompt from template and original task only', () => {
      // The comment in the script documents this constraint
      expect(taskRunner).toContain('no diff content')
    })
  })

  // ── Inner loop (execution ↔ review) ──────────────────────────────────

  describe('inner loop', () => {
    it('iterates up to MAX_INNER_ITERATIONS', () => {
      expect(taskRunner).toContain('INNER_ITERATION -lt $MAX_INNER_ITERATIONS')
    })

    it('sends review feedback back to execution agent on failure', () => {
      expect(taskRunner).toContain('Sending review feedback to execution agent')
    })

    it('includes the review report in the fix prompt', () => {
      expect(taskRunner).toContain('Your code changes were reviewed and issues were found')
    })

    it('halts when inner loop is exhausted', () => {
      expect(taskRunner).toContain('Inner loop exhausted')
      expect(taskRunner).toContain('Needs human intervention')
    })

    it('does NOT call run_verify inside the inner review loop', () => {
      // The inner loop runs between the REVIEW_PASSED=0 init and the "done" that closes it.
      // Verify must NOT appear inside that block — it should only run after the inner loop exits.
      const innerLoopStart = taskRunner.indexOf('REVIEW_PASSED=0')
      const innerLoopCondition = taskRunner.indexOf('INNER_ITERATION -lt $MAX_INNER_ITERATIONS', innerLoopStart)
      // Find the "done" that closes the inner while loop (first "done" after the inner loop start)
      const afterInnerLoop = taskRunner.indexOf('\n      done', innerLoopCondition)
      expect(afterInnerLoop).toBeGreaterThan(innerLoopStart)

      // Extract the inner loop body and verify run_verify is NOT in it
      const innerLoopBody = taskRunner.substring(innerLoopStart, afterInnerLoop)
      expect(innerLoopBody).not.toContain('run_verify')
    })
  })

  // ── Verify runs ONCE after review passes (not per review iteration) ───

  describe('verify runs once after review passes', () => {
    it('run_verify is called after the inner loop done keyword', () => {
      // The inner loop ends with "done", then verify runs
      const innerLoopDone = taskRunner.indexOf('REVIEW_PASSED=0')
      const doneAfterInner = taskRunner.indexOf('\n      done', innerLoopDone)
      const verifyCall = taskRunner.indexOf('run_verify', doneAfterInner)
      expect(verifyCall).toBeGreaterThan(doneAfterInner)
    })

    it('documents that verify runs once, not per review iteration', () => {
      expect(taskRunner).toContain('runs ONCE after review passes, not on every review iteration')
    })
  })

  // ── Outer loop (verify retries) ──────────────────────────────────────

  describe('outer loop', () => {
    it('iterates up to MAX_OUTER_ITERATIONS', () => {
      expect(taskRunner).toContain('OUTER_ITERATION -lt $MAX_OUTER_ITERATIONS')
    })

    it('sends verify failures back to execution agent', () => {
      expect(taskRunner).toContain('Sending verify failure to execution agent')
    })

    it('includes verify error output in the fix prompt', () => {
      expect(taskRunner).toContain('passed review but failed verification')
    })

    it('halts when outer loop is exhausted', () => {
      expect(taskRunner).toContain('Outer loop exhausted')
    })

    it('re-enters review loop after verify failure and fix', () => {
      // After verify fails and execution agent fixes, the outer loop continues,
      // which resets the inner loop counter and re-runs review before verify again
      // This ensures: fix → review → verify (not just fix → verify)
      const verifyFail = taskRunner.indexOf('Verify FAILED')
      const sendVerifyFix = taskRunner.indexOf('Sending verify failure to execution agent', verifyFail)
      expect(sendVerifyFix).toBeGreaterThan(verifyFail)
      // The outer while loop continues, which re-enters the inner review loop
      expect(taskRunner).toContain('INNER_ITERATION=0')
    })
  })

  // ── Loop state logging ───────────────────────────────────────────────

  describe('loop state logging', () => {
    it('uses [LOOP] prefix for all loop messages', () => {
      expect(taskRunner).toContain('log_loop()')
      expect(taskRunner).toContain('[LOOP]')
    })

    it('logs initial execution start', () => {
      expect(taskRunner).toContain('Starting initial execution pass')
    })

    it('logs review iterations with counts', () => {
      expect(taskRunner).toContain('Review iteration $INNER_ITERATION/$MAX_INNER_ITERATIONS')
    })

    it('logs review pass', () => {
      expect(taskRunner).toContain('Review passed at inner iteration')
    })

    it('logs verification start', () => {
      expect(taskRunner).toContain('Review passed, running verification')
    })

    it('logs verification result', () => {
      expect(taskRunner).toContain('Verification PASSED')
      expect(taskRunner).toContain('Verify FAILED')
    })

    it('logs final task summary with iteration counts', () => {
      expect(taskRunner).toContain('Review iterations: $TOTAL_REVIEW_ITERATIONS')
      expect(taskRunner).toContain('Verify retries: $TOTAL_VERIFY_RETRIES')
    })

    it('writes review iteration count to file for task watcher', () => {
      expect(taskRunner).toContain('> /tmp/claude-task.review-iterations')
    })

    it('writes verify retry count to file for task watcher', () => {
      expect(taskRunner).toContain('> /tmp/claude-task.verify-retries')
    })
  })

  // ── Single-pass tasks ────────────────────────────────────────────────

  describe('single-pass tasks', () => {
    it('completes immediately when no code changes exist', () => {
      // After check_for_diff returns false, should set completed status
      const singlePassSection = taskRunner.indexOf('No code changes detected')
      const completedAfter = taskRunner.indexOf('"completed" > /tmp/claude-task.status', singlePassSection)
      expect(singlePassSection).toBeGreaterThan(-1)
      expect(completedAfter).toBeGreaterThan(singlePassSection)
    })

    it('does not enter the review loop for no-diff tasks', () => {
      // The "entering review loop" message should only appear after diff check passes
      const noDiffMessage = taskRunner.indexOf('No code changes detected')
      const continueAfterNoDiff = taskRunner.indexOf('continue', noDiffMessage)
      const enteringLoopMessage = taskRunner.indexOf('entering review loop')
      // The "continue" (which skips the loop) must come before "entering review loop"
      expect(continueAfterNoDiff).toBeGreaterThan(-1)
      expect(continueAfterNoDiff).toBeLessThan(enteringLoopMessage)
    })
  })

  // ── Claude invocation ────────────────────────────────────────────────

  describe('claude invocation', () => {
    it('has a reusable run_claude function', () => {
      expect(taskRunner).toContain('run_claude()')
    })

    it('preserves the streaming JSON output pipeline', () => {
      expect(taskRunner).toContain('--output-format stream-json')
      expect(taskRunner).toContain('--include-partial-messages')
    })

    it('preserves model argument passthrough', () => {
      expect(taskRunner).toContain('MODEL_ARGS')
    })

    it('accepts configurable log file paths', () => {
      expect(taskRunner).toContain('local raw_log="${2:-/tmp/claude-raw.log}"')
      expect(taskRunner).toContain('local task_log="${3:-/tmp/claude-task.log}"')
    })

    it('passes --mcp-config pointing to /tmp/sandstorm-mcp.json', () => {
      expect(taskRunner).toContain('--mcp-config /tmp/sandstorm-mcp.json')
    })

    it('passes --strict-mcp-config to prevent loading workspace .mcp.json', () => {
      expect(taskRunner).toContain('--strict-mcp-config')
    })

    it('writes raw log for token parsing (append mode)', () => {
      expect(taskRunner).toContain('tee -a "$raw_log"')
    })

    it('truncates raw log at task start so tokens are fresh per task', () => {
      expect(taskRunner).toContain('> /tmp/claude-raw.log')
    })

    it('writes task log for UI', () => {
      expect(taskRunner).toContain('tee "$task_log"')
    })
  })

  // ── Status file protocol ─────────────────────────────────────────────

  describe('status file protocol', () => {
    it('writes running status at task start', () => {
      expect(taskRunner).toContain('"running" > /tmp/claude-task.status')
    })

    it('writes completed status on success', () => {
      expect(taskRunner).toContain('"completed" > /tmp/claude-task.status')
    })

    it('writes failed status on failure', () => {
      expect(taskRunner).toContain('"failed" > /tmp/claude-task.status')
    })

    it('writes exit code', () => {
      expect(taskRunner).toContain('> /tmp/claude-task.exit')
    })

    it('cleans up PID file', () => {
      expect(taskRunner).toContain('rm -f /tmp/claude-task.pid')
    })
  })

  // ── Readiness marker ─────────────────────────────────────────────────

  describe('readiness marker', () => {
    it('creates /tmp/claude-ready before entering the wait loop', () => {
      // The marker must be set before the first "sleep 1" iteration
      const markerCreate = taskRunner.indexOf('"ready" > /tmp/claude-ready')
      const waitLoop = taskRunner.indexOf('while true; do')
      expect(markerCreate).toBeGreaterThan(-1)
      expect(markerCreate).toBeLessThan(waitLoop)
    })

    it('clears the readiness marker when a task trigger is detected', () => {
      const triggerCheck = taskRunner.indexOf('if [ -f /tmp/claude-task-trigger ]')
      const markerRemove = taskRunner.indexOf('rm -f /tmp/claude-ready')
      expect(markerRemove).toBeGreaterThan(triggerCheck)
      // The removal should happen before task execution starts
      const taskStart = taskRunner.indexOf('"running" > /tmp/claude-task.status')
      expect(markerRemove).toBeLessThan(taskStart)
    })

    it('restores the readiness marker after failed initial execution', () => {
      const failedSection = taskRunner.indexOf('Initial execution failed')
      const nextWaiting = taskRunner.indexOf('Waiting for tasks...', failedSection)
      const markerRestore = taskRunner.lastIndexOf('"ready" > /tmp/claude-ready', nextWaiting)
      expect(markerRestore).toBeGreaterThan(failedSection)
      expect(markerRestore).toBeLessThan(nextWaiting)
    })

    it('restores the readiness marker after single-pass completion', () => {
      const singlePass = taskRunner.indexOf('no code changes, single-pass')
      const nextWaiting = taskRunner.indexOf('Waiting for tasks...', singlePass)
      const markerRestore = taskRunner.lastIndexOf('"ready" > /tmp/claude-ready', nextWaiting)
      expect(markerRestore).toBeGreaterThan(singlePass)
      expect(markerRestore).toBeLessThan(nextWaiting)
    })

    it('restores the readiness marker after dual-loop completion', () => {
      // After the final status section, before the last "Waiting for tasks..."
      const finalStatus = taskRunner.indexOf('# ── Final status')
      const lastWaiting = taskRunner.lastIndexOf('Waiting for tasks...')
      const markerRestore = taskRunner.lastIndexOf('"ready" > /tmp/claude-ready', lastWaiting)
      expect(markerRestore).toBeGreaterThan(finalStatus)
      expect(markerRestore).toBeLessThan(lastWaiting)
    })

    it('has at least 4 readiness marker writes (init + 3 exit paths)', () => {
      const matches = taskRunner.match(/"ready" > \/tmp\/claude-ready/g)
      expect(matches).not.toBeNull()
      expect(matches!.length).toBeGreaterThanOrEqual(4)
    })
  })

  // ── No `local` outside function scope (issue #115) ──────────────────

  describe('no local keyword outside function scope', () => {
    it('does not use `local` in the outer/inner while loops', () => {
      // Find all `local ` usages and verify they are inside function bodies.
      // Functions in the script: log_loop, run_claude, check_for_diff, run_review, run_verify, check_for_stop_and_ask
      const functionNames = ['log_loop', 'run_claude', 'check_for_diff', 'run_review', 'run_verify', 'is_infra_error_only', 'check_for_stop_and_ask']

      // Collect the line ranges of all function bodies
      const functionRanges: Array<{ start: number; end: number }> = []
      for (const fn of functionNames) {
        const fnPattern = new RegExp(`^${fn}\\(\\)\\s*\\{`, 'm')
        const match = fnPattern.exec(taskRunner)
        if (!match) continue

        const fnStart = match.index
        // Find the matching closing brace by counting braces
        let braceDepth = 0
        let foundOpen = false
        let fnEnd = fnStart
        for (let i = fnStart; i < taskRunner.length; i++) {
          if (taskRunner[i] === '{') { braceDepth++; foundOpen = true }
          if (taskRunner[i] === '}') { braceDepth-- }
          if (foundOpen && braceDepth === 0) { fnEnd = i; break }
        }
        functionRanges.push({ start: fnStart, end: fnEnd })
      }

      // Find all `local ` usages
      const localRegex = /\blocal\s+\w+/g
      let localMatch
      const violations: string[] = []
      while ((localMatch = localRegex.exec(taskRunner)) !== null) {
        const pos = localMatch.index
        const insideFunction = functionRanges.some(r => pos >= r.start && pos <= r.end)
        if (!insideFunction) {
          const lineNum = taskRunner.substring(0, pos).split('\n').length
          violations.push(`line ${lineNum}: ${localMatch[0]}`)
        }
      }

      expect(violations).toEqual([])
    })

    it('uses plain variable assignment for fix_exit in the inner loop', () => {
      // The fix_exit variable should be assigned without `local`
      expect(taskRunner).toContain('fix_exit=$?')
      expect(taskRunner).not.toMatch(/local\s+fix_exit/)
    })

    it('uses plain variable assignment for verify_fix_exit in the outer loop', () => {
      // The verify_fix_exit variable should be assigned without `local`
      expect(taskRunner).toContain('verify_fix_exit=$?')
      expect(taskRunner).not.toMatch(/local\s+verify_fix_exit/)
    })
  })

  // ── Infrastructure error detection ──────────────────────────────────

  describe('infrastructure error detection', () => {
    it('has an is_infra_error_only function', () => {
      expect(taskRunner).toContain('is_infra_error_only()')
    })

    it('checks for EACCES permission denied errors', () => {
      expect(taskRunner).toContain('EACCES: permission denied')
    })

    it('checks for Uncaught Exception errors', () => {
      expect(taskRunner).toContain('Uncaught Exception')
    })

    it('checks for Unhandled Error errors', () => {
      expect(taskRunner).toContain('Unhandled Error')
    })

    it('checks for actual test file failures before classifying as infra', () => {
      expect(taskRunner).toContain('Test Files.*failed')
    })

    it('returns exit code 2 from run_verify for infrastructure errors', () => {
      expect(taskRunner).toContain('return 2')
    })

    it('halts on infrastructure errors instead of retrying', () => {
      expect(taskRunner).toContain('infrastructure error (not a code issue)')
      expect(taskRunner).toContain('not retrying')
    })

    it('does not send infrastructure errors back to execution agent', () => {
      // When verify_result is 2, the loop should break without sending to execution agent
      // Find the infrastructure error handler and verify it breaks before the retry logic
      const infraHandler = taskRunner.indexOf('infrastructure error (not a code issue)')
      const breakAfterInfra = taskRunner.indexOf('break', infraHandler)
      const sendVerifyFailure = taskRunner.indexOf('Sending verify failure to execution agent')
      // The break must come before the retry/send-to-agent logic
      expect(breakAfterInfra).toBeGreaterThan(infraHandler)
      expect(breakAfterInfra).toBeLessThan(sendVerifyFailure)
    })
  })

  // ── Error handling ───────────────────────────────────────────────────

  describe('error handling', () => {
    it('handles initial execution failure without entering the loop', () => {
      expect(taskRunner).toContain('Initial execution failed')
      expect(taskRunner).toContain('skipping review loop')
    })

    it('handles execution agent fix pass failure', () => {
      expect(taskRunner).toContain('Execution agent fix pass failed')
    })

    it('handles execution agent verify-fix pass failure', () => {
      expect(taskRunner).toContain('Execution agent verify-fix pass failed')
    })

    it('reports NEEDS HUMAN INTERVENTION when loops exhaust', () => {
      expect(taskRunner).toContain('NEEDS HUMAN INTERVENTION')
    })
  })

  // ── STOP_AND_ASK deadlock break ──────────────────────────────────────

  describe('STOP_AND_ASK deadlock break', () => {
    it('has a check_for_stop_and_ask function', () => {
      expect(taskRunner).toContain('check_for_stop_and_ask()')
    })

    it('greps execution log for STOP_AND_ASK signal', () => {
      expect(taskRunner).toContain("grep -m1 'STOP_AND_ASK:'")
    })

    it('writes reason to /tmp/claude-stop-reason.txt', () => {
      expect(taskRunner).toContain('/tmp/claude-stop-reason.txt')
    })

    it('checks for STOP_AND_ASK after the initial execution pass', () => {
      const checkAfterInit = taskRunner.indexOf('STOP_AND_ASK detected during initial execution')
      expect(checkAfterInit).toBeGreaterThan(-1)
      // Must appear before the review loop entry
      const reviewLoopEntry = taskRunner.indexOf('Code changes detected, entering review loop')
      expect(checkAfterInit).toBeLessThan(reviewLoopEntry)
    })

    it('writes needs_human status when STOP_AND_ASK detected initially', () => {
      const stopSection = taskRunner.indexOf('STOP_AND_ASK detected during initial execution')
      const needsHumanWrite = taskRunner.indexOf('"needs_human" > /tmp/claude-task.status', stopSection)
      expect(needsHumanWrite).toBeGreaterThan(stopSection)
    })

    it('checks for STOP_AND_ASK after review-fail execution fix', () => {
      expect(taskRunner).toContain('STOP_AND_ASK detected after review feedback')
    })

    it('checks for STOP_AND_ASK after verify-fail execution fix', () => {
      expect(taskRunner).toContain('STOP_AND_ASK detected after verify failure')
    })

    it('sets TASK_NEEDS_HUMAN=1 when STOP_AND_ASK is detected in the loop', () => {
      expect(taskRunner).toContain('TASK_NEEDS_HUMAN=1')
    })

    it('writes needs_human status file in the final status block', () => {
      const finalStatus = taskRunner.indexOf('# ── Final status')
      const needsHumanBlock = taskRunner.indexOf('TASK_NEEDS_HUMAN -eq 1', finalStatus)
      expect(needsHumanBlock).toBeGreaterThan(finalStatus)
      const needsHumanStatusWrite = taskRunner.indexOf('"needs_human" > /tmp/claude-task.status', needsHumanBlock)
      expect(needsHumanStatusWrite).toBeGreaterThan(needsHumanBlock)
    })

    it('logs the STOP_AND_ASK reason in the final summary', () => {
      expect(taskRunner).toContain('STATUS: NEEDS HUMAN INTERVENTION (STOP_AND_ASK)')
    })
  })

  // ── Scope re-injection on iteration N+1 ─────────────────────────────

  describe('scope re-injection on subsequent iterations', () => {
    it('includes original task verbatim header in review-fail fix prompt', () => {
      expect(taskRunner).toContain('## Original Task (verbatim — defines your scope)')
    })

    it('includes scope constraint header in review-fail fix prompt', () => {
      expect(taskRunner).toContain('## Scope Constraints — MANDATORY')
    })

    it('forbids out-of-scope file modifications in review-fail prompt', () => {
      expect(taskRunner).toContain('Do NOT modify any file that is not in scope for the original task')
    })

    it('forbids modifying tests to make them pass in review-fail prompt', () => {
      expect(taskRunner).toContain('Do NOT modify tests to make them pass')
    })

    it('instructs STOP_AND_ASK usage in review-fail prompt', () => {
      expect(taskRunner).toContain('STOP_AND_ASK: <one-sentence reason naming the out-of-scope file>')
    })

    it('includes original task verbatim and scope constraints in verify-fail fix prompt', () => {
      // Both prompts share these strings — count occurrences to confirm both have them
      const verbatimCount = (taskRunner.match(/## Original Task \(verbatim — defines your scope\)/g) ?? []).length
      expect(verbatimCount).toBeGreaterThanOrEqual(2)
      const scopeCount = (taskRunner.match(/## Scope Constraints — MANDATORY/g) ?? []).length
      expect(scopeCount).toBeGreaterThanOrEqual(2)
    })

    it('forbids loosening test assertions in both prompts', () => {
      const matches = taskRunner.match(/Do NOT loosen test assertions/g) ?? []
      expect(matches.length).toBeGreaterThanOrEqual(2)
    })

    it('includes already-modified files listing in review-fail fix prompt', () => {
      expect(taskRunner).toContain('## Files Already Modified')
      expect(taskRunner).toContain('git diff --name-only HEAD')
    })

    it('includes already-modified files listing in verify-fail fix prompt', () => {
      // Both prompts must contain the files-already-modified section — count occurrences
      const modifiedCount = (taskRunner.match(/## Files Already Modified/g) ?? []).length
      expect(modifiedCount).toBeGreaterThanOrEqual(2)
      const diffCount = (taskRunner.match(/git diff --name-only HEAD/g) ?? []).length
      expect(diffCount).toBeGreaterThanOrEqual(2)
    })

    it('lists untracked new files alongside modified files in both prompts', () => {
      // git ls-files --others --exclude-standard picks up newly created files
      const untrackedCount = (taskRunner.match(/git ls-files --others --exclude-standard/g) ?? []).length
      // At least 2 occurrences (one per fix prompt) — the check_for_diff call also has one
      expect(untrackedCount).toBeGreaterThanOrEqual(2)
    })
  })

  // ── needs_human status file ──────────────────────────────────────────

  describe('needs_human status file', () => {
    it('writes needs_human to /tmp/claude-task.status', () => {
      expect(taskRunner).toContain('"needs_human" > /tmp/claude-task.status')
    })

    it('initializes TASK_NEEDS_HUMAN to 0 before the dual loop', () => {
      const loopStart = taskRunner.indexOf('ORIGINAL_PROMPT="$PROMPT"')
      const needsHumanInit = taskRunner.indexOf('TASK_NEEDS_HUMAN=0', loopStart)
      expect(needsHumanInit).toBeGreaterThan(loopStart)
    })
  })
})

describe('review-prompt.md template', () => {
  const reviewPromptPath = resolve(__dirname, '../../sandstorm-cli/docker/review-prompt.md')
  const reviewPrompt = readFileSync(reviewPromptPath, 'utf-8')

  it('exists and is non-empty', () => {
    expect(reviewPrompt.length).toBeGreaterThan(0)
  })

  it('specifies the REVIEW_PASS verdict format', () => {
    expect(reviewPrompt).toContain('REVIEW_PASS')
  })

  it('specifies the REVIEW_FAIL verdict format', () => {
    expect(reviewPrompt).toContain('REVIEW_FAIL')
  })

  it('covers all review categories by code name (#291/#292 strict-contract rewrite)', () => {
    // Post-rewrite, categories are referenced by their code-tag form
    // throughout — the prose-heading form ('Best practices', 'Test
    // coverage') was dropped when the output contract moved to
    // issues-only.
    const tags = [
      'SCOPE',
      'REQUIREMENTS',
      'ARCHITECTURE',
      'CORRECTNESS',
      'BUG',
      'SECURITY',
      'BEST_PRACTICE',
      'SEPARATION',
      'DRY',
      'SCALABILITY',
      'OPTIMIZATION',
      'TEST_COVERAGE',
    ]
    for (const tag of tags) {
      expect(reviewPrompt).toContain(tag)
    }
  })

  it('includes SCOPE as the first review category (checked before code quality)', () => {
    const scopeIndex = reviewPrompt.indexOf('**SCOPE**')
    const requirementsIndex = reviewPrompt.indexOf('**REQUIREMENTS**')
    expect(scopeIndex).toBeGreaterThan(-1)
    expect(scopeIndex).toBeLessThan(requirementsIndex)
  })

  it('instructs the reviewer to scan for out-of-scope sections in the task', () => {
    expect(reviewPrompt).toContain('Out of scope')
    expect(reviewPrompt).toContain('Non-goals')
  })

  it('requires out_of_scope:<path> as the issue description format', () => {
    expect(reviewPrompt).toContain('out_of_scope:<path>')
  })

  it('enforces that out-of-scope changes are ALWAYS a fail in the rules section', () => {
    expect(reviewPrompt).toContain('Out-of-scope file changes are ALWAYS a fail')
  })

  it('lists REQUIREMENTS as the first (highest-priority) review category', () => {
    const reqIndex = reviewPrompt.indexOf('REQUIREMENTS')
    const archIndex = reviewPrompt.indexOf('ARCHITECTURE')
    expect(reqIndex).toBeGreaterThan(-1)
    expect(reqIndex).toBeLessThan(archIndex)
    // The REQUIREMENTS bullet is still the one marked as the "highest-priority check"
    expect(reviewPrompt).toMatch(/REQUIREMENTS[\s\S]*?Highest-priority/i)
  })

  it('instructs the review agent not to override explicit task approaches', () => {
    expect(reviewPrompt).toContain('do NOT suggest alternatives')
  })

  it('instructs the review agent to pay attention to issue comments', () => {
    expect(reviewPrompt.toLowerCase()).toContain('comments')
    expect(reviewPrompt).toContain('Requirements evolve')
  })

  it('does NOT claim a diff was given to the agent', () => {
    expect(reviewPrompt).not.toContain('the current git diff')
  })

  it('instructs the review agent to run git status to discover changes', () => {
    expect(reviewPrompt).toContain('git status')
  })

  it('instructs the review agent to run git diff to inspect changes', () => {
    expect(reviewPrompt).toContain('git diff HEAD')
  })
})

describe('SANDSTORM_INNER.md workflow section', () => {
  const innerMdPath = resolve(__dirname, '../../sandstorm-cli/docker/SANDSTORM_INNER.md')
  const innerMd = readFileSync(innerMdPath, 'utf-8')

  it('documents the dual-loop workflow', () => {
    expect(innerMd).toContain('Dual-Loop Workflow')
  })

  it('explains that review feedback should be addressed without argument', () => {
    expect(innerMd).toContain('fix all listed issues without argument')
  })

  it('mentions that tests are required', () => {
    expect(innerMd).toContain('Write tests')
  })

  it('explains verification uses project verify script', () => {
    expect(innerMd).toContain('.sandstorm/verify.sh')
  })

  it('documents sandstorm-exec usage', () => {
    expect(innerMd).toContain('sandstorm-exec')
  })

  it('notes the review agent has no prior context', () => {
    expect(innerMd).toContain('NO context from your session')
  })

  it('documents the STOP_AND_ASK deadlock-break protocol', () => {
    expect(innerMd).toContain('STOP_AND_ASK')
  })

  it('documents scope constraints for iteration 2+ prompts', () => {
    expect(innerMd).toContain('Scope constraints on iteration 2+')
  })

  it('explains the needs_human stack status', () => {
    expect(innerMd).toContain('needs_human')
  })
})

describe('Dockerfile includes review-prompt.md', () => {
  const dockerfilePath = resolve(__dirname, '../../sandstorm-cli/docker/Dockerfile')
  const dockerfile = readFileSync(dockerfilePath, 'utf-8')

  it('copies review-prompt.md into the image', () => {
    expect(dockerfile).toContain('COPY docker/review-prompt.md /usr/bin/review-prompt.md')
  })
})

// ── Regression smoke test: out-of-scope ticket → STOP_AND_ASK → needs_human ──
//
// Exercises the bash plumbing in task-runner.sh with a synthetic ticket body
// that contains an explicit "Out of scope: tests/integration/**" declaration
// and a planted failing integration test in the simulated execution log.
// Asserts that check_for_stop_and_ask correctly detects the signal, status
// resolves to needs_human, and no tests/integration/** diff exists.

const smokeSh = resolve(__dirname, 'task-runner-scope-smoke.sh')
const hasBash = spawnSync('which', ['bash'], { encoding: 'utf-8' }).status === 0

describe.skipIf(!hasBash || !existsSync(smokeSh))(
  'scope regression smoke test (bash-level)',
  () => {
    it(
      'halts with needs_human when agent emits STOP_AND_ASK for out-of-scope file',
      () => {
        const result = spawnSync('bash', [smokeSh], {
          encoding: 'utf-8',
          timeout: 15_000,
        })
        if (result.status !== 0) {
          console.error('smoke test stdout:', result.stdout)
          console.error('smoke test stderr:', result.stderr)
        }
        expect(result.status).toBe(0)
      },
      15_000,
    )
  },
)
