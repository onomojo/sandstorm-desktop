/**
 * Regression tests for issue #705:
 *   Fix 1 — Arm the skipIf→hard-fail guard by propagating SANDSTORM_VERIFY=1
 *             through the container boundary in verify.sh and the init.sh template.
 *   Fix 2 — Decouple phase-model-helper.sh path resolution in task-runner.sh so
 *             B3 bash harnesses work on a bare host without /app mounted.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { spawnSync } from 'child_process'

const taskRunnerPath = resolve(__dirname, '../../sandstorm-cli/docker/task-runner.sh')
const taskRunner = readFileSync(taskRunnerPath, 'utf-8')

const initShPath = resolve(__dirname, '../../sandstorm-cli/lib/init.sh')
const initSh = readFileSync(initShPath, 'utf-8')

const verifySh = readFileSync(resolve(__dirname, '../../.sandstorm/verify.sh'), 'utf-8')
const contextVerifyPath = resolve(__dirname, '../../.sandstorm/context/verify.sh')

// ── Fix 1: SANDSTORM_VERIFY=1 propagation ────────────────────────────────────

describe('Fix 1: SANDSTORM_VERIFY=1 propagation through sandstorm-exec', () => {
  describe('.sandstorm/verify.sh', () => {
    it('passes SANDSTORM_VERIFY=1 via env when invoking npm test through sandstorm-exec', () => {
      // The variable must cross the container boundary via explicit env arg.
      // A bare `sandstorm-exec app npm test` would not propagate the variable.
      expect(verifySh).toContain('sandstorm-exec app env SANDSTORM_VERIFY=1 npm test')
    })

    it('does not use a bare npm test invocation (which would not set SANDSTORM_VERIFY)', () => {
      // Ensure the old pattern is gone — bare `sandstorm-exec app npm test` would
      // silently skip bash-gated tests instead of hard-failing on missing prereqs.
      const lines = verifySh.split('\n')
      const bareNpmTest = lines.some(
        (l) => /^\s*sandstorm-exec\s+app\s+npm\s+test\s*$/.test(l),
      )
      expect(bareNpmTest).toBe(false)
    })
  })

  describe('.sandstorm/context/verify.sh reference copy', () => {
    it('exists as a reference copy alongside .sandstorm/verify.sh', () => {
      expect(existsSync(contextVerifyPath)).toBe(true)
    })

    it('contains env SANDSTORM_VERIFY=1 npm test', () => {
      const contextVerify = readFileSync(contextVerifyPath, 'utf-8')
      expect(contextVerify).toContain('env SANDSTORM_VERIFY=1 npm test')
    })

    it('documents why SANDSTORM_VERIFY=1 is passed explicitly (arms the guard)', () => {
      const contextVerify = readFileSync(contextVerifyPath, 'utf-8')
      expect(contextVerify).toContain('SANDSTORM_VERIFY')
      // Must explain that it arms the skipIf→hard-fail guard
      const mentionsGuard =
        contextVerify.includes('guard') ||
        contextVerify.includes('skipIf') ||
        contextVerify.includes('hard-fail')
      expect(mentionsGuard).toBe(true)
    })
  })

  describe('init.sh template generator', () => {
    it('emits SANDSTORM_VERIFY=1 npm test for Node.js projects', () => {
      // The generator must produce SANDSTORM_VERIFY=1 so that newly-initialized
      // projects inherit the guard-armed test invocation from day one.
      expect(initSh).toContain('SANDSTORM_VERIFY=1 npm test')
    })

    it('does not emit a bare npm test without SANDSTORM_VERIFY=1', () => {
      // Find the npm test emit line.  It must NOT be `echo "npm test"` unadorned.
      const bareEmit = /echo\s+"npm\s+test"/.test(initSh)
      expect(bareEmit).toBe(false)
    })
  })

  describe('SANDSTORM_VERIFY guard pattern in bash-gated test suites', () => {
    it('task-runner-token-limit.test.ts uses isVerify hard-fail guard (not just skipIf)', () => {
      const content = readFileSync(
        resolve(__dirname, 'task-runner-token-limit.test.ts'),
        'utf-8',
      )
      // Guard declaration
      expect(content).toContain("process.env.SANDSTORM_VERIFY === '1'")
      // Hard-fail path: if guard armed AND prereqs absent → fail not skip
      expect(content).toContain("'bash not found on PATH'")
    })

    it('task-runner-review-loop.test.ts uses isVerify hard-fail guard (not just skipIf)', () => {
      const content = readFileSync(
        resolve(__dirname, 'task-runner-review-loop.test.ts'),
        'utf-8',
      )
      expect(content).toContain("process.env.SANDSTORM_VERIFY === '1'")
      expect(content).toContain("'bash not found on PATH'")
    })
  })
})

// ── Fix 2: phase-model-helper.sh path resolution ─────────────────────────────

describe('Fix 2: phase-model-helper.sh path decoupled from /app mount', () => {
  describe('task-runner.sh structural assertions', () => {
    it('has three fallback paths for phase-model-helper.sh (not just /usr/bin and /app)', () => {
      // Count the number of _phase_helper= assignment/check blocks.
      // Old code had 2 candidates; new code has 3.
      const helperAssignments = (taskRunner.match(/_phase_helper=/g) ?? []).length
      expect(helperAssignments).toBeGreaterThanOrEqual(3)
    })

    it('third fallback uses TASK_RUNNER variable for self-reference', () => {
      expect(taskRunner).toContain('TASK_RUNNER:-${BASH_SOURCE[0]}')
    })

    it('third fallback resolves the directory of task-runner.sh via cd dirname', () => {
      const helperBlock = taskRunner.slice(taskRunner.indexOf('_phase_helper="/usr/bin/phase-model-helper.sh"'))
      const codeUpToSource = helperBlock.slice(0, helperBlock.indexOf('source "$_phase_helper"'))
      expect(codeUpToSource).toContain('$(cd "$(dirname "$_self")" && pwd)')
    })

    it('third fallback constructs the path as sibling of task-runner.sh', () => {
      const helperBlock = taskRunner.slice(taskRunner.indexOf('_phase_helper="/usr/bin/phase-model-helper.sh"'))
      const codeUpToSource = helperBlock.slice(0, helperBlock.indexOf('source "$_phase_helper"'))
      expect(codeUpToSource).toContain('/phase-model-helper.sh')
    })

    it('third fallback block is inside an `if [ ! -f ]` guard (no override when /app path works)', () => {
      // The third assignment must be inside a guarded block, not unconditional.
      const thirdFallbackIdx = taskRunner.indexOf('TASK_RUNNER:-${BASH_SOURCE[0]}')
      expect(thirdFallbackIdx).toBeGreaterThan(-1)
      // The if guard for the third block must appear before the TASK_RUNNER ref
      const priorContent = taskRunner.slice(0, thirdFallbackIdx)
      const lastIfGuard = priorContent.lastIndexOf('if [ ! -f "$_phase_helper" ]')
      expect(lastIfGuard).toBeGreaterThan(-1)
    })

    it('cleans up _self after the third fallback', () => {
      expect(taskRunner).toContain('unset _self')
    })

    it('still cleans up _phase_helper after sourcing', () => {
      // The cleanup must follow the source call (not just appear elsewhere).
      const sourceIdx = taskRunner.indexOf('source "$_phase_helper"')
      const unsetIdx = taskRunner.indexOf('unset _phase_helper', sourceIdx)
      expect(unsetIdx).toBeGreaterThan(sourceIdx)
    })

    it('documents why BASH_SOURCE[0] is not reliable inside eval (comment in script)', () => {
      // The comment explains the eval context issue so future authors don't revert
      expect(taskRunner).toContain('eval')
      // The block must contain an explanatory comment
      const helperBlock = taskRunner.slice(
        taskRunner.indexOf('_phase_helper="/usr/bin/phase-model-helper.sh"'),
        taskRunner.indexOf('source "$_phase_helper"') + 30,
      )
      const hasExplanation =
        helperBlock.includes('eval') ||
        helperBlock.includes('TASK_RUNNER') ||
        helperBlock.includes('harness')
      expect(hasExplanation).toBe(true)
    })
  })
})

// ── Fix 2: Behavioral bash test ────────────────────────────────────────────────
//
// Exercises the third fallback by eval-ing the helper-function block from
// task-runner.sh with the first two hardcoded paths replaced by non-existent
// paths, then asserting that model_args_for_phase was defined (i.e., the real
// phase-model-helper.sh was sourced via TASK_RUNNER).

const fallbackSh = resolve(__dirname, 'task-runner-phase-helper-fallback.sh')
const hasBash705 = spawnSync('which', ['bash'], { encoding: 'utf-8' }).status === 0
const isVerify705 = process.env.SANDSTORM_VERIFY === '1'

if (isVerify705 && (!hasBash705 || !existsSync(fallbackSh))) {
  describe('Fix 2 behavioral: phase-helper TASK_RUNNER fallback (bash-level)', () => {
    it('prerequisite check: bash and fallback script must exist', () => {
      expect(hasBash705, 'bash not found on PATH').toBe(true)
      expect(existsSync(fallbackSh), `fallback script not found: ${fallbackSh}`).toBe(true)
    })
  })
} else {
  describe.skipIf(!hasBash705 || !existsSync(fallbackSh))(
    'Fix 2 behavioral: phase-helper TASK_RUNNER fallback (bash-level)',
    () => {
      it(
        'finds phase-model-helper.sh via TASK_RUNNER when /usr/bin and /app paths are absent',
        () => {
          const result = spawnSync('bash', [fallbackSh], {
            encoding: 'utf-8',
            timeout: 15_000,
          })
          if (result.status !== 0) {
            console.error('fallback test stdout:', result.stdout)
            console.error('fallback test stderr:', result.stderr)
          }
          expect(result.status).toBe(0)
        },
        15_000,
      )
    },
  )
}
