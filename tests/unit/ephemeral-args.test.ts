/**
 * Unit tests for buildEphemeralAgentArgs.
 * This module is electron-free — no vi.mock('electron') needed.
 *
 * Regression for the "spawn E2BIG" refine failure (ticket 647): the ephemeral
 * print-mode spawn must NOT carry the prompt as a CLI argument, because a large
 * prompt overflows Linux's 128 KB per-argument limit (MAX_ARG_STRLEN) and makes
 * child_process.spawn throw E2BIG synchronously. The prompt is fed via stdin
 * instead, so it can never appear in argv.
 */
import { describe, it, expect } from 'vitest';
import { buildEphemeralAgentArgs } from '../../src/main/agent/ephemeral-args';

describe('buildEphemeralAgentArgs', () => {
  it('runs print mode with stream-json output and skipped permissions', () => {
    const args = buildEphemeralAgentArgs();
    expect(args).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
    ]);
  });

  it('appends --model when a concrete model is given', () => {
    expect(buildEphemeralAgentArgs('sonnet')).toContain('--model');
    expect(buildEphemeralAgentArgs('sonnet')).toContain('sonnet');
  });

  it('omits --model for "auto" or undefined', () => {
    expect(buildEphemeralAgentArgs('auto')).not.toContain('--model');
    expect(buildEphemeralAgentArgs(undefined)).not.toContain('--model');
  });

  it('never carries a positional prompt argument', () => {
    // -p is the print-mode flag, not a key that takes the prompt as its value.
    const args = buildEphemeralAgentArgs('sonnet');
    const pIdx = args.indexOf('-p');
    expect(pIdx).toBe(0);
    // The token after -p must be the next flag, never prompt content.
    expect(args[pIdx + 1]).toBe('--output-format');
  });

  it('regression: argv stays tiny even when the prompt is huge (no E2BIG)', () => {
    // A 1 MB prompt is realistic once references are inlined (ticket-references
    // caps total inlined content at 1 MB). It must not influence argv at all.
    const hugePrompt = 'x'.repeat(1024 * 1024);
    const args = buildEphemeralAgentArgs('opus');
    // The builder takes no prompt; assert no arg approaches the 128 KB ceiling.
    const MAX_ARG_STRLEN = 128 * 1024;
    for (const arg of args) {
      expect(arg.length).toBeLessThan(MAX_ARG_STRLEN);
    }
    // And the prompt content is genuinely absent from argv.
    expect(args.some((a) => a.includes(hugePrompt))).toBe(false);
    expect(args.join('').length).toBeLessThan(100);
  });
});
