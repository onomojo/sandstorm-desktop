import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const taskRunnerPath = resolve(__dirname, '../../sandstorm-cli/docker/task-runner.sh')
const taskRunner = readFileSync(taskRunnerPath, 'utf-8')

describe('task-runner.sh node_modules reconcile', () => {
  // ── needs_node_modules_reconcile — pure comparison function ──────────

  describe('needs_node_modules_reconcile function', () => {
    it('defines needs_node_modules_reconcile()', () => {
      expect(taskRunner).toContain('needs_node_modules_reconcile()')
    })

    it('accepts current_hash and stored_hash arguments', () => {
      const fn = taskRunner.indexOf('needs_node_modules_reconcile()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('local current_hash="$1"')
      expect(body).toContain('local stored_hash="$2"')
    })

    it('returns 1 (skip) when hashes match — idempotency', () => {
      const fn = taskRunner.indexOf('needs_node_modules_reconcile()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('"$current_hash" = "$stored_hash"')
      expect(body).toContain('return 1')
    })

    it('returns 0 (install needed) when hashes differ', () => {
      const fn = taskRunner.indexOf('needs_node_modules_reconcile()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('return 0')
    })

    it('is defined before reconcile_app_node_modules (used by it)', () => {
      const pureIdx = taskRunner.indexOf('needs_node_modules_reconcile()')
      const reconcileIdx = taskRunner.indexOf('reconcile_app_node_modules()')
      expect(pureIdx).toBeGreaterThan(-1)
      expect(reconcileIdx).toBeGreaterThan(-1)
      expect(pureIdx).toBeLessThan(reconcileIdx)
    })
  })

  // ── reconcile_app_node_modules — main reconcile function ─────────────

  describe('reconcile_app_node_modules function', () => {
    it('defines reconcile_app_node_modules()', () => {
      expect(taskRunner).toContain('reconcile_app_node_modules()')
    })

    it('accepts verify_log as its first argument', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('local verify_log="$1"')
    })

    it('skips when /app/package-lock.json does not exist', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('! -f /app/package-lock.json')
      expect(body).toContain('return 0')
    })

    it('reads /proc/self/mountinfo from the app container via sandstorm-exec', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('sandstorm-exec app cat /proc/self/mountinfo')
    })

    it('uses awk to extract the mount source for /app/node_modules', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('/app/node_modules')
      expect(body).toContain('awk')
    })

    it('parses the source field after the - separator in mountinfo', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      // The awk extracts the source (2nd field after '-') from the mountinfo line
      expect(body).toContain('$5 == "/app/node_modules"')
      expect(body).toContain('if($i=="-")')
    })
  })

  // ── Volume-vs-bind gate ───────────────────────────────────────────────

  describe('volume-vs-bind gate', () => {
    it('checks that nm_source starts with /var/lib/docker/volumes/', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('/var/lib/docker/volumes/')
      expect(body).toContain('grep -q')
    })

    it('skips when nm_source is empty (no /app/node_modules mount entry)', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('-z "$nm_source"')
    })

    it('skips when nm_source does not start with /var/lib/docker/volumes/ (bind mount)', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      // The gate condition skips when NOT matching the named-volume prefix
      expect(body).toContain('^/var/lib/docker/volumes/')
    })

    it('logs a skip message when not a named volume', () => {
      expect(taskRunner).toContain('not a named volume')
      expect(taskRunner).toContain('skipping')
    })
  })

  // ── Hash-based drift detection ────────────────────────────────────────

  describe('hash-based drift detection', () => {
    it('hashes /app/package-lock.json with sha256sum', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('sha256sum /app/package-lock.json')
    })

    it('reads the stored hash from the app container named volume marker', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('sandstorm-exec app cat /app/node_modules/.sandstorm-lock-hash')
    })

    it('calls needs_node_modules_reconcile to compare hashes', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('needs_node_modules_reconcile "$current_hash" "$stored_hash"')
    })

    it('skips npm ci and logs when hashes match (idempotency)', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('up-to-date (hash match), skipping npm ci')
    })
  })

  // ── npm ci invocation and serialization ──────────────────────────────

  describe('npm ci invocation', () => {
    it('runs npm ci in the app container via sandstorm-exec', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('sandstorm-exec app')
      expect(body).toContain('npm ci')
    })

    it('serializes npm ci with flock on the named volume lock file', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('flock /app/node_modules/.sandstorm-reconcile-lock')
    })

    it('appends npm ci output to verify_log', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('>> "$verify_log"')
    })

    it('writes new hash marker to the named volume after successful npm ci', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      expect(body).toContain('.sandstorm-lock-hash')
      // The hash write comes after npm ci succeeds
      const npmCiIdx = body.indexOf('flock /app/node_modules/.sandstorm-reconcile-lock npm ci')
      const hashWriteIdx = body.indexOf('.sandstorm-lock-hash', npmCiIdx + 1)
      expect(hashWriteIdx).toBeGreaterThan(npmCiIdx)
    })
  })

  // ── Reconcile failure handling ────────────────────────────────────────

  describe('reconcile failure handling', () => {
    it('returns 2 (infrastructure error) when npm ci fails', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      // The failure path returns 2
      const failurePathIdx = body.indexOf('npm ci failed')
      const return2Idx = body.indexOf('return 2', failurePathIdx)
      expect(failurePathIdx).toBeGreaterThan(-1)
      expect(return2Idx).toBeGreaterThan(failurePathIdx)
    })

    it('echoes VERIFY_FAIL before returning 2 on npm ci failure', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      const failurePathIdx = body.indexOf('npm ci failed')
      const verifyFailIdx = body.indexOf('VERIFY_FAIL', failurePathIdx)
      const return2Idx = body.indexOf('return 2', failurePathIdx)
      expect(verifyFailIdx).toBeGreaterThan(-1)
      expect(verifyFailIdx).toBeLessThan(return2Idx)
    })

    it('tails the verify log before returning 2 (consistent with existing infra-error path)', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      const failurePathIdx = body.indexOf('npm ci failed')
      const tailIdx = body.indexOf('tail -n 50 "$verify_log"', failurePathIdx)
      const return2Idx = body.indexOf('return 2', failurePathIdx)
      expect(tailIdx).toBeGreaterThan(failurePathIdx)
      expect(tailIdx).toBeLessThan(return2Idx)
    })

    it('npm ci failure short-circuits before continuing (does not return 0)', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      const failurePathIdx = body.indexOf('npm ci failed')
      // After the failure path there should be no 'return 0' before 'return 2'
      const return2Idx = body.indexOf('return 2', failurePathIdx)
      const return0InFailure = body.indexOf('return 0', failurePathIdx)
      // Either no return 0 between failure and return 2, or return 0 is elsewhere
      expect(return2Idx).toBeGreaterThan(failurePathIdx)
      if (return0InFailure !== -1) {
        expect(return0InFailure).toBeGreaterThan(return2Idx)
      }
    })
  })

  // ── Ordering: reconcile runs before verify script ─────────────────────

  describe('ordering in run_verify', () => {
    it('reconcile_app_node_modules is called within run_verify', () => {
      const runVerifyStart = taskRunner.indexOf('run_verify()')
      const reconcileCall = taskRunner.indexOf('reconcile_app_node_modules "$verify_log"', runVerifyStart)
      expect(reconcileCall).toBeGreaterThan(runVerifyStart)
    })

    it('reconcile call appears before bash "$verify_script" in run_verify', () => {
      const runVerifyStart = taskRunner.indexOf('run_verify()')
      const reconcileCall = taskRunner.indexOf('reconcile_app_node_modules "$verify_log"', runVerifyStart)
      const verifyScriptInvocation = taskRunner.indexOf('bash "$verify_script"', runVerifyStart)
      expect(reconcileCall).toBeGreaterThan(-1)
      expect(verifyScriptInvocation).toBeGreaterThan(-1)
      expect(reconcileCall).toBeLessThan(verifyScriptInvocation)
    })

    it('reconcile failure short-circuits run_verify before the project verify script runs', () => {
      const runVerifyStart = taskRunner.indexOf('run_verify()')
      const reconcileBlock = taskRunner.indexOf('reconcile_app_node_modules "$verify_log"', runVerifyStart)
      const returnOnFailure = taskRunner.indexOf('return $reconcile_result', reconcileBlock)
      const verifyScriptInvocation = taskRunner.indexOf('bash "$verify_script"', runVerifyStart)
      expect(returnOnFailure).toBeGreaterThan(reconcileBlock)
      expect(returnOnFailure).toBeLessThan(verifyScriptInvocation)
    })

    it('reconcile_app_node_modules is defined before run_verify', () => {
      const reconcileFnDef = taskRunner.indexOf('reconcile_app_node_modules()')
      const runVerifyDef = taskRunner.indexOf('run_verify()')
      expect(reconcileFnDef).toBeGreaterThan(-1)
      expect(runVerifyDef).toBeGreaterThan(-1)
      expect(reconcileFnDef).toBeLessThan(runVerifyDef)
    })
  })

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles missing app service gracefully (sandstorm-exec failure → skip)', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      // The mountinfo read uses || return 0 to skip gracefully when app service unreachable
      expect(body).toContain('|| return 0')
    })

    it('handles missing stored hash gracefully (first run or cleared volume)', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      // The stored hash read uses || true so an empty string triggers install on first run
      expect(body).toContain('|| true')
    })

    it('hash marker write failure does not halt the reconcile (|| true)', () => {
      const fn = taskRunner.indexOf('reconcile_app_node_modules()')
      const fnEnd = taskRunner.indexOf('\n}', fn + 10)
      const body = taskRunner.substring(fn, fnEnd)
      const hashWriteIdx = body.lastIndexOf('.sandstorm-lock-hash')
      const trueAfterWrite = body.indexOf('|| true', hashWriteIdx)
      expect(trueAfterWrite).toBeGreaterThan(hashWriteIdx)
    })
  })
})
