/**
 * Unit tests for extractStreamEvents and formatToolSummary.
 * This module is electron-free — no vi.mock('electron') needed.
 */
import { describe, it, expect } from 'vitest';
import {
  extractStreamEvents,
  formatToolSummary,
} from '../../src/main/agent/ephemeral-stream-events';
import type { EphemeralStreamEvent } from '../../src/main/agent/ephemeral-stream-events';

// ---------------------------------------------------------------------------
// extractStreamEvents
// ---------------------------------------------------------------------------

describe('extractStreamEvents', () => {
  it('returns [] for non-assistant, non-delta record types', () => {
    expect(extractStreamEvents({ type: 'system' })).toEqual([]);
    expect(extractStreamEvents({ type: 'result' })).toEqual([]);
    expect(extractStreamEvents({ type: 'message_start' })).toEqual([]);
    expect(extractStreamEvents({ type: 'user' })).toEqual([]);
  });

  it('returns text event from a content_block_delta', () => {
    const parsed = { type: 'content_block_delta', delta: { text: 'hello' } };
    expect(extractStreamEvents(parsed)).toEqual([{ kind: 'text', delta: 'hello' }]);
  });

  it('returns nothing for content_block_delta with no text', () => {
    const parsed = { type: 'content_block_delta', delta: { type: 'input_json_delta' } };
    expect(extractStreamEvents(parsed)).toEqual([]);
  });

  it('returns text event from assistant message with text block', () => {
    const parsed = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'I will read the file.' }],
      },
    };
    expect(extractStreamEvents(parsed)).toEqual([
      { kind: 'text', delta: 'I will read the file.' },
    ]);
  });

  it('returns tool_use event from assistant message with tool_use block', () => {
    const parsed = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/main/foo.ts' } },
        ],
      },
    };
    const events = extractStreamEvents(parsed);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'tool_use', name: 'Read' });
    expect((events[0] as { summary: string }).summary).toContain('src/main/foo.ts');
  });

  it('emits events in source order for interleaved text + tool_use blocks', () => {
    const parsed = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check the file.' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/foo.ts' } },
          { type: 'text', text: ' Done.' },
        ],
      },
    };
    const events = extractStreamEvents(parsed);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ kind: 'text', delta: 'Let me check the file.' });
    expect(events[1]).toMatchObject({ kind: 'tool_use', name: 'Read' });
    expect(events[2]).toEqual({ kind: 'text', delta: ' Done.' });
  });

  it('returns multiple tool_use events in order', () => {
    const parsed = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'tool_use', id: 'tu_2', name: 'Grep', input: { pattern: 'foo' } },
        ],
      },
    };
    const events = extractStreamEvents(parsed);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'tool_use', name: 'Read' });
    expect(events[1]).toMatchObject({ kind: 'tool_use', name: 'Grep' });
  });

  it('handles assistant message with no content gracefully', () => {
    const parsed = { type: 'assistant', message: { content: [] } };
    expect(extractStreamEvents(parsed)).toEqual([]);
  });

  it('handles assistant message with missing message field', () => {
    const parsed = { type: 'assistant' };
    expect(extractStreamEvents(parsed)).toEqual([]);
  });

  it('uses "?" as name when tool_use block has no name field', () => {
    const parsed = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tu_1', input: {} }],
      },
    };
    const events = extractStreamEvents(parsed);
    expect(events[0]).toMatchObject({ kind: 'tool_use', name: '?' });
  });

  it('skips blocks with unknown type', () => {
    const parsed = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'result' },
        ],
      },
    };
    const events = extractStreamEvents(parsed);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ kind: 'text', delta: 'result' });
  });
});

// ---------------------------------------------------------------------------
// formatToolSummary
// ---------------------------------------------------------------------------

describe('formatToolSummary', () => {
  it('formats Read with file_path', () => {
    expect(formatToolSummary('Read', { file_path: 'src/main/foo.ts' })).toBe('Read(src/main/foo.ts)');
  });

  it('formats Write with file_path', () => {
    expect(formatToolSummary('Write', { file_path: 'out/bar.js' })).toBe('Write(out/bar.js)');
  });

  it('formats Edit with file_path', () => {
    expect(formatToolSummary('Edit', { file_path: 'src/x.ts' })).toBe('Edit(src/x.ts)');
  });

  it('formats Grep with pattern and path', () => {
    expect(formatToolSummary('Grep', { pattern: 'spawnEphemeral', path: 'src/' })).toBe(
      'Grep("spawnEphemeral", path=src/)',
    );
  });

  it('formats Grep with pattern only', () => {
    expect(formatToolSummary('Grep', { pattern: 'foo' })).toBe('Grep("foo")');
  });

  it('formats Glob with pattern', () => {
    expect(formatToolSummary('Glob', { pattern: 'src/**/*.ts' })).toBe('Glob(src/**/*.ts)');
  });

  it('formats Bash with command', () => {
    expect(formatToolSummary('Bash', { command: 'npm test' })).toBe('Bash(npm test)');
  });

  it('collapses newlines in Bash commands to a single line', () => {
    expect(formatToolSummary('Bash', { command: 'cd /app\nnpm test' })).toBe(
      'Bash(cd /app npm test)',
    );
  });

  it('falls back to first string value for unknown tools', () => {
    expect(formatToolSummary('CustomTool', { target: 'src/x.ts' })).toBe('CustomTool(src/x.ts)');
  });

  it('returns name() when input is undefined', () => {
    expect(formatToolSummary('Read', undefined)).toBe('Read()');
  });

  it('returns name() when input is empty', () => {
    expect(formatToolSummary('Read', {})).toBe('Read()');
  });

  it('truncates to 120 chars with ellipsis', () => {
    const longPath = 'a'.repeat(130);
    const result = formatToolSummary('Read', { file_path: longPath });
    expect(result.length).toBe(120);
    expect(result.endsWith('…')).toBe(true);
  });

  it('does not truncate summaries exactly at 120 chars', () => {
    // "Read(" = 5 chars, ")" = 1 char, so path can be 114 chars to hit 120 exactly
    const path = 'a'.repeat(114);
    const result = formatToolSummary('Read', { file_path: path });
    expect(result.length).toBe(120);
    expect(result.endsWith('…')).toBe(false);
  });
});
