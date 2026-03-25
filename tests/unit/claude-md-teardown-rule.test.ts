import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('CLAUDE.md teardown rule', () => {
  const claudeMd = readFileSync(resolve(__dirname, '../../CLAUDE.md'), 'utf-8')

  it('contains the stack teardown rule section', () => {
    expect(claudeMd).toContain('## Stack teardown rule')
  })

  it('has the hard rule about never tearing down stacks without explicit request', () => {
    expect(claudeMd).toContain(
      'NEVER tear down stacks unless the user explicitly says to tear down a stack. No exceptions.'
    )
  })

  it('prohibits inferring teardown', () => {
    expect(claudeMd).toContain('Do not infer that a stack should be torn down')
  })

  it('prohibits teardown to make room', () => {
    expect(claudeMd).toContain('Do not tear down stacks to "make room" for new ones')
  })

  it('prohibits teardown of stale stacks', () => {
    expect(claudeMd).toContain('Do not tear down stacks that look stale or old')
  })

  it('prohibits teardown as precursor to creating new ones', () => {
    expect(claudeMd).toContain('Do not tear down stacks as a precursor to creating new ones')
  })

  it('prohibits automatic cleanup after pushing', () => {
    expect(claudeMd).toContain('Do not automatically clean up stacks after pushing')
  })

  it('states only valid trigger is explicit user request', () => {
    expect(claudeMd).toContain(
      'The ONLY valid trigger is the user directly and explicitly requesting teardown'
    )
  })

  it('warns about loss of unpushed work', () => {
    expect(claudeMd).toContain('Violating this rule has caused loss of unpushed work. This is a hard rule.')
  })
})
