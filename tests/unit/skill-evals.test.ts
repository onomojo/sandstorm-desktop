import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { resolve } from 'path'

// Every authored trigger-eval.json is the contract the skill-eval runner
// consumes. If the shape or skill-name pairing drifts, the wrapper fails
// silently or produces meaningless results. These tests pin both.

const repoRoot = resolve(__dirname, '../..')
const evalsDir = resolve(repoRoot, 'docs/skill-evals')
const skillsDir = resolve(repoRoot, 'sandstorm-cli/skills')

function listEvalSets(): { skillName: string; path: string }[] {
  return readdirSync(evalsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'results')
    .map((e) => ({
      skillName: e.name,
      path: resolve(evalsDir, e.name, 'trigger-eval.json'),
    }))
    .filter((e) => existsSync(e.path))
}

describe('skill trigger-eval sets', () => {
  const evalSets = listEvalSets()

  it('at least one eval set exists', () => {
    expect(evalSets.length).toBeGreaterThan(0)
  })

  it.each(evalSets)('$skillName: pairs with a real bundled skill', ({ skillName }) => {
    const skillMd = resolve(skillsDir, skillName, 'SKILL.md')
    expect(existsSync(skillMd), `missing ${skillMd}`).toBe(true)
  })

  it.each(evalSets)('$skillName: is a well-formed eval array', ({ path }) => {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    expect(Array.isArray(parsed)).toBe(true)
    const arr = parsed as Array<Record<string, unknown>>
    expect(arr.length).toBeGreaterThanOrEqual(5)
    for (const entry of arr) {
      expect(typeof entry.query).toBe('string')
      expect((entry.query as string).length).toBeGreaterThan(0)
      expect(typeof entry.should_trigger).toBe('boolean')
    }
  })

  it.each(evalSets)('$skillName: has both positive and negative queries', ({ path }) => {
    const arr = JSON.parse(readFileSync(path, 'utf-8')) as Array<{ should_trigger: boolean }>
    const positives = arr.filter((e) => e.should_trigger).length
    const negatives = arr.filter((e) => !e.should_trigger).length
    // Per methodology doc: at least 1 positive and 5 negatives. Some skills
    // (stack-teardown) have only one natural positive phrasing from the user —
    // the main eval signal for those is the negative set, which must stay
    // large to prevent over-triggering.
    expect(positives).toBeGreaterThanOrEqual(1)
    expect(negatives).toBeGreaterThanOrEqual(5)
  })

  it.each(evalSets)('$skillName: no duplicate queries', ({ path }) => {
    const arr = JSON.parse(readFileSync(path, 'utf-8')) as Array<{ query: string }>
    const seen = new Set<string>()
    for (const entry of arr) {
      const key = entry.query.trim().toLowerCase()
      expect(seen.has(key), `duplicate query: ${entry.query}`).toBe(false)
      seen.add(key)
    }
  })
})

describe('skill-eval wrapper scripts', () => {
  const skillEval = resolve(repoRoot, 'scripts/skill-eval.sh')
  const runAll = resolve(repoRoot, 'scripts/run-all-skill-evals.sh')

  it('both scripts exist and are executable', () => {
    for (const p of [skillEval, runAll]) {
      expect(existsSync(p), `missing ${p}`).toBe(true)
      // eslint-disable-next-line no-bitwise
      expect(statSync(p).mode & 0o111, `${p} not executable`).not.toBe(0)
    }
  })

  it('skill-eval.sh references the pinned skill-creator plugin paths', () => {
    // If the upstream plugin path layout changes the wrapper will silently
    // fail to find run_loop.py. Pin both the cache and marketplace paths
    // so upgrades that rename either show up here first.
    const body = readFileSync(skillEval, 'utf-8')
    expect(body).toContain('plugins/cache/claude-plugins-official/skill-creator')
    expect(body).toContain('plugins/marketplaces/claude-plugins-official/plugins/skill-creator')
    expect(body).toContain('scripts/run_loop.py')
  })

  it('run-all-skill-evals.sh delegates to skill-eval.sh', () => {
    const body = readFileSync(runAll, 'utf-8')
    expect(body).toContain('scripts/skill-eval.sh')
  })
})
