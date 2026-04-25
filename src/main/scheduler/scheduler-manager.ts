/**
 * Scheduler manager — coordinates schedule operations with the crontab
 * and the registry's project list. This is the integration layer between
 * the schedule service, crontab writer, and the app's project registry.
 */

import path from 'path';
import crypto from 'crypto';
import {
  getAllSchedulesForProjects,
  syncCrontab,
  CrontabEntry,
  getStableWrapperPath,
} from './index';

/** Minimal interface for the project registry, to avoid circular imports. */
interface ProjectRegistry {
  listProjects(): Array<{ directory: string }>;
}

/**
 * Derive a stable project ID from the project directory path.
 * Uses a hash of the full path to avoid collisions when two projects
 * share the same directory basename (e.g. /home/a/myapp vs /home/b/myapp).
 */
export function projectIdFromDir(projectDir: string): string {
  const base = path.basename(projectDir).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const hash = crypto.createHash('sha256').update(projectDir).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/**
 * Sync all schedules from all registered projects into the system crontab.
 * Called after any schedule CRUD operation.
 */
export async function syncAllProjectsCrontab(reg: ProjectRegistry): Promise<void> {
  try {
    const projects = reg.listProjects();
    const projectDirs = projects.map((p) => p.directory);
    const allSchedules = getAllSchedulesForProjects(projectDirs);
    const wrapperPath = getStableWrapperPath();

    const entries: CrontabEntry[] = allSchedules.map(({ projectDir, schedule }) => ({
      projectDir,
      projectId: projectIdFromDir(projectDir),
      schedule,
      wrapperPath,
    }));

    syncCrontab(entries);
    console.log(`[scheduler] Synced ${entries.length} schedule(s) to crontab`);
  } catch (err) {
    console.error('[scheduler] Failed to sync crontab:', err);
    throw err;
  }
}
