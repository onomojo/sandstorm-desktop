import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Tests for the orchestration boundary documentation (GitHub issue #22).
 *
 * Verifies that CLAUDE.md contains the outer/inner Claude boundary section
 * with all critical rules clearly documented.
 */

describe('CLAUDE.md orchestration boundary section', () => {
  const claudeMd = fs.readFileSync(
    path.join(__dirname, '../../CLAUDE.md'),
    'utf-8'
  );

  it('contains the orchestration boundary heading', () => {
    expect(claudeMd).toContain('## Outer Claude vs Inner Claude — Orchestration Boundary');
  });

  it('marks the rule as critical', () => {
    expect(claudeMd).toContain('CRITICAL ARCHITECTURAL RULE');
  });

  it('defines outer Claude as orchestrator that never edits source code', () => {
    expect(claudeMd).toContain('Outer Claude = Orchestrator');
    expect(claudeMd).toContain('NEVER edits source code directly');
  });

  it('defines inner Claude as worker inside a stack container', () => {
    expect(claudeMd).toContain('Inner Claude = Worker');
    expect(claudeMd).toContain('isolated Docker container');
  });

  it('lists the only files outer Claude may modify', () => {
    expect(claudeMd).toContain('CLAUDE.md');
    expect(claudeMd).toContain('.claude/');
    expect(claudeMd).toContain('.sandstorm/');
    expect(claudeMd).toContain('Memory files');
  });

  it('lists paths that must go through a stack', () => {
    expect(claudeMd).toContain('src/**');
    expect(claudeMd).toContain('tests/**');
    expect(claudeMd).toContain('package.json');
  });

  it('states the no-exceptions rule', () => {
    expect(claudeMd).toContain('it goes through a stack. No exceptions.');
  });
});
