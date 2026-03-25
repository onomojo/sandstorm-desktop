import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('CLAUDE.md dual-loop workflow section', () => {
  const claudeMd = readFileSync(resolve(__dirname, '../../CLAUDE.md'), 'utf-8')

  it('contains the dual-loop workflow heading', () => {
    expect(claudeMd).toContain('## Mandatory dual-loop workflow')
  })

  it('describes the three agents', () => {
    expect(claudeMd).toContain('#### 1. Execution Agent')
    expect(claudeMd).toContain('#### 2. Review Agent (fresh context)')
    expect(claudeMd).toContain('#### 3. Verify Step')
  })

  it('specifies the Review Agent must have fresh context', () => {
    expect(claudeMd).toContain(
      'Spins up with a **fresh context** — no carryover from the execution agent\'s session'
    )
  })

  it('documents the review checklist categories', () => {
    expect(claudeMd).toContain('**Architecture**')
    expect(claudeMd).toContain('**Best practices**')
    expect(claudeMd).toContain('**Separation of concerns**')
    expect(claudeMd).toContain('**DRY**')
    expect(claudeMd).toContain('**Security**')
    expect(claudeMd).toContain('**Scalability**')
    expect(claudeMd).toContain('**Optimizations**')
    expect(claudeMd).toContain('**Test coverage**')
  })

  it('specifies inner loop max of 5 iterations', () => {
    expect(claudeMd).toContain('**Inner loop** (execution <-> review): max 5 iterations')
  })

  it('specifies outer loop max of 5 iterations', () => {
    expect(claudeMd).toContain('**Outer loop** (inner loop -> verify -> repeat): max 5 iterations')
  })

  it('requires halting when max iterations exceeded', () => {
    expect(claudeMd).toContain('human intervention is needed')
    expect(claudeMd).toContain('must NOT silently continue or force-pass')
  })

  it('requires structured review reports', () => {
    expect(claudeMd).toContain(
      'review report should be structured (not free-form)'
    )
  })

  it('requires loop counters to be logged', () => {
    expect(claudeMd).toContain('loop counters and state transitions should be clearly logged')
  })

  it('specifies inner loop resets each outer iteration', () => {
    expect(claudeMd).toContain('Resets to 0 each time the outer loop starts a new iteration')
  })
})
