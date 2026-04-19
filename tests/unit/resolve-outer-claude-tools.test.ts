import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  resolveOuterClaudeTools,
  DEFAULT_OUTER_CLAUDE_TOOLS,
  EXPERIMENT_EXPANDED_TOOLS,
} from '../../src/main/agent/tools-allowlist';

/**
 * Pure-function tests for resolveOuterClaudeTools (#256). Uses a real temp
 * directory so there is no need to mock `fs` or `electron` — the helper
 * lives in an electron-free module on purpose.
 */
describe('resolveOuterClaudeTools (#256)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-tools-resolve-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSettings(content: string): void {
    const dir = path.join(tmpDir, '.sandstorm', 'context');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), content, 'utf-8');
  }

  it('default allowlist is exactly Bash, Read, Grep, Glob', () => {
    expect([...DEFAULT_OUTER_CLAUDE_TOOLS]).toEqual(['Bash', 'Read', 'Grep', 'Glob']);
  });

  it('returns the default allowlist when no projectDir is provided', () => {
    expect(resolveOuterClaudeTools()).toEqual([...DEFAULT_OUTER_CLAUDE_TOOLS]);
  });

  it('returns defaults when the project has no .sandstorm/context/settings.json', () => {
    expect(resolveOuterClaudeTools(tmpDir)).toEqual([...DEFAULT_OUTER_CLAUDE_TOOLS]);
  });

  it('returns the override when settings.json has a valid outerClaudeTools array', () => {
    writeSettings(JSON.stringify({ outerClaudeTools: ['Bash', 'Read'] }));
    expect(resolveOuterClaudeTools(tmpDir)).toEqual(['Bash', 'Read']);
  });

  it('returns the override with a single tool', () => {
    writeSettings(JSON.stringify({ outerClaudeTools: ['Bash'] }));
    expect(resolveOuterClaudeTools(tmpDir)).toEqual(['Bash']);
  });

  it('falls back to defaults when settings.json is malformed JSON', () => {
    writeSettings('{ not valid json');
    expect(resolveOuterClaudeTools(tmpDir)).toEqual([...DEFAULT_OUTER_CLAUDE_TOOLS]);
  });

  it('falls back to defaults when outerClaudeTools is not an array', () => {
    writeSettings(JSON.stringify({ outerClaudeTools: 'Bash,Read' }));
    expect(resolveOuterClaudeTools(tmpDir)).toEqual([...DEFAULT_OUTER_CLAUDE_TOOLS]);
  });

  it('falls back to defaults when outerClaudeTools is an empty array', () => {
    writeSettings(JSON.stringify({ outerClaudeTools: [] }));
    expect(resolveOuterClaudeTools(tmpDir)).toEqual([...DEFAULT_OUTER_CLAUDE_TOOLS]);
  });

  it('falls back to defaults when outerClaudeTools contains non-string entries', () => {
    writeSettings(JSON.stringify({ outerClaudeTools: ['Bash', 42, null] }));
    expect(resolveOuterClaudeTools(tmpDir)).toEqual([...DEFAULT_OUTER_CLAUDE_TOOLS]);
  });

  it('falls back to defaults when outerClaudeTools contains empty strings', () => {
    writeSettings(JSON.stringify({ outerClaudeTools: ['Bash', ''] }));
    expect(resolveOuterClaudeTools(tmpDir)).toEqual([...DEFAULT_OUTER_CLAUDE_TOOLS]);
  });

  it('falls back to defaults when settings.json has no outerClaudeTools key', () => {
    writeSettings(JSON.stringify({ unrelated: 'value' }));
    expect(resolveOuterClaudeTools(tmpDir)).toEqual([...DEFAULT_OUTER_CLAUDE_TOOLS]);
  });

  it('default list is frozen so the exported reference cannot be mutated', () => {
    expect(Object.isFrozen(DEFAULT_OUTER_CLAUDE_TOOLS)).toBe(true);
  });

  it('returns a new array each call (callers may mutate the result without side-effects)', () => {
    const a = resolveOuterClaudeTools();
    const b = resolveOuterClaudeTools();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(() => a.push('X')).not.toThrow();
  });

  it('SANDSTORM_EXP_ENABLE_AGENT=1 returns the expanded experiment allowlist', () => {
    const env = { SANDSTORM_EXP_ENABLE_AGENT: '1' } as NodeJS.ProcessEnv;
    expect(resolveOuterClaudeTools(tmpDir, env)).toEqual([
      ...EXPERIMENT_EXPANDED_TOOLS,
    ]);
  });

  it('SANDSTORM_EXP_ENABLE_AGENT=1 overrides a project-settings override', () => {
    writeSettings(JSON.stringify({ outerClaudeTools: ['Bash', 'Read'] }));
    const env = { SANDSTORM_EXP_ENABLE_AGENT: '1' } as NodeJS.ProcessEnv;
    expect(resolveOuterClaudeTools(tmpDir, env)).toEqual([
      ...EXPERIMENT_EXPANDED_TOOLS,
    ]);
  });

  it('SANDSTORM_EXP_ENABLE_AGENT set to anything other than "1" falls back to defaults', () => {
    for (const value of ['0', 'true', 'yes', '']) {
      const env = { SANDSTORM_EXP_ENABLE_AGENT: value } as NodeJS.ProcessEnv;
      expect(resolveOuterClaudeTools(undefined, env)).toEqual([
        ...DEFAULT_OUTER_CLAUDE_TOOLS,
      ]);
    }
  });

  it('expanded allowlist contains Agent and Task*', () => {
    for (const name of ['Agent', 'Task', 'TaskCreate', 'TaskUpdate']) {
      expect(EXPERIMENT_EXPANDED_TOOLS).toContain(name);
    }
    // Still keeps the basic tools
    for (const name of ['Bash', 'Read', 'Grep', 'Glob']) {
      expect(EXPERIMENT_EXPANDED_TOOLS).toContain(name);
    }
  });
});
