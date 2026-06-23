/**
 * T8 — Architecture test: TaskLifecycleManager is the sole caller of raw
 * registry lifecycle transition methods.
 *
 * Scans every TypeScript source file under src/ and asserts that only
 * task-lifecycle-manager.ts (and registry.ts itself) contain direct calls to
 * the following raw Registry lifecycle methods:
 *
 *   registry.updateStackStatus(
 *   registry.completeTask(
 *   registry.completeTaskNeedsHuman(
 *   registry.completeTaskNeedsKey(
 *   registry.completeTaskVerifyBlockedEnvironmental(
 *   registry.setPullRequest(
 *   registry.interruptTask(
 *   registry.reopenTaskForResume(
 *   registry.setTaskResumedAt(
 *   registry.createTask(
 *
 * The patterns deliberately include the `registry.` prefix so that allowed
 * calls like `this.tlm.updateStackStatus(` are not flagged.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../src');

const LIFECYCLE_PATTERNS = [
  'registry.updateStackStatus(',
  'registry.completeTask(',
  'registry.completeTaskNeedsHuman(',
  'registry.completeTaskNeedsKey(',
  'registry.completeTaskVerifyBlockedEnvironmental(',
  'registry.setPullRequest(',
  'registry.interruptTask(',
  'registry.reopenTaskForResume(',
  'registry.setTaskResumedAt(',
  'registry.createTask(',
];

const ALLOW_LIST = new Set([
  'task-lifecycle-manager.ts',
  'registry.ts',
]);

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('architecture: registry lifecycle boundary', () => {
  it('no src file other than task-lifecycle-manager.ts and registry.ts calls raw registry lifecycle methods', () => {
    const files = collectTsFiles(SRC_ROOT);
    const violations: string[] = [];

    for (const file of files) {
      const base = path.basename(file);
      if (ALLOW_LIST.has(base)) continue;

      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of LIFECYCLE_PATTERNS) {
          if (line.includes(pattern)) {
            const rel = path.relative(SRC_ROOT, file);
            violations.push(`${rel}:${i + 1}: found '${pattern}' — must go through TaskLifecycleManager`);
          }
        }
      }
    }

    if (violations.length > 0) {
      expect.fail(
        `Registry lifecycle boundary violations (${violations.length}):\n` +
        violations.map((v) => `  ${v}`).join('\n')
      );
    }
  });
});
