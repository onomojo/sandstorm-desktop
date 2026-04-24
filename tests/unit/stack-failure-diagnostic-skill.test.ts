import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { resolve } from 'path'

// Structural + error-path tests for the stack-failure-diagnostic skill (#293).
// We can't easily exercise the happy path here (requires a live stack
// container + bridge). The behavior-eval ticket covers that. These tests
// guard the cheap-but-easy-to-break invariants.

const repoRoot = resolve(__dirname, '../..')
const skillDir = resolve(repoRoot, 'sandstorm-cli/skills/stack-failure-diagnostic')
const skillMd = resolve(skillDir, 'SKILL.md')
const script = resolve(skillDir, 'scripts/diagnose.sh')

describe('stack-failure-diagnostic skill (#293)', () => {
  it('SKILL.md exists with required frontmatter fields', () => {
    expect(existsSync(skillMd), `missing ${skillMd}`).toBe(true)
    const content = readFileSync(skillMd, 'utf-8')
    expect(content).toMatch(/^---/)
    expect(content).toMatch(/\nname:\s*stack-failure-diagnostic\b/)
    // Description must mention "failed" / "diagnose" so the triggering is obvious
    // to anyone reading the source.
    expect(content.toLowerCase()).toMatch(/fail|diagnose|why/)
  })

  it('diagnose.sh exists, is executable, and has valid bash syntax', () => {
    expect(existsSync(script), `missing ${script}`).toBe(true)
    // eslint-disable-next-line no-bitwise
    expect(statSync(script).mode & 0o111, `${script} not executable`).not.toBe(0)
    const check = spawnSync('bash', ['-n', script])
    expect(check.status, `bash -n ${script}: ${check.stderr?.toString()}`).toBe(0)
  })

  it('errors with a stable token when no stack id is given', () => {
    // Bridge env is required by the script; provide dummy values so we get
    // past the env gate and see the missing-arg branch.
    const out = execFileSync('bash', [script], {
      env: {
        ...process.env,
        SANDSTORM_BRIDGE_URL: 'http://127.0.0.1:1',
        SANDSTORM_BRIDGE_TOKEN: 'dummy',
      },
      encoding: 'utf-8',
    })
    expect(out).toContain('ERROR')
    expect(out).toContain('stack_id_missing')
  })

  it('refuses to run without SANDSTORM_BRIDGE_URL + _TOKEN', () => {
    const result = spawnSync('bash', [script, '250'], {
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf-8',
    })
    // Script uses `${VAR:?msg}` which exits non-zero when unset
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/bridge/i)
  })

  it('script invokes docker and the MCP bridge (surface reuse invariants)', () => {
    const body = readFileSync(script, 'utf-8')
    // Reuses the check-and-resume convention for the bridge call shape
    expect(body).toContain('X-Auth-Token: $SANDSTORM_BRIDGE_TOKEN')
    expect(body).toContain('/tool-call')
    // Reads artifacts via docker exec, not via the orchestrator's Bash tool
    expect(body).toContain('docker exec')
    expect(body).toMatch(/\/tmp\/claude-review-verdict/)
    expect(body).toMatch(/\/tmp\/claude-phase-timing\.txt/)
  })
})
