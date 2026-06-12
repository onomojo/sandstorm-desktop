/**
 * Tests for sandstorm-cli/docker/opencode-token-counter.sh
 *
 * Pipes OpenCode NDJSON fixtures through the counter and verifies that
 * step_finish token counts are extracted in the same {"in","out","cc","cr"}
 * line format that token-counter.sh produces for Claude output.
 *
 * Skipped if jq is unavailable (same guard as token-counter.test.ts).
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

describe.skipIf(!hasJq)('opencode-token-counter.sh', () => {
  it('writes nothing for empty input', () => {
    expect(runScript('').trim()).toBe('');
  });

  it('writes nothing for non-step_finish events', () => {
    const input = [
      JSON.stringify({ type: 'text', content: 'hello' }),
      JSON.stringify({ type: 'tool_use', name: 'bash', input: {} }),
    ].join('\n');
    expect(runScript(input).trim()).toBe('');
  });

  it('captures step_finish with split cache fields', () => {
    const input = JSON.stringify({
      type: 'step_finish',
      result: 'done',
      tokens: { input: 1234, output: 567, cache_read: 100, cache_write: 0 },
    });
    const output = runScript(input);
    const lines = parseLines(output);
    expect(lines).toHaveLength(1);
    expect(lines[0].in).toBe(1234);
    expect(lines[0].out).toBe(567);
    expect(lines[0].cr).toBe(100);
    expect(lines[0].cc).toBe(0);
    expect(lines[0].partial).toBeUndefined();
  });

  it('maps single cache field to cr, sets cc=0', () => {
    const input = JSON.stringify({
      type: 'step_finish',
      result: 'done',
      tokens: { input: 500, output: 100, cache: 50 },
    });
    const output = runScript(input);
    const lines = parseLines(output);
    expect(lines).toHaveLength(1);
    expect(lines[0].in).toBe(500);
    expect(lines[0].out).toBe(100);
    expect(lines[0].cc).toBe(0);
    expect(lines[0].cr).toBe(50);
  });

  it('maps cache_write to cc when present', () => {
    const input = JSON.stringify({
      type: 'step_finish',
      result: 'done',
      tokens: { input: 2000, output: 800, cache_read: 300, cache_write: 150 },
    });
    const output = runScript(input);
    const lines = parseLines(output);
    expect(lines).toHaveLength(1);
    expect(lines[0].cc).toBe(150);
    expect(lines[0].cr).toBe(300);
  });

  it('includes iter and phase metadata when provided', () => {
    const input = JSON.stringify({
      type: 'step_finish',
      result: 'done',
      tokens: { input: 100, output: 50, cache_read: 0, cache_write: 0 },
    });
    const output = runScript(input, ['2', 'execution']);
    const lines = parseLines(output);
    expect(lines[0].iter).toBe(2);
    expect(lines[0].phase).toBe('execution');
  });

  it('omits iter/phase when not provided', () => {
    const input = JSON.stringify({
      type: 'step_finish',
      result: 'done',
      tokens: { input: 100, output: 50, cache_read: 0, cache_write: 0 },
    });
    const output = runScript(input);
    const lines = parseLines(output);
    expect(lines[0]).not.toHaveProperty('iter');
    expect(lines[0]).not.toHaveProperty('phase');
  });

  it('writes nothing when token counts are both zero', () => {
    const input = JSON.stringify({
      type: 'step_finish',
      result: 'done',
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    });
    const output = runScript(input);
    expect(output.trim()).toBe('');
  });

  it('handles missing tokens field gracefully', () => {
    const input = JSON.stringify({ type: 'step_finish', result: 'done' });
    const output = runScript(input);
    expect(output.trim()).toBe('');
  });

  it('processes opencode-basic.ndjson fixture — split cache read', () => {
    const input = fixtureContent('opencode-basic.ndjson');
    const output = runScript(input, ['1', 'execution']);
    const lines = parseLines(output);
    expect(lines).toHaveLength(1);
    expect(lines[0].in).toBe(1234);
    expect(lines[0].out).toBe(567);
    expect(lines[0].cr).toBe(100);
    expect(lines[0].cc).toBe(0);
    expect(lines[0].iter).toBe(1);
    expect(lines[0].phase).toBe('execution');
  });

  it('processes opencode-tool-use.ndjson fixture — single cache field', () => {
    const input = fixtureContent('opencode-tool-use.ndjson');
    const output = runScript(input);
    const lines = parseLines(output);
    expect(lines).toHaveLength(1);
    expect(lines[0].in).toBe(500);
    expect(lines[0].out).toBe(100);
    expect(lines[0].cr).toBe(50);
    expect(lines[0].cc).toBe(0);
  });

  it('processes opencode-tokens-split-cache.ndjson fixture', () => {
    const input = fixtureContent('opencode-tokens-split-cache.ndjson');
    const output = runScript(input, ['2', 'review']);
    const lines = parseLines(output);
    expect(lines).toHaveLength(1);
    expect(lines[0].in).toBe(2000);
    expect(lines[0].out).toBe(800);
    expect(lines[0].cr).toBe(300);
    expect(lines[0].cc).toBe(150);
    expect(lines[0].iter).toBe(2);
    expect(lines[0].phase).toBe('review');
  });

  it('handles non-step_finish lines in mixed input', () => {
    const input = [
      JSON.stringify({ type: 'text', content: 'Working...' }),
      JSON.stringify({ type: 'step_finish', result: 'done', tokens: { input: 300, output: 75, cache_read: 0, cache_write: 0 } }),
      JSON.stringify({ type: 'text', content: 'More text' }),
    ].join('\n');
    const output = runScript(input);
    const lines = parseLines(output);
    expect(lines).toHaveLength(1);
    expect(lines[0].in).toBe(300);
    expect(lines[0].out).toBe(75);
  });
});
