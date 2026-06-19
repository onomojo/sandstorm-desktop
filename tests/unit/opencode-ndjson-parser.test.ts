/**
 * Tests for sandstorm-cli/docker/opencode-ndjson-parser.sh
 *
 * Pipes OpenCode NDJSON through the parser and verifies the output.
 * Uses the real captured fixture (opencode-run-stdout.ndjson, opencode-ai@1.17.7).
 *
 * Real schema: { "type": <t>, "part": { … } } — fields live under .part.
 *   text       → .part.text
 *   tool_use   → .part.tool
 *   step_finish → emits nothing (no .result field in real output)
 *   error      → .message (unverified; kept defensively)
 *
 * Skipped if jq is unavailable.
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
  it('emits .part.text for text events (regression: was .content)', () => {
    const input = JSON.stringify({ type: 'text', part: { text: 'Hello world' } });
    const output = runParser(input);
    expect(output).toContain('Hello world');
  });

  it('does NOT emit anything for old flat .content field', () => {
    const input = JSON.stringify({ type: 'text', content: 'old flat content' });
    const output = runParser(input);
    expect(output).not.toContain('old flat content');
  });

  it('emits tool_use marker from .part.tool in the run_claude shape', () => {
    const input = JSON.stringify({ type: 'tool_use', part: { tool: 'read_file' } });
    const output = runParser(input);
    expect(output).toBe('\n── read_file ──\n');
  });

  it('does NOT emit tool marker from old flat .name field (regression)', () => {
    const input = JSON.stringify({ type: 'tool_use', name: 'bash', part: { tool: 'bash' } });
    const output = runParser(input);
    expect(output).toBe('\n── bash ──\n');
  });

  it('emits nothing for step_finish (regression: was emitting .result)', () => {
    const input = JSON.stringify({
      type: 'step_finish',
      part: { tokens: { input: 4096, output: 110, cache: { write: 0, read: 0 } } },
    });
    const output = runParser(input);
    expect(output.trim()).toBe('');
  });

  it('emits nothing for step_finish even with no tokens field', () => {
    const input = JSON.stringify({ type: 'step_finish', part: {} });
    const output = runParser(input);
    expect(output.trim()).toBe('');
  });

  it('emits error line with exact ❌ ERROR: prefix (defensive branch)', () => {
    const input = JSON.stringify({ type: 'error', message: 'context length exceeded' });
    const output = runParser(input);
    expect(output).toBe('\n❌ ERROR: context length exceeded\n');
  });

  it('handles missing message field in error', () => {
    const input = JSON.stringify({ type: 'error' });
    const output = runParser(input);
    expect(output).toBe('\n❌ ERROR: unknown error\n');
  });

  it('emits nothing for step_start events', () => {
    const input = JSON.stringify({
      type: 'step_start',
      part: { type: 'step-start', id: 'prt_xxx' },
    });
    const output = runParser(input);
    expect(output.trim()).toBe('');
  });

  it('emits nothing for unknown event types', () => {
    const input = JSON.stringify({ type: 'unknown_event', data: 'whatever' });
    const output = runParser(input);
    expect(output.trim()).toBe('');
  });

  it('processes opencode-run-stdout.ndjson fixture — text content emitted', () => {
    const input = fixtureContent('opencode-run-stdout.ndjson');
    const output = runParser(input);
    expect(output).toContain("I'd be happy to help!");
  });

  it('processes opencode-run-stdout.ndjson fixture — tool marker emitted for bash', () => {
    const input = fixtureContent('opencode-run-stdout.ndjson');
    const output = runParser(input);
    expect(output).toContain('\n── bash ──\n');
  });

  it('processes opencode-run-stdout.ndjson fixture — no <result> emitted', () => {
    const input = fixtureContent('opencode-run-stdout.ndjson');
    const output = runParser(input);
    expect(output).not.toContain('<result>');
  });

  it('processes opencode-run-stdout.ndjson fixture — step_finish emits no visible content', () => {
    const input = fixtureContent('opencode-run-stdout.ndjson');
    const output = runParser(input);
    // strip the text content and tool marker — remainder should be empty
    const stripped = output
      .replace(/\n── bash ──\n/, '')
      .replace(/I'd be happy[\s\S]*effectively\./, '')
      .trim();
    expect(stripped).toBe('');
  });

  it('handles multiple text events concatenated', () => {
    const input = [
      JSON.stringify({ type: 'text', part: { text: 'Hello ' } }),
      JSON.stringify({ type: 'text', part: { text: 'world' } }),
    ].join('\n');
    const output = runParser(input);
    expect(output).toBe('Hello world');
  });

  it('interleaves tool markers between text deltas', () => {
    const input = [
      JSON.stringify({ type: 'text', part: { text: 'Before' } }),
      JSON.stringify({ type: 'tool_use', part: { tool: 'list_files' } }),
      JSON.stringify({ type: 'text', part: { text: 'After' } }),
    ].join('\n');
    const output = runParser(input);
    expect(output).toBe('Before\n── list_files ──\nAfter');
  });
});
