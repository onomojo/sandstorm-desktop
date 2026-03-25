import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('CLAUDE.md dual-loop workflow section', () => {
  const claudeMd = readFileSync(resolve(__dirname, '../../CLAUDE.md'), 'utf-8')

  it('contains the dual-loop workflow heading', () => {
    expect(claudeMd).toContain('## Mandatory dual-loop workflow')
  })

  it('documents the outer loop with max 5 iterations', () => {
    expect(claudeMd).toContain('OUTER LOOP (max 5 iterations)')
  })

  it('documents the inner loop with max 5 iterations that resets', () => {
    expect(claudeMd).toContain('INNER LOOP (max 5 iterations, resets each outer loop)')
  })

  it('describes the three agents', () => {
    expect(claudeMd).toContain('### Three Agents')
    expect(claudeMd).toContain('#### 1. Execution Agent')
    expect(claudeMd).toContain('#### 2. Review Agent (fresh context)')
    expect(claudeMd).toContain('#### 3. Verify Step')
  })

  it('requires the review agent to have fresh context', () => {
    expect(claudeMd).toContain('fresh context')
    expect(claudeMd).toContain('no carryover from the execution agent')
  })

  it('documents review criteria', () => {
    expect(claudeMd).toContain('**Architecture**')
    expect(claudeMd).toContain('**Best practices**')
    expect(claudeMd).toContain('**Separation of concerns**')
    expect(claudeMd).toContain('**DRY**')
    expect(claudeMd).toContain('**Security**')
    expect(claudeMd).toContain('**Scalability**')
    expect(claudeMd).toContain('**Optimizations**')
    expect(claudeMd).toContain('**Test coverage**')
  })

  it('documents verify step runs the full suite', () => {
    expect(claudeMd).toContain('/verify')
    expect(claudeMd).toContain('tests, types, build, electron-rebuild, package, run')
  })

  it('documents loop constraints table', () => {
    expect(claudeMd).toContain('### Loop Constraints')
    expect(claudeMd).toContain('resets to 0 each time the outer loop starts a new iteration')
    expect(claudeMd).toContain('counts total verify failures')
  })

  it('requires halting on max iterations exceeded', () => {
    expect(claudeMd).toContain('human intervention')
    expect(claudeMd).toContain('NOT silently continue or force-pass')
  })

  it('includes an example flow', () => {
    expect(claudeMd).toContain('### Example Flow')
  })

  it('documents implementation notes about structured reports and logging', () => {
    expect(claudeMd).toContain('### Implementation Notes')
    expect(claudeMd).toContain('structured (not free-form)')
    expect(claudeMd).toContain('clearly logged')
  })
})
