/**
 * Tests for sandstorm-cli/docker/opencode-token-counter.sh
 *
 * Pipes OpenCode NDJSON through the counter and verifies that step_finish
 * token counts are extracted in the {"in","out","cc","cr"} line format.
 * Uses the real captured fixture (opencode-run-stdout.ndjson, opencode-ai@1.17.7).
 *
 * Verified real schema: tokens live under .part.tokens.* (not flat .tokens.*).
 *   .part.tokens.input       → in
 *   .part.tokens.output      → out
 *   .part.tokens.cache.write → cc
 *   .part.tokens.cache.read  → cr
 *
 * Skipped if jq is unavailable.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(__dirname, '../../sandstorm-cli/docker/opencode-token-counter.sh');
const FIXTURES = resolve(__dirname, 'fixtures');

const hasJq = spawnSync('which', ['jq'], { encoding: 'utf-8' }).status === 0;

function runScript(input: string, args: string[] = []): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'oc-token-test-'));
  const outputFile = join(tmpDir, 'tokens.jsonl');

  try {
    const stdinInput = input.endsWith('\n') ? input : input + '\n';
    spawnSync('bash', [SCRIPT, outputFile, ...args], {
      input: stdinInput,
      encoding: 'utf-8',
    });
    try {
      return readFileSync(outputFile, 'utf-8');
    } catch {
      return '';
    }
  } finally {
    try { unlinkSync(outputFile); } catch { /* ignore */ }
    try { rmdirSync(tmpDir); } catch { /* ignore */ }
  }
}

function parseLines(output: string): Record<string, unknown>[] {
  return output
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function fixtureContent(name: string): string {
  return readFileSync(resolve(FIXTURES, name), 'utf-8');
}

/** Build a real-schema step_finish line matching opencode-ai@1.17.7 output. */
function makeStepFinish(input: number, output: number, cacheWrite = 0, cacheRead = 0): string {
  return JSON.stringify({
    type: 'step_finish',
    part: {
      type: 'step-finish',
      tokens: {
        total: input + output,
        input,
        output,
        reasoning: 0,
        cache: { write: cacheWrite, read: cacheRead },
      },
      cost: 0,
    },
  });
}

describe.skipIf(!hasJq)('opencode-token-counter.sh', () => {
  it('writes nothing for empty input', () => {
    expect(runScript('').trim()).toBe('');
  });

  it('writes nothing for non-step_finish events', () => {
    const input = [
      JSON.stringify({ type: 'text', part: { text: 'hello' } }),
      JSON.stringify({ type: 'tool_use', part: { tool: 'bash' } }),
    ].join('\n');
    expect(runScript(input).trim()).toBe('');
  });

  it('captures step_finish with .part.tokens.input/.output (regression: was flat .tokens.*)', () => {
    const input = makeStepFinish(1234, 567, 0, 100);
    const output = runScript(input);
    const lines = parseLines(output);
    expect(lines).toHaveLength(1);
    expect(lines[0].in).toBe(1234);
    expect(lines[0].out).toBe(567);
    expect(lines[0].cr).toBe(100);
    expect(lines[0].cc).toBe(0);
  });

  it('reads cache from .part.tokens.cache.write/.read (regression: was flat .tokens.cache_write/cache_read)', () => {
    const input = makeStepFinish(2000, 800, 150, 300);
    const output = runScript(input);
    const lines = parseLines(output);
    expect(lines).toHaveLength(1);
    expect(lines[0].cc).toBe(150);
    expect(lines[0].cr).toBe(300);
  });

  it('defaults missing cache fields to 0', () => {
    const input = JSON.stringify({
      type: 'step_finish',
      part: { tokens: { input: 500, output: 100 } },
    });
    const output = runScript(input);
    const lines = parseLines(output);
    expect(lines).toHaveLength(1);
    expect(lines[0].in).toBe(500);
    expect(lines[0].out).toBe(100);
    expect(lines[0].cc).toBe(0);
    expect(lines[0].cr).toBe(0);
  });

  it('includes iter and phase metadata when provided', () => {
    const input = makeStepFinish(100, 50);
    const output = runScript(input, ['2', 'execution']);
    const lines = parseLines(output);
    expect(lines[0].iter).toBe(2);
    expect(lines[0].phase).toBe('execution');
  });

  it('omits iter/phase when not provided', () => {
    const input = makeStepFinish(100, 50);
    const output = runScript(input);
    const lines = parseLines(output);
    expect(lines[0]).not.toHaveProperty('iter');
    expect(lines[0]).not.toHaveProperty('phase');
  });

  it('writes nothing when in and out are both zero', () => {
    const input = makeStepFinish(0, 0);
    const output = runScript(input);
    expect(output.trim()).toBe('');
  });

  it('handles missing .part.tokens field gracefully', () => {
    const input = JSON.stringify({ type: 'step_finish', part: {} });
    const output = runScript(input);
    expect(output.trim()).toBe('');
  });

  it('handles non-step_finish lines in mixed input', () => {
    const input = [
      JSON.stringify({ type: 'text', part: { text: 'Working...' } }),
      makeStepFinish(300, 75),
      JSON.stringify({ type: 'text', part: { text: 'More text' } }),
    ].join('\n');
    const output = runScript(input);
    const lines = parseLines(output);
    expect(lines).toHaveLength(1);
    expect(lines[0].in).toBe(300);
    expect(lines[0].out).toBe(75);
  });

  it('processes opencode-run-stdout.ndjson fixture — both step_finish events recorded', () => {
    const input = fixtureContent('opencode-run-stdout.ndjson');
    const output = runScript(input, ['1', 'execution']);
    const lines = parseLines(output);
    // fixture has 2 step_finish lines, both with in=4096 (>0)
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.in).toBe(4096);
      expect(typeof line.out).toBe('number');
      expect(typeof line.cc).toBe('number');
      expect(typeof line.cr).toBe('number');
    }
    expect(lines[0].iter).toBe(1);
    expect(lines[0].phase).toBe('execution');
  });

  it('processes opencode-run-stdout.ndjson fixture — reads nested .part.tokens paths', () => {
    const input = fixtureContent('opencode-run-stdout.ndjson');
    const output = runScript(input);
    const lines = parseLines(output);
    // Both fixture step_finish lines have output:24 and output:110
    const outs = lines.map((l) => l.out).sort((a, b) => (a as number) - (b as number));
    expect(outs).toEqual([24, 110]);
  });
});
