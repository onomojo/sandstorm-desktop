import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

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

    it('generates a diff for the review agent', () => {
      // The review function should capture git diff for the review prompt
      expect(taskRunner).toContain('git diff HEAD')
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

    it('runs npm test', () => {
      expect(taskRunner).toContain('npm test')
    })

    it('runs tsc --noEmit', () => {
      expect(taskRunner).toContain('tsc --noEmit')
    })

    it('runs npm run build', () => {
      expect(taskRunner).toContain('npm run build')
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
  })

  // ── Loop state logging ───────────────────────────────────────────────

  describe('loop state logging', () => {
    it('uses [LOOP] prefix for all loop messages', () => {
      expect(taskRunner).toContain('log_loop()')
      expect(taskRunner).toContain('[LOOP]')
    })

    it('logs execution pass completion', () => {
      expect(taskRunner).toContain('Execution pass 1 complete')
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

    it('writes raw log for token parsing', () => {
      expect(taskRunner).toContain('tee /tmp/claude-raw.log')
    })

    it('writes task log for UI', () => {
      expect(taskRunner).toContain('tee /tmp/claude-task.log')
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

  it('covers all review categories', () => {
    const categories = [
      'Architecture',
      'Best practices',
      'Separation of concerns',
      'DRY',
      'Security',
      'Scalability',
      'Test coverage',
    ]
    for (const cat of categories) {
      expect(reviewPrompt.toLowerCase()).toContain(cat.toLowerCase())
    }
  })

  it('includes issue category tags for structured output', () => {
    const tags = ['ARCHITECTURE', 'BEST_PRACTICE', 'SECURITY', 'TEST_COVERAGE', 'BUG']
    for (const tag of tags) {
      expect(reviewPrompt).toContain(tag)
    }
  })

  it('instructs the review agent to be pragmatic', () => {
    expect(reviewPrompt.toLowerCase()).toContain('pragmatic')
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

  it('explains verification steps', () => {
    expect(innerMd).toContain('npm test')
    expect(innerMd).toContain('tsc --noEmit')
    expect(innerMd).toContain('npm run build')
  })

  it('notes the review agent has no prior context', () => {
    expect(innerMd).toContain('NO context from your session')
  })
})

describe('Dockerfile includes review-prompt.md', () => {
  const dockerfilePath = resolve(__dirname, '../../sandstorm-cli/docker/Dockerfile')
  const dockerfile = readFileSync(dockerfilePath, 'utf-8')

  it('copies review-prompt.md into the image', () => {
    expect(dockerfile).toContain('COPY docker/review-prompt.md /usr/bin/review-prompt.md')
  })
})
