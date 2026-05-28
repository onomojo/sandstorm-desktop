import { describe, it, expect } from 'vitest';
import { referencesTicket } from '../../src/main/control-plane/ticket-fetcher';

describe('referencesTicket', () => {
  it('detects standalone GitHub issue references like #123', () => {
    expect(referencesTicket('Fix #123')).toBe(true);
    expect(referencesTicket('#42 needs work')).toBe(true);
    expect(referencesTicket('See issue #99 for details')).toBe(true);
  });

  it('detects owner/repo#123 references', () => {
    expect(referencesTicket('See onomojo/sandstorm#27')).toBe(true);
  });

  it('detects GitHub issue URLs', () => {
    expect(referencesTicket('https://github.com/onomojo/sandstorm/issues/27')).toBe(true);
  });

  it('detects Jira-style ticket references (PROJ-123)', () => {
    expect(referencesTicket('Fix PROJ-123')).toBe(true);
    expect(referencesTicket('SAND-42 is blocking')).toBe(true);
    expect(referencesTicket('See ABC-1 for details')).toBe(true);
  });

  it('detects Linear-style URLs', () => {
    expect(referencesTicket('https://linear.app/myteam/issue/ABC-123')).toBe(true);
  });

  it('returns false for plain text without ticket references', () => {
    expect(referencesTicket('Fix the auth bug')).toBe(false);
    expect(referencesTicket('Refactor the login flow')).toBe(false);
  });

  it('returns false for hash in non-issue contexts', () => {
    expect(referencesTicket('color: #fff')).toBe(false);
  });

  it('does not match single uppercase letter followed by dash and digits', () => {
    expect(referencesTicket('See A-123')).toBe(false);
  });
});
