/**
 * Skill enumeration for the orchestrator subprocess (#266).
 *
 * Claude Code injects an "Available Skills" system-reminder into its
 * DEFAULT system prompt. The orchestrator passes `--system-prompt-file
 * SANDSTORM_OUTER.md`, which REPLACES that default — so the reminder
 * vanishes and skills become invisible to the model (even though the
 * CLI still registers them).
 *
 * This module enumerates project-local skills at spawn time and formats
 * them as an injection block that `ensureProcess` appends to the
 * base system prompt. Pure/electron-free so it can be unit-tested
 * against a real temp directory without mocks.
 */

import fs from 'fs';
import path from 'path';

export interface SkillDescriptor {
  name: string;
  description: string;
  path: string;
}

/** Parse minimal YAML frontmatter looking for `name` and `description`. */
function parseFrontmatter(content: string): { name?: string; description?: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const body = match[1];
  const out: { name?: string; description?: string } = {};
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^(name|description)\s*:\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1] as 'name' | 'description';
    let raw = kv[2].trim();
    // Handle quoted single-line values.
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      raw = raw.slice(1, -1);
    } else if (raw.startsWith('"')) {
      // Multi-line double-quoted value: consume until closing quote.
      let acc = raw.slice(1);
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (next.endsWith('"')) {
          acc += '\n' + next.slice(0, -1);
          break;
        }
        acc += '\n' + next;
        i++;
      }
      raw = acc;
    }
    out[key] = raw;
    i++;
  }
  return out;
}

/**
 * Enumerate folder-pattern skills under a given directory. Each
 * `<skillsRoot>/<name>/SKILL.md` with valid `name` + `description`
 * frontmatter is returned; anything else is silently skipped.
 */
export function enumerateSkillsFromDir(skillsRoot: string): SkillDescriptor[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const descriptors: SkillDescriptor[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsRoot, entry.name, 'SKILL.md');
    let content: string;
    try {
      content = fs.readFileSync(skillPath, 'utf-8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(content);
    if (!fm || !fm.name || !fm.description) continue;
    descriptors.push({ name: fm.name, description: fm.description, path: skillPath });
  }
  return descriptors;
}

/**
 * Enumerate project-level skills at `<projectDir>/.claude/skills/`.
 * Kept for back-compat; prefer `enumerateSkills` which also includes
 * the Sandstorm-bundled skills.
 */
export function enumerateProjectSkills(projectDir: string): SkillDescriptor[] {
  const skills = enumerateSkillsFromDir(path.join(projectDir, '.claude', 'skills'));
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Enumerate skills from the Sandstorm-bundled skills dir and the
 * project's `.claude/skills/` merged together. On name collisions the
 * project skill wins (mirrors Claude Code's project > bundled
 * precedence). Results sorted by name for deterministic output.
 */
export function enumerateSkills(options: {
  projectDir?: string;
  bundledSkillsDir?: string;
}): SkillDescriptor[] {
  const bundled = options.bundledSkillsDir ? enumerateSkillsFromDir(options.bundledSkillsDir) : [];
  const project = options.projectDir
    ? enumerateSkillsFromDir(path.join(options.projectDir, '.claude', 'skills'))
    : [];
  const byName = new Map<string, SkillDescriptor>();
  for (const skill of bundled) byName.set(skill.name, skill);
  for (const skill of project) byName.set(skill.name, skill); // project overrides bundled
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Format the injection block. Mirrors the shape of Claude Code's
 * default system-reminder so the model recognizes the pattern.
 */
export function formatSkillsSection(skills: SkillDescriptor[]): string {
  if (skills.length === 0) return '';
  const lines = ['## Available Skills', '', 'The following skills are available for use with the Skill tool:', ''];
  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${skill.description}`);
  }
  return lines.join('\n');
}

/**
 * Compose a full system prompt: base text, then the skills section if
 * any skills are present. Merges Sandstorm-bundled skills with the
 * project's `.claude/skills/` (project wins on name collisions).
 * Returns the base unchanged when there are no registered skills.
 */
export function composeSystemPromptWithSkills(
  basePrompt: string,
  projectDir: string,
  bundledSkillsDir?: string
): string {
  const skills = enumerateSkills({ projectDir, bundledSkillsDir });
  const section = formatSkillsSection(skills);
  if (!section) return basePrompt;
  const separator = basePrompt.endsWith('\n') ? '\n' : '\n\n';
  return `${basePrompt}${separator}${section}\n`;
}
