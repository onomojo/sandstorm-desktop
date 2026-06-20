import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { spawnSync } from 'child_process'

import {
  STATE_FILES,
  T0_REACHABLE,
  STACK_INPUT_FILES,
  DYNAMIC_FILES,
  TASK_STATUS_VALUES,
  type StateFile,
} from '../../tests/contract/state-files'

const TASK_RUNNER = resolve(__dirname, '../../sandstorm-cli/docker/task-runner.sh')
const STACK_SH = resolve(__dirname, '../../sandstorm-cli/lib/stack.sh')
const hasBash = spawnSync('which', ['bash'], { encoding: 'utf-8' }).status === 0

// ---------------------------------------------------------------------------
// Schema completeness and type-safety tests
// ---------------------------------------------------------------------------

describe('state-files schema', () => {
  describe('structural requirements', () => {
    it('exports a non-empty STATE_FILES array', () => {
      expect(STATE_FILES).toBeDefined()
      expect(Array.isArray(STATE_FILES)).toBe(true)
      expect(STATE_FILES.length).toBeGreaterThan(20)
    })

    it('every entry has the required fields', () => {
      const required: (keyof StateFile)[] = [
        'pattern',
        'description',
        'producer',
        'consumer',
        'format',
        'whenWritten',
        'conditional',
        't0Reachable',
      ]
      for (const file of STATE_FILES) {
        for (const field of required) {
          expect(file[field], `${file.pattern} is missing field '${field}'`).toBeDefined()
        }
      }
    })

    it('all patterns start with /tmp/', () => {
      for (const file of STATE_FILES) {
        expect(
          file.pattern.startsWith('/tmp/'),
          `${file.pattern} does not start with /tmp/`,
        ).toBe(true)
      }
    })

    it('all descriptions are non-empty strings', () => {
      for (const file of STATE_FILES) {
        expect(
          typeof file.description === 'string' && file.description.length > 0,
          `${file.pattern} has empty or missing description`,
        ).toBe(true)
      }
    })

    it('dynamic files have a suffixRange with min <= max', () => {
      for (const file of DYNAMIC_FILES) {
        expect(file.suffixRange, `${file.pattern} is dynamic but missing suffixRange`).toBeDefined()
        expect(
          file.suffixRange!.min <= file.suffixRange!.max,
          `${file.pattern} has inverted suffixRange`,
        ).toBe(true)
      }
    })

    it('status files have non-empty statusValues arrays', () => {
      const statusFiles = STATE_FILES.filter((f) => f.format === 'status')
      expect(statusFiles.length).toBeGreaterThan(0)
      for (const file of statusFiles) {
        expect(
          Array.isArray(file.statusValues) && file.statusValues!.length > 0,
          `${file.pattern} has format 'status' but no statusValues`,
        ).toBe(true)
      }
    })

    it('no duplicate patterns', () => {
      const patterns = STATE_FILES.map((f) => f.pattern)
      const unique = new Set(patterns)
      expect(unique.size).toBe(patterns.length)
    })
  })

  // ---------------------------------------------------------------------------
  // T0-reachable subset
  // ---------------------------------------------------------------------------

  describe('T0-reachable files', () => {
    it('T0_REACHABLE is a non-empty subset of STATE_FILES', () => {
      expect(T0_REACHABLE.length).toBeGreaterThan(0)
      expect(T0_REACHABLE.length).toBeLessThan(STATE_FILES.length)
      for (const f of T0_REACHABLE) {
        expect(STATE_FILES).toContain(f)
      }
    })

    it('all T0-reachable files are either stack.sh inputs or STOP_AND_ASK artifacts', () => {
      for (const f of T0_REACHABLE) {
        const isStackInput =
          f.producer === 'stack.sh' ||
          (Array.isArray(f.producer) && f.producer.includes('stack.sh'))
        const isStopAsk =
          f.pattern.includes('stop-reason') || f.pattern.includes('stop-questions')
        expect(
          isStackInput || isStopAsk,
          `${f.pattern} is t0Reachable but is neither a stack.sh input nor a STOP_AND_ASK artifact`,
        ).toBe(true)
      }
    })

    it('stack input files are all T0-reachable', () => {
      for (const f of STACK_INPUT_FILES) {
        expect(
          f.t0Reachable,
          `stack.sh input file ${f.pattern} should be t0Reachable`,
        ).toBe(true)
      }
    })

    it('includes all 9 expected stack.sh input file patterns', () => {
      const inputPatterns = STACK_INPUT_FILES.map((f) => f.pattern)
      const expected = [
        '/tmp/claude-task-trigger',
        '/tmp/claude-task-prompt.txt',
        '/tmp/claude-task-label.txt',
        '/tmp/claude-task-model.txt',
        '/tmp/claude-task-models.json',
        '/tmp/claude-task-resume.txt',
        '/tmp/claude-task-backend.txt',
        '/tmp/claude-task-backend-model.txt',
        '/tmp/claude-task-phase-routing.json',
      ]
      for (const p of expected) {
        expect(inputPatterns, `missing stack.sh input file: ${p}`).toContain(p)
      }
    })

    it('includes stop-reason.txt as T0-reachable', () => {
      const f = STATE_FILES.find((sf) => sf.pattern === '/tmp/claude-stop-reason.txt')
      expect(f).toBeDefined()
      expect(f!.t0Reachable).toBe(true)
    })

    it('includes stop-questions.json as T0-reachable', () => {
      const f = STATE_FILES.find((sf) => sf.pattern === '/tmp/claude-stop-questions.json')
      expect(f).toBeDefined()
      expect(f!.t0Reachable).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // TASK_STATUS_VALUES
  // ---------------------------------------------------------------------------

  describe('TASK_STATUS_VALUES', () => {
    it('is a non-empty array of strings', () => {
      expect(Array.isArray(TASK_STATUS_VALUES)).toBe(true)
      expect(TASK_STATUS_VALUES.length).toBeGreaterThan(0)
      for (const v of TASK_STATUS_VALUES) {
        expect(typeof v).toBe('string')
      }
    })

    it('includes the core lifecycle statuses', () => {
      const core = ['running', 'completed', 'failed', 'token_limited', 'needs_human']
      for (const s of core) {
        expect(TASK_STATUS_VALUES, `missing status value: ${s}`).toContain(s)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Cross-reference with task-runner.sh source
  // ---------------------------------------------------------------------------

  describe('cross-reference with task-runner.sh', () => {
    it('task-runner.sh exists', () => {
      expect(existsSync(TASK_RUNNER)).toBe(true)
    })

    const knownPaths = [
      '/tmp/claude-task-trigger',
      '/tmp/claude-task-prompt.txt',
      '/tmp/claude-task-model.txt',
      '/tmp/claude-task-models.json',
      '/tmp/claude-task-resume.txt',
      '/tmp/claude-task-backend.txt',
      '/tmp/claude-task-phase-routing.json',
      '/tmp/claude-ready',
      '/tmp/claude-task.pid',
      '/tmp/claude-task.status',
      '/tmp/claude-task.exit',
      '/tmp/claude-task.review-iterations',
      '/tmp/claude-task.verify-retries',
      '/tmp/claude-raw.log',
      '/tmp/claude-task.log',
      '/tmp/claude-review-raw.log',
      '/tmp/claude-review-task.log',
      '/tmp/claude-stop-reason.txt',
      '/tmp/claude-verify.log',
      '/tmp/claude-phase-timing.txt',
      '/tmp/claude-execution-summary.txt',
    ]

    for (const p of knownPaths) {
      it(`schema includes known path ${p}`, () => {
        const found = STATE_FILES.some((f) => f.pattern === p)
        expect(found, `${p} is referenced in task-runner.sh but missing from schema`).toBe(true)
      })
    }
  })

  // ---------------------------------------------------------------------------
  // Cross-reference with stack.sh source
  // ---------------------------------------------------------------------------

  describe('cross-reference with stack.sh', () => {
    it('stack.sh exists', () => {
      expect(existsSync(STACK_SH)).toBe(true)
    })

    it('schema covers all /tmp/ paths written by stack.sh task command', () => {
      // These are the literal writes in the stack.sh "task" case
      const stackWrites = [
        '/tmp/claude-task-prompt.txt',
        '/tmp/claude-task-label.txt',
        '/tmp/claude-task-trigger',
      ]
      const patterns = STATE_FILES.map((f) => f.pattern)
      for (const p of stackWrites) {
        expect(patterns, `stack.sh writes ${p} but it is missing from schema`).toContain(p)
      }
    })
  })
})

// ---------------------------------------------------------------------------
// Bash-level T0 contract test (uses bash-harness.sh + state-file-contract.sh)
// ---------------------------------------------------------------------------

const contractSh = resolve(__dirname, 'state-file-contract.sh')

describe.skipIf(!hasBash || !existsSync(contractSh))(
  'T0 bash contract tests',
  () => {
    it(
      'state-file-contract.sh: all T0 state-file assertions pass',
      () => {
        const result = spawnSync('bash', [contractSh], {
          encoding: 'utf-8',
          timeout: 30_000,
        })
        if (result.stdout) process.stdout.write(result.stdout)
        if (result.stderr) process.stderr.write(result.stderr)
        expect(result.status).toBe(0)
      },
      30_000,
    )
  },
)
