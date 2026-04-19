import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  enumerateProjectSkills,
  formatSkillsSection,
  composeSystemPromptWithSkills,
} from '../../src/main/agent/skill-enumeration';

/**
 * Pure tests for the orchestrator skill enumerator (#266). Writes real
 * SKILL.md fixtures to a temp directory so we exercise the same fs
 * paths as production without mocking.
 */
describe('enumerateProjectSkills (#266)', () => {
  let tmpDir: string;
  let skillsRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-skill-enum-'));
    skillsRoot = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(skillsRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSkill(name: string, frontmatter: string, body = '# body\n'): void {
    const dir = path.join(skillsRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}`, 'utf-8');
  }

  it('returns an empty list when projectDir has no .claude/skills', () => {
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-skill-bare-'));
    try {
      expect(enumerateProjectSkills(bareDir)).toEqual([]);
    } finally {
      fs.rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it('enumerates a single folder-pattern skill', () => {
    writeSkill('alpha', 'name: alpha\ndescription: Alpha description');
    const skills = enumerateProjectSkills(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('alpha');
    expect(skills[0].description).toBe('Alpha description');
    expect(skills[0].path.endsWith(path.join('alpha', 'SKILL.md'))).toBe(true);
  });

  it('returns skills sorted alphabetically by name for deterministic output', () => {
    writeSkill('zulu', 'name: zulu\ndescription: Last');
    writeSkill('alpha', 'name: alpha\ndescription: First');
    writeSkill('mike', 'name: mike\ndescription: Middle');
    const skills = enumerateProjectSkills(tmpDir);
    expect(skills.map((s) => s.name)).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('parses double-quoted description values', () => {
    writeSkill('quoted', 'name: quoted\ndescription: "Use this when X happens: say Y."');
    const [skill] = enumerateProjectSkills(tmpDir);
    expect(skill.description).toBe('Use this when X happens: say Y.');
  });

  it('parses single-quoted description values', () => {
    writeSkill('sq', "name: sq\ndescription: 'Single-quoted value'");
    const [skill] = enumerateProjectSkills(tmpDir);
    expect(skill.description).toBe('Single-quoted value');
  });

  it('skips skills missing either name or description', () => {
    writeSkill('nameonly', 'name: nameonly');
    writeSkill('descronly', 'description: lone description');
    writeSkill('valid', 'name: valid\ndescription: Valid');
    const skills = enumerateProjectSkills(tmpDir);
    expect(skills.map((s) => s.name)).toEqual(['valid']);
  });

  it('skips folders without a SKILL.md file', () => {
    fs.mkdirSync(path.join(skillsRoot, 'empty-folder'), { recursive: true });
    writeSkill('has-skill', 'name: has-skill\ndescription: ok');
    const skills = enumerateProjectSkills(tmpDir);
    expect(skills.map((s) => s.name)).toEqual(['has-skill']);
  });

  it('skips skills with malformed frontmatter (no delimiters)', () => {
    const dir = path.join(skillsRoot, 'broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'name: broken\ndescription: no-dashes', 'utf-8');
    writeSkill('good', 'name: good\ndescription: ok');
    const skills = enumerateProjectSkills(tmpDir);
    expect(skills.map((s) => s.name)).toEqual(['good']);
  });

  it('ignores loose .md files directly under .claude/skills/ (folder pattern only)', () => {
    fs.writeFileSync(
      path.join(skillsRoot, 'flat.md'),
      '---\nname: flat\ndescription: Ignored\n---\n',
      'utf-8'
    );
    writeSkill('folder', 'name: folder\ndescription: Picked up');
    const skills = enumerateProjectSkills(tmpDir);
    expect(skills.map((s) => s.name)).toEqual(['folder']);
  });
});

describe('formatSkillsSection (#266)', () => {
  it('returns an empty string for an empty skill list', () => {
    expect(formatSkillsSection([])).toBe('');
  });

  it('formats one skill as a bullet with name and description', () => {
    const section = formatSkillsSection([
      { name: 'alpha', description: 'do alpha', path: '/x/alpha/SKILL.md' },
    ]);
    expect(section).toContain('## Available Skills');
    expect(section).toContain('The following skills are available for use with the Skill tool:');
    expect(section).toContain('- alpha: do alpha');
  });

  it('formats multiple skills in the given order', () => {
    const section = formatSkillsSection([
      { name: 'alpha', description: 'A', path: '/a' },
      { name: 'beta', description: 'B', path: '/b' },
    ]);
    const alphaIdx = section.indexOf('- alpha:');
    const betaIdx = section.indexOf('- beta:');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(betaIdx).toBeGreaterThan(alphaIdx);
  });
});

describe('composeSystemPromptWithSkills (#266)', () => {
  let tmpDir: string;
  let skillsRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-skill-compose-'));
    skillsRoot = path.join(tmpDir, '.claude', 'skills');
    fs.mkdirSync(skillsRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSkill(name: string, description: string): void {
    const dir = path.join(skillsRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`,
      'utf-8'
    );
  }

  it('returns the base prompt unchanged when no skills are present', () => {
    const base = '# Orchestrator\n\nDo orchestrator things.\n';
    expect(composeSystemPromptWithSkills(base, tmpDir)).toBe(base);
  });

  it('appends an Available Skills section when skills exist', () => {
    writeSkill('sandstorm', 'Manage stacks');
    const base = '# Orchestrator\n';
    const composed = composeSystemPromptWithSkills(base, tmpDir);
    expect(composed.startsWith(base)).toBe(true);
    expect(composed).toContain('## Available Skills');
    expect(composed).toContain('- sandstorm: Manage stacks');
  });

  it('adds a blank line separator when the base does not end with a newline', () => {
    writeSkill('x', 'desc');
    const base = '# Orchestrator';
    const composed = composeSystemPromptWithSkills(base, tmpDir);
    expect(composed).toContain('Orchestrator\n\n## Available Skills');
  });

  it('adds a single newline separator when the base already ends with a newline', () => {
    writeSkill('x', 'desc');
    const base = '# Orchestrator\n';
    const composed = composeSystemPromptWithSkills(base, tmpDir);
    expect(composed).toContain('Orchestrator\n\n## Available Skills');
    // But not three newlines in a row
    expect(composed).not.toContain('\n\n\n## Available Skills');
  });

  it('orders skills deterministically (alphabetical) regardless of fs order', () => {
    writeSkill('zeta', 'last');
    writeSkill('alpha', 'first');
    writeSkill('mu', 'middle');
    const composed = composeSystemPromptWithSkills('base', tmpDir);
    const idxA = composed.indexOf('alpha');
    const idxM = composed.indexOf('mu');
    const idxZ = composed.indexOf('zeta');
    expect(idxA).toBeLessThan(idxM);
    expect(idxM).toBeLessThan(idxZ);
  });
});
