/**
 * Pure, electron-free helpers for parsing ephemeral agent stream-json events.
 *
 * extractStreamEvents walks a parsed stream-json record and returns an ordered
 * list of EphemeralStreamEvent values — one per text block and one per
 * tool_use block in the assistant message content.
 *
 * Tests import this module directly without needing vi.mock('electron').
 */

import type { EphemeralStreamEvent } from './types';

export { type EphemeralStreamEvent };

const TOOL_SUMMARY_MAX = 120;

/**
 * Build a compact single-line summary string from a tool_use input object.
 * Capped at TOOL_SUMMARY_MAX chars with an ellipsis if truncated.
 */
export function formatToolSummary(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return `${name}()`;

  const parts: string[] = [];
  if (name === 'Read' || name === 'Write') {
    const p = input.file_path ?? input.path;
    if (p != null) parts.push(String(p));
  } else if (name === 'Grep') {
    const pat = input.pattern;
    if (pat != null) parts.push(JSON.stringify(String(pat)));
    const loc = input.path ?? input.glob;
    if (loc != null) parts.push(`path=${String(loc)}`);
  } else if (name === 'Glob') {
    const pat = input.pattern;
    if (pat != null) parts.push(String(pat));
  } else if (name === 'Bash') {
    const cmd = input.command;
    if (cmd != null) parts.push(String(cmd).replace(/\n/g, ' ').trim());
  } else if (name === 'Edit') {
    const p = input.file_path ?? input.path;
    if (p != null) parts.push(String(p));
  } else {
    const first = Object.values(input).find((v) => typeof v === 'string');
    if (first != null) parts.push(first as string);
  }

  const raw = parts.length > 0 ? `${name}(${parts.join(', ')})` : `${name}()`;
  const singleLine = raw.replace(/\n/g, ' ');
  return singleLine.length <= TOOL_SUMMARY_MAX
    ? singleLine
    : singleLine.slice(0, TOOL_SUMMARY_MAX - 1) + '…';
}

/**
 * Walk a parsed stream-json record and return an ordered list of
 * EphemeralStreamEvent entries — one per text block and one per tool_use
 * block in the assistant message content. Also handles content_block_delta
 * text for streaming prose.
 *
 * Interleaved text + tool_use blocks in one assistant message are emitted
 * in source order so the caller sees prose → tool indicator → prose as the
 * model actually produced it.
 */
export function extractStreamEvents(parsed: Record<string, unknown>): EphemeralStreamEvent[] {
  const events: EphemeralStreamEvent[] = [];

  if (parsed.type === 'assistant') {
    const msg = parsed.message as Record<string, unknown> | undefined;
    if (msg?.content && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && block.text) {
          events.push({ kind: 'text', delta: block.text as string });
        } else if (block.type === 'tool_use') {
          const name = typeof block.name === 'string' ? block.name : '?';
          const input = block.input as Record<string, unknown> | undefined;
          events.push({ kind: 'tool_use', name, summary: formatToolSummary(name, input) });
        }
      }
    }
  }

  if (parsed.type === 'content_block_delta') {
    const delta = parsed.delta as Record<string, unknown> | undefined;
    if (delta?.text) {
      events.push({ kind: 'text', delta: delta.text as string });
    }
  }

  return events;
}
