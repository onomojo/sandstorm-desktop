import { describe, it, expect } from 'vitest';
import { appendContractSection } from '../../../src/main/control-plane/contract-dispatch';

describe('appendContractSection', () => {
  const base = '# Issue\n\n## Task\n\nDo the thing';
  const json = '{\n  "contract_version": 1\n}';

  it('appends a labeled Execution Contract block when a contract is present', () => {
    const out = appendContractSection(base, json);
    expect(out.startsWith(base)).toBe(true);
    expect(out).toContain('## Execution Contract');
    expect(out).toContain('```json');
    expect(out).toContain('"contract_version": 1');
    expect(out).toContain('forbidden_changes');
  });

  it('returns the prompt unchanged when contract is null', () => {
    expect(appendContractSection(base, null)).toBe(base);
  });

  it('returns the prompt unchanged when contract is undefined', () => {
    expect(appendContractSection(base, undefined)).toBe(base);
  });

  it('returns the prompt unchanged when contract is blank', () => {
    expect(appendContractSection(base, '   \n ')).toBe(base);
  });
});
