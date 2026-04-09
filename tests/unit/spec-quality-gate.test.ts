import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getDefaultSpecQualityGate,
  getSpecQualityGate,
  saveSpecQualityGate,
  isSpecQualityGateMissing,
  ensureSpecQualityGate,
} from '../../src/main/spec-quality-gate';

describe('getDefaultSpecQualityGate', () => {
  it('returns non-empty default content', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toBeTruthy();
    expect(content.length).toBeGreaterThan(100);
  });

  it('includes all required criteria sections', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('### Problem Statement');
    expect(content).toContain('### Current vs Desired Behavior');
    expect(content).toContain('### Scope Boundaries');
    expect(content).toContain('### Migration Path');
    expect(content).toContain('### Edge Cases');
    expect(content).toContain('### Ambiguity Check');
    expect(content).toContain('### Testability');
    expect(content).toContain('### Files/Areas Affected');
    expect(content).toContain('### Assumptions');
  });

  it('includes enhanced gate criteria for assumption resolution', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('### Assumptions — Zero Unresolved');
    expect(content).toContain('Assumptions are ambiguity');
    expect(content).toContain('MUST NOT pass with unresolved assumptions');
  });

  it('includes end-to-end data flow verification criterion', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('### End-to-End Data Flow Verification');
    expect(content).toContain('entire pipeline without mocks');
    expect(content).toContain('integration boundary');
  });

  it('includes dependency contracts criterion', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('### Dependency Contracts');
    expect(content).toContain('data contract must be explicit');
    expect(content).toContain('Read/write timing');
  });

  it('includes automated visual verification criterion', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('### Automated Visual Verification (UI Tickets)');
    expect(content).toContain('real running application');
    expect(content).toContain('not mocked component renders');
  });

  it('includes all-verification-automatable criterion', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('### All Verification Must Be Automatable');
    expect(content).toContain('No "manually verify"');
    expect(content).toContain('eliminate manual steps entirely');
  });

  it('starts with a markdown heading', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toMatch(/^# Spec Quality Gate/);
  });
});

describe('getSpecQualityGate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-gate-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty string when file does not exist', () => {
    expect(getSpecQualityGate(tmpDir)).toBe('');
  });

  it('returns file content when file exists', () => {
    const sandstormDir = path.join(tmpDir, '.sandstorm');
    fs.mkdirSync(sandstormDir, { recursive: true });
    fs.writeFileSync(
      path.join(sandstormDir, 'spec-quality-gate.md'),
      '# Custom Gate\n\nCustom criteria here.\n',
    );
    const result = getSpecQualityGate(tmpDir);
    expect(result).toBe('# Custom Gate\n\nCustom criteria here.\n');
  });
});

describe('saveSpecQualityGate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-gate-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the file in .sandstorm/', () => {
    fs.mkdirSync(path.join(tmpDir, '.sandstorm'), { recursive: true });
    saveSpecQualityGate(tmpDir, '# My Gate\n');
    const content = fs.readFileSync(
      path.join(tmpDir, '.sandstorm', 'spec-quality-gate.md'),
      'utf-8',
    );
    expect(content).toBe('# My Gate\n');
  });

  it('creates .sandstorm directory if it does not exist', () => {
    saveSpecQualityGate(tmpDir, '# My Gate\n');
    expect(
      fs.existsSync(path.join(tmpDir, '.sandstorm', 'spec-quality-gate.md')),
    ).toBe(true);
  });

  it('overwrites existing content', () => {
    const sandstormDir = path.join(tmpDir, '.sandstorm');
    fs.mkdirSync(sandstormDir, { recursive: true });
    fs.writeFileSync(
      path.join(sandstormDir, 'spec-quality-gate.md'),
      '# Old\n',
    );
    saveSpecQualityGate(tmpDir, '# New\n');
    const content = fs.readFileSync(
      path.join(sandstormDir, 'spec-quality-gate.md'),
      'utf-8',
    );
    expect(content).toBe('# New\n');
  });
});

describe('isSpecQualityGateMissing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-gate-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when project is not initialized', () => {
    // No .sandstorm/config means not initialized
    expect(isSpecQualityGateMissing(tmpDir)).toBe(false);
  });

  it('returns true when initialized but gate file missing', () => {
    const sandstormDir = path.join(tmpDir, '.sandstorm');
    fs.mkdirSync(sandstormDir, { recursive: true });
    fs.writeFileSync(path.join(sandstormDir, 'config'), 'PROJECT_NAME=test\n');
    expect(isSpecQualityGateMissing(tmpDir)).toBe(true);
  });

  it('returns false when initialized and gate file exists', () => {
    const sandstormDir = path.join(tmpDir, '.sandstorm');
    fs.mkdirSync(sandstormDir, { recursive: true });
    fs.writeFileSync(path.join(sandstormDir, 'config'), 'PROJECT_NAME=test\n');
    fs.writeFileSync(
      path.join(sandstormDir, 'spec-quality-gate.md'),
      '# Gate\n',
    );
    expect(isSpecQualityGateMissing(tmpDir)).toBe(false);
  });
});

