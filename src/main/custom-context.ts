import fs from 'fs';
import path from 'path';

/** Directory within the project where custom context is stored. */
const CONTEXT_DIR = '.sandstorm/context';
const SKILLS_DIR = 'skills';
const INSTRUCTIONS_FILE = 'instructions.md';
const SETTINGS_FILE = 'settings.json';

export interface CustomContext {
  instructions: string;
  skills: string[];
  settings: string;
}

function contextDir(projectDir: string): string {
  return path.join(projectDir, CONTEXT_DIR);
}

function ensureContextDir(projectDir: string): string {
  const dir = contextDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureSkillsDir(projectDir: string): string {
  const dir = path.join(contextDir(projectDir), SKILLS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Ensure .sandstorm/context/ is gitignored.
 * Adds it to .sandstorm/.gitignore if not already present.
 */
export function ensureGitignored(projectDir: string): void {
  const sandstormDir = path.join(projectDir, '.sandstorm');
  if (!fs.existsSync(sandstormDir)) return;

  const gitignorePath = path.join(sandstormDir, '.gitignore');
  const entry = 'context/';

  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (content.split('\n').some((line) => line.trim() === entry)) return;
    fs.appendFileSync(gitignorePath, `\n${entry}\n`);
  } else {
    fs.writeFileSync(gitignorePath, `# Sandstorm local files (not committed)\n${entry}\n`);
  }
}

/** Get all custom context for a project. */
export function getCustomContext(projectDir: string): CustomContext {
  return {
    instructions: getInstructions(projectDir),
    skills: listCustomSkills(projectDir),
    settings: getCustomSettings(projectDir),
  };
}

function getInstructions(projectDir: string): string {
  const filePath = path.join(contextDir(projectDir), INSTRUCTIONS_FILE);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

export function saveCustomInstructions(projectDir: string, content: string): void {
  ensureContextDir(projectDir);
  ensureGitignored(projectDir);
  const filePath = path.join(contextDir(projectDir), INSTRUCTIONS_FILE);
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function listCustomSkills(projectDir: string): string[] {
  const dir = path.join(contextDir(projectDir), SKILLS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''));
}

export function getCustomSkill(projectDir: string, name: string): string {
  const filePath = path.join(contextDir(projectDir), SKILLS_DIR, `${name}.md`);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

export function saveCustomSkill(projectDir: string, name: string, content: string): void {
  ensureSkillsDir(projectDir);
  ensureGitignored(projectDir);
  const filePath = path.join(contextDir(projectDir), SKILLS_DIR, `${name}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function deleteCustomSkill(projectDir: string, name: string): void {
  const filePath = path.join(contextDir(projectDir), SKILLS_DIR, `${name}.md`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

export function getCustomSettings(projectDir: string): string {
  const filePath = path.join(contextDir(projectDir), SETTINGS_FILE);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

export function saveCustomSettings(projectDir: string, content: string): void {
  ensureContextDir(projectDir);
  ensureGitignored(projectDir);
  const filePath = path.join(contextDir(projectDir), SETTINGS_FILE);
  fs.writeFileSync(filePath, content, 'utf-8');
}
