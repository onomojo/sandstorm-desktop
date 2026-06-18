import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { spawnSync } from 'child_process'

const taskRunnerPath = resolve(__dirname, '../../sandstorm-cli/docker/task-runner.sh')
const taskRunner = readFileSync(taskRunnerPath, 'utf-8')

describe('task-runner.sh environmental verify scope classification', () => {
  // ── Helper functions ────────────────────────────────────────────────────

  describe('helper functions', () => {
    it('defines _get_task_changed_files', () => {
      expect(taskRunner).toContain('_get_task_changed_files()')
    })

    it('defines classify_verify_failure_scope', () => {
      expect(taskRunner).toContain('classify_verify_failure_scope()')
    })

    it('classify_verify_failure_scope uses _get_task_changed_files', () => {
      expect(taskRunner).toContain('changed_files=$(_get_task_changed_files)')
    })

    it('parses TypeScript error lines of the form path(line,col): error TSxxxx', () => {
      expect(taskRunner).toContain('error TS[0-9]+')
    })

    it('returns 1 when no parseable paths are found', () => {
      expect(taskRunner).toContain('No parseable paths')
    })

    it('returns 0 when all failing files are outside changed set', () => {
      expect(taskRunner).toContain('All failing files are outside the changed set')
    })
  })

  // ── Integration into verify-fail path ───────────────────────────────────

  describe('verify-fail path integration', () => {
    it('calls classify_verify_failure_scope after a verify failure', () => {
      expect(taskRunner).toContain('classify_verify_failure_scope /tmp/claude-verify.log')
    })

    it('sets VERIFY_BLOCKED_ENVIRONMENTAL=1 when scope check fires', () => {
      const classifyIdx = taskRunner.indexOf('classify_verify_failure_scope /tmp/claude-verify.log')
      expect(classifyIdx).toBeGreaterThan(-1)

      const blockAfter = taskRunner.slice(classifyIdx, classifyIdx + 500)
      expect(blockAfter).toContain('VERIFY_BLOCKED_ENVIRONMENTAL=1')
    })

    it('does NOT set TASK_NEEDS_HUMAN when environmental check fires', () => {
      // Find the classify_verify_failure_scope block and confirm TASK_NEEDS_HUMAN=1
      // does not appear in the consequent branch.
      const classifyIdx = taskRunner.indexOf('classify_verify_failure_scope /tmp/claude-verify.log')
      expect(classifyIdx).toBeGreaterThan(-1)

      // Extract until the next 'fi' that closes the if block
      const blockAfter = taskRunner.slice(classifyIdx, classifyIdx + 500)
      const fiIdx = blockAfter.indexOf('\n        fi\n')
      expect(fiIdx).toBeGreaterThan(-1)

      const consequentBlock = blockAfter.slice(0, fiIdx)
      expect(consequentBlock).not.toContain('TASK_NEEDS_HUMAN=1')
    })

    it('logs an "outside this task\'s changed-file set" message for environmental failures', () => {
      expect(taskRunner).toContain("outside this task's changed-file set")
    })

    it('environmental check runs before feeding verify failure to execution agent', () => {
      const classifyIdx = taskRunner.indexOf('classify_verify_failure_scope /tmp/claude-verify.log')
      const feedIdx = taskRunner.indexOf('Sending verify failure to execution agent')
      expect(classifyIdx).toBeGreaterThan(-1)
      expect(feedIdx).toBeGreaterThan(-1)
      expect(classifyIdx).toBeLessThan(feedIdx)
    })

    it('environmental check runs before STOP_AND_ASK check in verify path', () => {
      const classifyIdx = taskRunner.indexOf('classify_verify_failure_scope /tmp/claude-verify.log')
      const stopAskIdx = taskRunner.indexOf(
        'STOP_AND_ASK detected after verify failure',
      )
      expect(classifyIdx).toBeGreaterThan(-1)
      expect(stopAskIdx).toBeGreaterThan(-1)
      expect(classifyIdx).toBeLessThan(stopAskIdx)
    })
  })

  // ── Smoke test (bash) ────────────────────────────────────────────────────

  describe('smoke test', () => {
    it('runs task-runner-environmental-scope.sh and all cases pass', () => {
      const smokeScript = resolve(__dirname, 'task-runner-environmental-scope.sh')
      expect(existsSync(smokeScript)).toBe(true)

      const result = spawnSync('bash', [smokeScript], {
        encoding: 'utf-8',
        timeout: 30_000,
      })
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
      expect(result.status).toBe(0)
    })
  })
})
