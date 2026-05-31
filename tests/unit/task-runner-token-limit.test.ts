import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

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

    it('uses case-insensitive grep for the session limit string', () => {
      expect(taskRunner).toContain('grep -qi "You\'ve hit your session limit"')
    })

    it('returns 0 on detection (success), 1 otherwise', () => {
      expect(taskRunner).toContain('return 0')
      expect(taskRunner).toContain('return 1')
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
})
