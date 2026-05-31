import { describe, it, expect } from 'vitest';
import { suggestStackName } from '../../../src/renderer/lib/stack-name';

describe('suggestStackName', () => {
  it('prefixes a plain ticket id with ticket-', () => {
    expect(suggestStackName('310')).toBe('ticket-310');
  });

  it('strips a leading # from the ticket id', () => {
    expect(suggestStackName('#310')).toBe('ticket-310');
  });

  it('lowercases the id', () => {
    expect(suggestStackName('ABC-123')).toBe('ticket-abc-123');
  });

  it('replaces non-alphanumeric/hyphen chars with hyphens', () => {
    expect(suggestStackName('foo/bar baz')).toBe('ticket-foo-bar-baz');
  });

  it('returns empty string for an empty input', () => {
    expect(suggestStackName('')).toBe('');
  });

  it('returns empty string when id reduces to empty after stripping', () => {
    expect(suggestStackName('#')).toBe('');
  });
});
