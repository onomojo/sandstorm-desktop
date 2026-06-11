/**
 * Tests for sandstorm-cli/docker/opencode-ndjson-parser.sh
 *
 * Pipes OpenCode NDJSON fixtures through the parser and verifies the output
 * matches the same formatted-text shape that run_claude's jq filter produces.
 *
 * Skipped if jq is unavailable (same guard as token-counter.test.ts).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const PARSER = resolve(__dirname, '../../sandstorm-cli/docker/opencode-ndjson-parser.sh');
const FIXTURES = resolve(__dirname, 'fixtures');

const hasJq = spawnSync('which', ['jq'], { encoding: 'utf-8' }).status === 0;

function runParser(input: string): string {
  const result = spawnSync('bash', [PARSER], {
    input: input.endsWith('\n') ? input : input + '\n',
    encoding: 'utf-8',
  });
  return result.stdout ?? '';
}

function fixtureContent(name: string): string {
  return readFileSync(resolve(FIXTURES, name), 'utf-8');
}

describe.skipIf(!hasJq)('opencode-ndjson-parser.sh', () => {
  it('emits text content as-is', () => {
    const input = JSON.stringify({ type: 'text', content: 'Hello world' });
    const output = runParser(input);
    expect(output).toContain('Hello world');
  });

  it('emits tool_use marker in the exact run_claude shape', () => {
    const input = JSON.stringify({ type: 'tool_use', name: 'read_file', input: {} });
    const output = runParser(input);
    expect(output).toBe('\n── read_file ──\n');
  });

  it('emits step_finish result text with surrounding newlines', () => {
    const input = JSON.stringify({
      type: 'step_finish',
      result: 'Done.',
      tokens: { input: 100, output: 50, cache_read: 0, cache_write: 0 },
    });
    const output = runParser(input);
    expect(output).toBe('\nDone.\n');
  });

  it('emits error line with exact ❌ ERROR: prefix', () => {
    const input = JSON.stringify({ type: 'error', message: 'context length exceeded' });
    const output = runParser(input);
    expect(output).toBe('\n❌ ERROR: context length exceeded\n');
  });

  it('handles step_finish with empty result', () => {
    const input = JSON.stringify({ type: 'step_finish', result: '', tokens: {} });
    const output = runParser(input);
    expect(output).toBe('\n\n');
  });

  it('handles missing result field in step_finish', () => {
    const input = JSON.stringify({ type: 'step_finish', tokens: {} });
    const output = runParser(input);
    expect(output).toBe('\n\n');
  });

  it('handles missing message field in error', () => {
    const input = JSON.stringify({ type: 'error' });
    const output = runParser(input);
    expect(output).toBe('\n❌ ERROR: unknown error\n');
  });

  it('emits nothing for unknown event types', () => {
    const input = JSON.stringify({ type: 'unknown_event', data: 'whatever' });
    const output = runParser(input);
    expect(output.trim()).toBe('');
  });

  it('processes opencode-basic.ndjson fixture correctly', () => {
    const input = fixtureContent('opencode-basic.ndjson');
    const output = runParser(input);
    expect(output).toContain('Analyzing the task...');
    expect(output).toContain('\n── read_file ──\n');
    expect(output).toContain('The implementation looks correct.');
    expect(output).toContain('\nTask completed successfully.\n');
  });

  it('processes opencode-error.ndjson fixture correctly', () => {
    const input = fixtureContent('opencode-error.ndjson');
    const output = runParser(input);
    expect(output).toContain('Starting task...');
    expect(output).toContain('\n❌ ERROR: API error: context length exceeded\n');
  });

  it('processes opencode-tool-use.ndjson fixture correctly', () => {
    const input = fixtureContent('opencode-tool-use.ndjson');
    const output = runParser(input);
    expect(output).toContain('\n── bash ──\n');
    expect(output).toContain('Tests are passing.');
    expect(output).toContain('\nAll tests passed.\n');
  });

  it('handles multiple text events concatenated', () => {
    const input = [
      JSON.stringify({ type: 'text', content: 'Hello ' }),
      JSON.stringify({ type: 'text', content: 'world' }),
    ].join('\n');
    const output = runParser(input);
    expect(output).toBe('Hello world');
  });

  it('interleaves tool markers between text deltas', () => {
    const input = [
      JSON.stringify({ type: 'text', content: 'Before' }),
      JSON.stringify({ type: 'tool_use', name: 'list_files', input: {} }),
      JSON.stringify({ type: 'text', content: 'After' }),
    ].join('\n');
    const output = runParser(input);
    expect(output).toBe('Before\n── list_files ──\nAfter');
  });
});