describe('ensureSpecQualityGate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-gate-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates default gate file when missing in initialized project', () => {
    const sandstormDir = path.join(tmpDir, '.sandstorm');
    fs.mkdirSync(sandstormDir, { recursive: true });
    fs.writeFileSync(path.join(sandstormDir, 'config'), 'PROJECT_NAME=test\n');

    const created = ensureSpecQualityGate(tmpDir);
    expect(created).toBe(true);

    const content = fs.readFileSync(
      path.join(sandstormDir, 'spec-quality-gate.md'),
      'utf-8',
    );
    expect(content).toContain('# Spec Quality Gate');
    expect(content).toContain('### Problem Statement');
  });

  it('returns false when gate file already exists', () => {
    const sandstormDir = path.join(tmpDir, '.sandstorm');
    fs.mkdirSync(sandstormDir, { recursive: true });
    fs.writeFileSync(path.join(sandstormDir, 'config'), 'PROJECT_NAME=test\n');
    fs.writeFileSync(
      path.join(sandstormDir, 'spec-quality-gate.md'),
      '# Custom\n',
    );

    const created = ensureSpecQualityGate(tmpDir);
    expect(created).toBe(false);

    // Verify it didn't overwrite custom content
    const content = fs.readFileSync(
      path.join(sandstormDir, 'spec-quality-gate.md'),
      'utf-8',
    );
    expect(content).toBe('# Custom\n');
  });

  it('returns false when project is not initialized', () => {
    const created = ensureSpecQualityGate(tmpDir);
    expect(created).toBe(false);
  });
});

describe('init.sh generates spec-quality-gate.md', () => {
  const initPath = path.resolve(__dirname, '../../sandstorm-cli/lib/init.sh');

  it('generates .sandstorm/spec-quality-gate.md during init', () => {
    const init = fs.readFileSync(initPath, 'utf-8');
    expect(init).toContain('spec-quality-gate.md');
    expect(init).toContain('Created .sandstorm/spec-quality-gate.md');
  });

  it('includes all default criteria in the generated gate', () => {
    const init = fs.readFileSync(initPath, 'utf-8');
    expect(init).toContain('### Problem Statement');
    expect(init).toContain('### Ambiguity Check');
    expect(init).toContain('### Assumptions');
  });

  it('includes enhanced gate criteria in init.sh', () => {
    const init = fs.readFileSync(initPath, 'utf-8');
    expect(init).toContain('### Assumptions — Zero Unresolved');
    expect(init).toContain('### End-to-End Data Flow Verification');
    expect(init).toContain('### Dependency Contracts');
    expect(init).toContain('### Automated Visual Verification (UI Tickets)');
    expect(init).toContain('### All Verification Must Be Automatable');
  });
});

describe('skill files for spec quality gate', () => {
  const skillsDir = path.resolve(__dirname, '../../sandstorm-cli/skills');

  it('includes sandstorm-spec-check.md skill', () => {
    const skillPath = path.join(skillsDir, 'sandstorm-spec-check.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    const content = fs.readFileSync(skillPath, 'utf-8');
    expect(content).toContain('spec-check');
    expect(content).toContain('spec-quality-gate.md');
    expect(content).toContain('PASS');
    expect(content).toContain('FAIL');
  });

  it('includes sandstorm-spec-refine.md skill', () => {
    const skillPath = path.join(skillsDir, 'sandstorm-spec-refine.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    const content = fs.readFileSync(skillPath, 'utf-8');
    expect(content).toContain('spec-refine');
    expect(content).toContain('spec-quality-gate.md');
    expect(content).toContain('update-ticket');
  });

  it('spec-check skill includes assumption resolution phase', () => {
    const content = fs.readFileSync(
      path.join(skillsDir, 'sandstorm-spec-check.md'),
      'utf-8',
    );
    expect(content).toContain('Resolve assumptions');
    expect(content).toContain('Self-resolvable');
    expect(content).toContain('Requires human input');
    expect(content).toContain('Assumptions — Zero Unresolved');
    expect(content).toContain('End-to-End Data Flow');
    expect(content).toContain('Dependency Contracts');
    expect(content).toContain('Automated Visual Verification');
    expect(content).toContain('All Verification Automatable');
    expect(content).toContain('Questions Requiring User Answers');
  });

  it('spec-refine skill includes enhanced evaluation checks', () => {
    const content = fs.readFileSync(
      path.join(skillsDir, 'sandstorm-spec-refine.md'),
      'utf-8',
    );
    expect(content).toContain('Resolve assumptions first');
    expect(content).toContain('Self-resolvable');
    expect(content).toContain('Zero Unresolved Assumptions');
    expect(content).toContain('End-to-End Data Flow');
    expect(content).toContain('Dependency Contracts');
    expect(content).toContain('Automated Visual Verification');
    expect(content).toContain('All Verification Automatable');
    expect(content).toContain('Replace resolved assumptions with verified facts');
  });

  it('spec-check skill is user-invocable', () => {
    const content = fs.readFileSync(
      path.join(skillsDir, 'sandstorm-spec-check.md'),
      'utf-8',
    );
    expect(content).toContain('user_invocable: true');
  });

  it('spec-refine skill is user-invocable', () => {
    const content = fs.readFileSync(
      path.join(skillsDir, 'sandstorm-spec-refine.md'),
      'utf-8',
    );
    expect(content).toContain('user_invocable: true');
  });
});
