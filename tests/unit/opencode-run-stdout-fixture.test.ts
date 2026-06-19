/**
 * Shape-enforcing test for tests/unit/fixtures/opencode-run-stdout.ndjson
 *
 * Asserts valid JSON-lines and that the fixture contains the required event
 * types with the verified real schema (.part.* nesting, opencode-ai@1.17.7).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const FIXTURE = resolve(__dirname, 'fixtures/opencode-run-stdout.ndjson');

function loadLines(): Record<string, unknown>[] {
  const raw = readFileSync(FIXTURE, 'utf-8');
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe('opencode-run-stdout.ndjson fixture shape', () => {
  it('is valid JSON-lines (every non-empty line parses)', () => {
    expect(() => loadLines()).not.toThrow();
  });

  it('has exactly 6 lines', () => {
    expect(loadLines()).toHaveLength(6);
  });

  it('contains ≥1 text line', () => {
    const lines = loadLines();
    expect(lines.filter((l) => l.type === 'text').length).toBeGreaterThanOrEqual(1);
  });

  it('contains ≥1 tool_use line', () => {
    const lines = loadLines();
    expect(lines.filter((l) => l.type === 'tool_use').length).toBeGreaterThanOrEqual(1);
  });

  it('contains ≥1 step_finish line', () => {
    const lines = loadLines();
    expect(lines.filter((l) => l.type === 'step_finish').length).toBeGreaterThanOrEqual(1);
  });

  it('step_finish lines carry .part.tokens.input and .part.tokens.output', () => {
    const lines = loadLines();
    const finishLines = lines.filter((l) => l.type === 'step_finish');
    for (const line of finishLines) {
      const part = line.part as Record<string, unknown>;
      const tokens = part.tokens as Record<string, unknown>;
      expect(typeof tokens.input).toBe('number');
      expect(typeof tokens.output).toBe('number');
    }
  });

  it('step_finish lines carry .part.tokens.cache.write and .part.tokens.cache.read', () => {
    const lines = loadLines();
    const finishLines = lines.filter((l) => l.type === 'step_finish');
    for (const line of finishLines) {
      const part = line.part as Record<string, unknown>;
      const tokens = part.tokens as Record<string, unknown>;
      const cache = tokens.cache as Record<string, unknown>;
      expect(typeof cache.write).toBe('number');
      expect(typeof cache.read).toBe('number');
    }
  });

  it('text lines carry .part.text (not .content)', () => {
    const lines = loadLines();
    const textLines = lines.filter((l) => l.type === 'text');
    for (const line of textLines) {
      const part = line.part as Record<string, unknown>;
      expect(typeof part.text).toBe('string');
      expect(part).not.toHaveProperty('content');
    }
  });

  it('tool_use lines carry .part.tool (not .name)', () => {
    const lines = loadLines();
    const toolLines = lines.filter((l) => l.type === 'tool_use');
    for (const line of toolLines) {
      const part = line.part as Record<string, unknown>;
      expect(typeof part.tool).toBe('string');
      expect(part).not.toHaveProperty('name');
    }
  });

  it('step_finish lines have no .result field', () => {
    const lines = loadLines();
    const finishLines = lines.filter((l) => l.type === 'step_finish');
    for (const line of finishLines) {
      expect(line).not.toHaveProperty('result');
      const part = line.part as Record<string, unknown>;
      expect(part).not.toHaveProperty('result');
    }
  });
});
