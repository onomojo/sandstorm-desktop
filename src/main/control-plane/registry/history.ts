import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { Stack, Task, HistoryStatus, StackHistoryRecord } from '../registry';

export class HistoryModule {
  constructor(private db: Database.Database) {}

  insertArchiveRecord(
    stack: Stack,
    latestTaskPrompt: string | null,
    tasks: Task[],
    finalStatus: HistoryStatus,
  ): void {
    const taskHistory = tasks.length > 0 ? JSON.stringify(tasks) : null;
    const createdMs = new Date(stack.created_at + 'Z').getTime();
    const nowMs = Date.now();
    const durationSeconds = Math.max(0, Math.floor((nowMs - createdMs) / 1000));

    this.db.prepare(
      `INSERT INTO stack_history
        (stack_id, project, project_dir, ticket, branch, description, final_status, error, runtime, task_prompt, task_history, created_at, duration_seconds, selfheal_continue_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      stack.id,
      stack.project,
      stack.project_dir,
      stack.ticket,
      stack.branch,
      stack.description,
      finalStatus,
      stack.error,
      stack.runtime,
      latestTaskPrompt,
      taskHistory,
      stack.created_at,
      durationSeconds,
      stack.selfheal_continue_used ?? 0,
    );
  }

  listStackHistory(): StackHistoryRecord[] {
    return this.db.prepare(
      'SELECT * FROM stack_history ORDER BY finished_at DESC'
    ).all() as StackHistoryRecord[];
  }

  purgeOldHistory(retentionDays: number = 14): number {
    const result = this.db.prepare(
      "DELETE FROM stack_history WHERE finished_at < datetime('now', ? || ' days')"
    ).run(`-${retentionDays}`);
    return result.changes;
  }

  cleanupLegacyStackJsonFiles(projectDir: string): void {
    const stacksDir = path.join(projectDir, '.sandstorm', 'stacks');
    if (!fs.existsSync(stacksDir)) return;

    try {
      const entries = fs.readdirSync(stacksDir);
      for (const entry of entries) {
        if (entry.endsWith('.json')) {
          try {
            fs.unlinkSync(path.join(stacksDir, entry));
          } catch { /* best effort */ }
        }
      }
    } catch { /* best effort */ }

    const archiveDir = path.join(stacksDir, 'archive');
    if (fs.existsSync(archiveDir)) {
      try {
        fs.rmSync(archiveDir, { recursive: true, force: true });
      } catch { /* best effort */ }
    }

    try {
      const remaining = fs.readdirSync(stacksDir);
      if (remaining.length === 0) {
        fs.rmdirSync(stacksDir);
      }
    } catch { /* best effort */ }
  }
}
