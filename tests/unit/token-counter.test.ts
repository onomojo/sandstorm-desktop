/**
 * Integration tests for sandstorm-cli/docker/token-counter.sh
 *
 * Pipes mock Claude CLI stream-json output through the script and verifies
 * that partial entries appear for intermediate events and final entries
 * are written for result events.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const SCRIPT = resolve(__dirname, '../../sandstorm-cli/docker/token-counter.sh');

function runScript(input: string, args: string[] = []): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'token-counter-test-'));
  const outputFile = join(tmpDir, 'tokens.jsonl');

  try {
    // Ensure input ends with newline so bash `read` processes the last line
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

describe('token-counter.sh', () => {
  it('writes nothing for empty input', () => {
    const output = runScript('');
    expect(output.trim()).toBe('');
  });

  it('writes nothing for non-token events', () => {
    const input = [
      JSON.stringify({ type: 'content_block_delta', delta: { text: 'hello' } }),
      JSON.stringify({ type: 'content_block_stop' }),
    ].join('\n');
    const output = runScript(input);
    expect(output.trim()).toBe('');
  });

  it('captures message_start as partial entry with input tokens', () => {
    const input = JSON.stringify({
      type: 'message_start',
      message: { usage: { input_tokens: 2000, output_tokens: 0 } },
    });
    const output = runScript(input);
    const lines = parseLines(output);
    expect(lines).toHaveLength(1);
    expect(lines[0].in).toBe(2000);
    expect(lines[0].out).toBe(0);
    expect(lines[0].partial).toBe(true);
  });

  it('captures message_delta as partial entry with output tokens', () => {
    const input = [
      JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1500 } } }),
      JSON.stringify({ type: 'message_delta', usage: { output_tokens: 300 } }),
    ].join('\n');
    const output = runScript(input);
    const lines = parseLines(output);
    // message_start partial + message_delta partial
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const delta = lines.find((l) => l.out === 300 && l.partial === true);
    expect(delta).toBeDefined();
    expect(delta!.in).toBe(1500); // carries current_input from message_start
  });

  it('captures result as final (non-partial) entry', () => {
    const input = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 1500, output_tokens: 800 },
    });
    const output = runScript(input);
    const lines = parseLines(output);
    expect(lines).toHaveLength(1);
    expect(lines[0].in).toBe(1500);
    expect(lines[0].out).toBe(800);
    expect(lines[0].partial).toBeUndefined();
  });

  it('writes partial entries before final result in a full turn sequence', () => {
    const input = [
      JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 2000 } } }),
      JSON.stringify({ type: 'content_block_delta', delta: { text: 'thinking...' } }),
      JSON.stringify({ type: 'message_delta', usage: { output_tokens: 150 } }),
      JSON.stringify({ type: 'message_delta', usage: { output_tokens: 400 } }),
      JSON.stringify({ type: 'result', usage: { input_tokens: 2000, output_tokens: 400 } }),
    ].join('\n');
    const output = runScript(input);
    const lines = parseLines(output);

    const partials = lines.filter((l) => l.partial === true);
    const finals = lines.filter((l) => !l.partial);

    // Partial entries must appear before the final result
    expect(partials.length).toBeGreaterThan(0);
    expect(finals).toHaveLength(1);
    expect(finals[0].in).toBe(2000);
    expect(finals[0].out).toBe(400);

    // First partial line index must be before the final line index
    const firstPartialIdx = lines.findIndex((l) => l.partial === true);
    const finalIdx = lines.findIndex((l) => !l.partial);
    expect(firstPartialIdx).toBeLessThan(finalIdx);
  });

  it('includes iter and phase metadata when provided', () => {
    const input = JSON.stringify({
      type: 'message_start',
      message: { usage: { input_tokens: 500 } },
    });
    const output = runScript(input, ['2', 'execution']);
    const lines = parseLines(output);
    expect(lines[0].iter).toBe(2);
    expect(lines[0].phase).toBe('execution');
    expect(lines[0].partial).toBe(true);
  });

  it('result entry includes iter and phase metadata', () => {
    const input = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    const output = runScript(input, ['1', 'review']);
    const lines = parseLines(output);
    expect(lines[0].iter).toBe(1);
    expect(lines[0].phase).toBe('review');
    expect(lines[0].partial).toBeUndefined();
  });

  it('handles stream_event wrapped message_start', () => {
    const input = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { usage: { input_tokens: 3000, output_tokens: 0 } },
      },
    });
    const output = runScript(input);
    const lines = parseLines(output);
    expect(lines).toHaveLength(1);
    expect(lines[0].in).toBe(3000);
    expect(lines[0].partial).toBe(true);
  });

  it('handles stream_event wrapped message_delta', () => {
    const input = [
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { usage: { input_tokens: 1000 } } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_delta', usage: { output_tokens: 200 } },
      }),
    ].join('\n');
    const output = runScript(input);
    const lines = parseLines(output);
    const delta = lines.find((l) => l.out === 200 && l.partial === true);
    expect(delta).toBeDefined();
    expect(delta!.in).toBe(1000);
  });

  it('skips message_start with zero input tokens', () => {
    const input = JSON.stringify({
      type: 'message_start',
      message: { usage: { input_tokens: 0 } },
    });
    const output = runScript(input);
    expect(output.trim()).toBe('');
  });

  it('does not write partial for result (no double-counting)', () => {
    // Sequence: partial entries then result — result should NOT have partial:true
    const input = [
      JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 800 } } }),
      JSON.stringify({ type: 'message_delta', usage: { output_tokens: 300 } }),
      JSON.stringify({ type: 'result', usage: { input_tokens: 800, output_tokens: 300 } }),
    ].join('\n');
    const output = runScript(input);
    const lines = parseLines(output);
    const resultLine = lines.find((l) => !l.partial);
    expect(resultLine).toBeDefined();
    expect(resultLine!.partial).toBeUndefined();
  });

  it('handles multiple API turns sequentially', () => {
    // Turn 1 complete, Turn 2 complete
    const input = [
      JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 500 } } }),
      JSON.stringify({ type: 'result', usage: { input_tokens: 500, output_tokens: 200 } }),
      JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 600 } } }),
      JSON.stringify({ type: 'result', usage: { input_tokens: 600, output_tokens: 250 } }),
    ].join('\n');
    const output = runScript(input, ['1', 'execution']);
    const lines = parseLines(output);
    const finals = lines.filter((l) => !l.partial);
    expect(finals).toHaveLength(2);
    expect(finals[0].in).toBe(500);
    expect(finals[1].in).toBe(600);
  });
});
