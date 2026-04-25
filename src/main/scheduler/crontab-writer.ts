/**
 * Crontab writer — manages the `# BEGIN sandstorm` / `# END sandstorm` section
 * in the user's system crontab. Preserves all entries outside the managed block
 * byte-for-byte.
 */

import { execSync } from 'child_process';
import { Schedule } from './types';

const BEGIN_MARKER = '# BEGIN sandstorm — managed by Sandstorm Desktop, do not edit by hand';
const END_MARKER = '# END sandstorm';

export interface CrontabEntry {
  projectDir: string;
  projectId: string;
  schedule: Schedule;
  wrapperPath: string;
}

/**
 * Read the current user crontab. Returns the raw string content.
 * Returns empty string if no crontab exists.
 */
export function readCrontab(): string {
  try {
    return execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
  } catch {
    // `crontab -l` returns non-zero if no crontab is installed
    return '';
  }
}

/**
 * Install a new crontab from the given content string.
 */
export function installCrontab(content: string): void {
  execSync('crontab -', { input: content, encoding: 'utf-8' });
}

/**
 * Parse a crontab string and extract:
 * - before: everything before the managed block (preserved)
 * - managed: lines inside the managed block (will be replaced)
 * - after: everything after the managed block (preserved)
 */
export function parseCrontab(content: string): {
  before: string;
  managed: string[];
  after: string;
} {
  const lines = content.split('\n');
  let beginIdx = -1;
  let endIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === BEGIN_MARKER) {
      beginIdx = i;
    }
    if (lines[i] === END_MARKER) {
      endIdx = i;
    }
  }

  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    // No managed block found
    return {
      before: content,
      managed: [],
      after: '',
    };
  }

  const before = lines.slice(0, beginIdx).join('\n');
  const managed = lines.slice(beginIdx + 1, endIdx);
  const after = lines.slice(endIdx + 1).join('\n');

  return { before, managed, after };
}

/**
 * Build the managed crontab section from a list of entries.
 * Only enabled schedules produce crontab lines.
 */
export function buildManagedSection(entries: CrontabEntry[]): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry.schedule.enabled) continue;
    // Format: <cron> <wrapper-path> <project-dir> <schedule-id>    # sandstorm:<projectId>:<scheduleId>
    const tag = `# sandstorm:${entry.projectId}:${entry.schedule.id}`;
    lines.push(
      `${entry.schedule.cronExpression} ${shellQuote(entry.wrapperPath)} ${shellQuote(entry.projectDir)} ${shellQuote(entry.schedule.id)}    ${tag}`
    );
  }
  return lines;
}

/**
 * Reassemble the full crontab content from parsed parts and new managed lines.
 */
export function assembleCrontab(
  before: string,
  managedLines: string[],
  after: string
): string {
  const parts: string[] = [];

  // Preserve everything before the block
  if (before.length > 0) {
    // Ensure there's a newline before our block
    parts.push(before.endsWith('\n') ? before : before + '\n');
  }

  // Write managed block
  parts.push(BEGIN_MARKER);
  parts.push('\n');
  if (managedLines.length > 0) {
    parts.push(managedLines.join('\n'));
    parts.push('\n');
  }
  parts.push(END_MARKER);
  parts.push('\n');

  // Preserve everything after the block
  if (after.length > 0) {
    parts.push(after.endsWith('\n') ? after : after + '\n');
  }

  return parts.join('');
}

/**
 * Sync all schedules to the system crontab.
 * Reads current crontab, replaces the managed section, writes it back.
 * Entries outside the managed block are preserved byte-for-byte.
 */
export function syncCrontab(entries: CrontabEntry[]): void {
  const current = readCrontab();
  const parsed = parseCrontab(current);
  const managedLines = buildManagedSection(entries);
  const newContent = assembleCrontab(parsed.before, managedLines, parsed.after);
  installCrontab(newContent);
}

/**
 * Remove all crontab entries for a specific project.
 */
export function removeProjectFromCrontab(projectId: string): void {
  const current = readCrontab();
  const parsed = parseCrontab(current);

  // Filter out lines tagged with this project
  const filtered = parsed.managed.filter(
    (line) => !line.includes(`# sandstorm:${projectId}:`)
  );

  const newContent = assembleCrontab(parsed.before, filtered, parsed.after);
  installCrontab(newContent);
}

/**
 * Shell-quote a string for safe inclusion in a crontab line.
 * Uses single quotes with proper escaping.
 */
function shellQuote(s: string): string {
  // If no special chars, return as-is
  if (/^[a-zA-Z0-9_./-]+$/.test(s)) return s;
  // Single-quote, escaping any existing single quotes
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
