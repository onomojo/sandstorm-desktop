import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { spawnSync } from 'child_process'

const taskRunnerPath = resolve(__dirname, '../../sandstorm-cli/docker/task-runner.sh')
const taskRunner = readFileSync(taskRunnerPath, 'utf-8')

describe('task-runner.sh token limit detection', () => {
  describe('check_for_token_limit function', () => {
    it('defines check_for_token_limit function', () => {
      expect(taskRunner).toContain('check_for_token_limit()')
    })

    it('scans the given log file, defaulting to /tmp/claude-raw.log', () => {
      expect(taskRunner).toContain('local log_file="${1:-/tmp/claude-raw.log}"')
    })

    it('uses jq structured detection for JSON lines', () => {
      expect(taskRunner).toContain('jq -c')
      expect(taskRunner).toContain('rate_limit_event')
      expect(taskRunner).toContain('rate_limit_info.status == "rejected"')
      expect(taskRunner).toContain('is_error == true')
      expect(taskRunner).toContain('api_error_status == 429')
    })

    it('uses plain-text fallback for non-JSON lines', () => {
      expect(taskRunner).toContain('grep -qi "You\'ve hit your session limit"')
    })

    it('returns 0 on detection (success), 1 otherwise', () => {
      expect(taskRunner).toContain('return 0')
      expect(taskRunner).toContain('return 1')
    })

    it('uses printf hex escape for open-brace to avoid literal in source', () => {
      expect(taskRunner).toContain("printf '\\x7b'")
    })

    it('checks JSON lines first (structured detection) before plain-text fallback', () => {
      const fnStart = taskRunner.indexOf('check_for_token_limit()')
      const fnEnd = taskRunner.indexOf('return 1\n}', fnStart)
      const fnBody = taskRunner.slice(fnStart, fnEnd)
      const jqIdx = fnBody.indexOf('jq -c')
      const plaintextIdx = fnBody.indexOf('grep -qi "You\'ve hit your session limit"')
      expect(jqIdx).toBeGreaterThan(-1)
      expect(plaintextIdx).toBeGreaterThan(-1)
      expect(jqIdx).toBeLessThan(plaintextIdx)
    })
  })

  describe('token_limited status token', () => {
    it('writes token_limited to /tmp/claude-task.status', () => {
      expect(taskRunner).toContain('echo "token_limited" > /tmp/claude-task.status')
    })

    it('initializes TASK_TOKEN_LIMITED=0 in dual-loop variables', () => {
      expect(taskRunner).toContain('TASK_TOKEN_LIMITED=0')
    })

    it('sets TASK_TOKEN_LIMITED=1 when token limit is detected', () => {
      expect(taskRunner).toContain('TASK_TOKEN_LIMITED=1')
    })
  })

  describe('detection call sites', () => {
    it('checks for token limit during initial execution failure', () => {
      expect(taskRunner).toContain('check_for_token_limit /tmp/claude-raw.log')
    })

    it('checks for token limit after review agent fails (review raw log)', () => {
      expect(taskRunner).toContain('check_for_token_limit /tmp/claude-review-raw.log')
    })

    it('checks for token limit after meta-review fails (meta-review raw log)', () => {
      expect(taskRunner).toContain('check_for_token_limit /tmp/claude-meta-review-raw.log')
    })

    it('token limit check comes before failed/needs_human classification in final status', () => {
      const tokenLimitedIdx = taskRunner.indexOf('TASK_TOKEN_LIMITED -eq 1')
      const needsHumanIdx = taskRunner.indexOf('TASK_NEEDS_HUMAN -eq 1')
      const verifyBlockedIdx = taskRunner.indexOf('VERIFY_BLOCKED_ENVIRONMENTAL -eq 1')
      expect(tokenLimitedIdx).toBeGreaterThan(-1)
      expect(tokenLimitedIdx).toBeLessThan(needsHumanIdx)
      expect(tokenLimitedIdx).toBeLessThan(verifyBlockedIdx)
    })

    it('token limit check in initial execution path comes before echo failed', () => {
      const tokenLimitCheck = taskRunner.indexOf('check_for_token_limit /tmp/claude-raw.log')
      const echoFailed = taskRunner.indexOf('echo "failed" > /tmp/claude-task.status')
      expect(tokenLimitCheck).toBeGreaterThan(-1)
      expect(tokenLimitCheck).toBeLessThan(echoFailed)
    })
  })

  describe('precedence', () => {
    it('check_for_token_limit is defined before run_claude (structurally correct)', () => {
      const tokenLimitFnIdx = taskRunner.indexOf('check_for_token_limit()')
      const runClaudeIdx = taskRunner.indexOf('run_claude()')
      expect(tokenLimitFnIdx).toBeLessThan(runClaudeIdx)
    })

    it('token limit check appears before check_for_stop_and_ask in local-fix path', () => {
      // Find the local-fix section — verify fix-exit + token limit appears before STOP_AND_ASK
      const fixSection = taskRunner.slice(taskRunner.indexOf('fix_exit=$?'))
      const tokenLimitCheckInFix = fixSection.indexOf('check_for_token_limit /tmp/claude-raw.log')
      const stopAndAskInFix = fixSection.indexOf('check_for_stop_and_ask /tmp/claude-task.log')
      expect(tokenLimitCheckInFix).toBeGreaterThan(-1)
      expect(stopAndAskInFix).toBeGreaterThan(-1)
      expect(tokenLimitCheckInFix).toBeLessThan(stopAndAskInFix)
    })

    it('includes SESSION TOKEN LIMIT in the summary output', () => {
      expect(taskRunner).toContain('SESSION TOKEN LIMIT')
    })
  })

  describe('exit-code gate removal', () => {
    it('initial execution: token limit check precedes the exit-code failure block', () => {
      // The unconditional check must come before the standalone failure-path
      // "if [ $EXIT_CODE -ne 0 ]; then" (not the resume-fallback compound which
      // also tests EXIT_CODE but with an additional && guard).
      const execStart = taskRunner.indexOf('Starting initial execution pass')
      const stopAskMarker = taskRunner.indexOf('Execution pass 1 complete, checking for STOP_AND_ASK')
      const section = taskRunner.slice(execStart, stopAskMarker)
      const tokenLimitIdx = section.indexOf('check_for_token_limit /tmp/claude-raw.log')
      // Search for the standalone failure block (not the resume-fallback compound condition)
      const exitCodeIdx = section.indexOf('if [ $EXIT_CODE -ne 0 ]; then')
      expect(tokenLimitIdx).toBeGreaterThan(-1)
      expect(exitCodeIdx).toBeGreaterThan(-1)
      expect(tokenLimitIdx).toBeLessThan(exitCodeIdx)
    })

    it('review-feedback fix pass: token limit check not gated on fix_exit being non-zero', () => {
      // Old guard was: "if [ $fix_exit -ne 0 ] && check_for_token_limit"
      expect(taskRunner).not.toContain('fix_exit -ne 0 ] && check_for_token_limit')
    })

    it('verify fix pass: token limit check not gated on verify_fix_exit being non-zero', () => {
      // Old guard was: "if [ $verify_fix_exit -ne 0 ] && check_for_token_limit"
      expect(taskRunner).not.toContain('verify_fix_exit -ne 0 ] && check_for_token_limit')
    })

    it('review PASS branch also checks review raw log for token limit', () => {
      // A token-limited review that emits REVIEW_PASS must still be caught.
      // Verify both REVIEW_PASS-branch and REVIEW_FAIL-branch contain the check.
      const reviewPassSection = taskRunner.slice(
        taskRunner.indexOf('Save numbered review verdict'),
        taskRunner.indexOf('REVIEW_PASSED=1'),
      )
      expect(reviewPassSection).toContain('check_for_token_limit /tmp/claude-review-raw.log')
    })
  })
})

// ---------------------------------------------------------------------------
// Behavioral smoke test (bash-level) — sources check_for_token_limit from
// task-runner.sh and exercises it with synthetic logs.
// ---------------------------------------------------------------------------

const smokeSh = resolve(__dirname, 'task-runner-token-limit-smoke.sh')
const hasBash = spawnSync('which', ['bash'], { encoding: 'utf-8' }).status === 0

describe.skipIf(!hasBash || !existsSync(smokeSh))(
  'token limit behavioral smoke test (bash-level)',
  () => {
    it(
      'detects plain-text limit lines and ignores JSON-embedded ones',
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
