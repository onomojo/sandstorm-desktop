import { describe, it, expect } from 'vitest';
import { buildTokenTooltip, formatTokenCount, formatBytes, formatTokensCompact } from '../../src/renderer/utils/format';
import type { Stack } from '../../src/renderer/store';

function makeStack(overrides: Partial<Stack> = {}): Stack {
  return {
    id: 1,
    name: 'test-stack',
    status: 'running',
    project_dir: '/tmp/test',
    container_id: 'abc123',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_execution_input_tokens: 0,
    total_execution_output_tokens: 0,
    total_review_input_tokens: 0,
    total_review_output_tokens: 0,
    rate_limit_reset_at: null,
    ...overrides,
  } as Stack;
}

describe('formatTokenCount', () => {
  it('returns "0" for zero', () => {
    expect(formatTokenCount(0)).toBe('0');
  });

  it('returns raw number for values under 1000', () => {
    expect(formatTokenCount(500)).toBe('500');
  });

  it('formats thousands with k suffix', () => {
    expect(formatTokenCount(1500)).toBe('1.5k');
    expect(formatTokenCount(32100)).toBe('32.1k');
  });

  it('formats millions with M suffix', () => {
    expect(formatTokenCount(1500000)).toBe('1.50M');
  });
});

describe('formatTokensCompact', () => {
  it('returns raw integer for values under 1000', () => {
    expect(formatTokensCompact(999)).toBe('999');
  });

  it('formats thousands with uppercase K and no decimal', () => {
    expect(formatTokensCompact(20000)).toBe('20K');
    expect(formatTokensCompact(850000)).toBe('850K');
    expect(formatTokensCompact(1000)).toBe('1K');
    expect(formatTokensCompact(999_999)).toBe('1000K');
  });

  it('formats millions with 1 decimal place', () => {
    expect(formatTokensCompact(1_000_000)).toBe('1.0M');
    expect(formatTokensCompact(1_200_000)).toBe('1.2M');
  });

  it('formats billions with 2 decimal places', () => {
    expect(formatTokensCompact(1_000_000_000)).toBe('1.00B');
  });
});

describe('formatBytes', () => {
  it('returns "0 B" for zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(2048)).toBe('2 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(5242880)).toBe('5 MB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1610612736)).toBe('1.5 GB');
  });
});

describe('buildTokenTooltip', () => {
  it('shows phase breakdown when execution tokens are present', () => {
    const stack = makeStack({
      total_execution_input_tokens: 32100,
      total_execution_output_tokens: 13100,
      total_review_input_tokens: 12400,
      total_review_output_tokens: 6300,
      total_input_tokens: 44500,
      total_output_tokens: 19400,
    });

    const tooltip = buildTokenTooltip(stack);
    expect(tooltip).toContain('Execution: 32.1k in / 13.1k out');
    expect(tooltip).toContain('Review: 12.4k in / 6.3k out');
    expect(tooltip).toContain('Total: 44.5k in / 19.4k out');
  });

  it('shows phase breakdown when only review tokens are present', () => {
    const stack = makeStack({
      total_review_input_tokens: 5000,
      total_review_output_tokens: 2000,
      total_input_tokens: 5000,
      total_output_tokens: 2000,
    });

    const tooltip = buildTokenTooltip(stack);
    expect(tooltip).toContain('Execution: 0 in / 0 out');
    expect(tooltip).toContain('Review: 5.0k in / 2.0k out');
    expect(tooltip).toContain('Total: 5.0k in / 2.0k out');
  });

  it('shows legacy format when all phase tokens are zero', () => {
    const stack = makeStack({
      total_input_tokens: 1500,
      total_output_tokens: 800,
    });

    const tooltip = buildTokenTooltip(stack);
    expect(tooltip).toBe('Input: 1,500 / Output: 800');
  });

  it('shows legacy format for zero tokens', () => {
    const stack = makeStack();

    const tooltip = buildTokenTooltip(stack);
    expect(tooltip).toBe('Input: 0 / Output: 0');
  });
});

