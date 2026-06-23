import Database from 'better-sqlite3';
import path from 'path';
import type { EpicRunState, EpicStatus, EpicTask, EpicTaskRole, EpicTaskOrigin } from '../registry';

const VALID_EPIC_STATUSES: ReadonlySet<string> = new Set(['running', 'paused', 'completed', 'needs_human']);

export class EpicsModule {
  constructor(private db: Database.Database) {}

  getEpicRunState(epicId: string): EpicRunState | null {
    const row = this.db.prepare(
      'SELECT epic_id, project_dir, status, created_at, updated_at FROM epics WHERE epic_id = ?'
    ).get(epicId) as EpicRunState | undefined;
    return row ?? null;
  }

  upsertEpicRunState(epicId: string, projectDir: string, status: EpicStatus): void {
    if (!VALID_EPIC_STATUSES.has(status)) {
      throw new Error(`Invalid epic status: ${status}`);
    }
    const normalizedDir = path.resolve(projectDir);
    this.db.prepare(
      `INSERT INTO epics (epic_id, project_dir, status, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(epic_id) DO UPDATE SET
         status = excluded.status,
         updated_at = excluded.updated_at`
    ).run(epicId, normalizedDir, status);
  }

  getEpicTasks(epicId: string): EpicTask[] {
    return this.db.prepare(
      'SELECT epic_id, ticket_id, role, origin, crit_id, gap_cycles, done FROM epic_tasks WHERE epic_id = ?'
    ).all(epicId) as EpicTask[];
  }

  getAllEpicTasks(): EpicTask[] {
    return this.db.prepare(
      'SELECT epic_id, ticket_id, role, origin, crit_id, gap_cycles, done FROM epic_tasks'
    ).all() as EpicTask[];
  }

  getAllEpicIds(): string[] {
    return (this.db.prepare(
      'SELECT DISTINCT epic_id FROM epic_tasks ORDER BY epic_id'
    ).all() as { epic_id: string }[]).map((r) => r.epic_id);
  }

  getEpicForTicket(ticketId: string): { epicId: string; role: EpicTaskRole; critId: string | null } | null {
    const row = this.db.prepare(
      'SELECT epic_id, role, crit_id FROM epic_tasks WHERE ticket_id = ? ORDER BY epic_id LIMIT 1'
    ).get(ticketId) as { epic_id: string; role: EpicTaskRole; crit_id: string | null } | undefined;
    if (!row) return null;
    return { epicId: row.epic_id, role: row.role, critId: row.crit_id };
  }

  upsertEpicTask(
    epicId: string,
    ticketId: string,
    opts: { role: EpicTaskRole; origin: EpicTaskOrigin; critId?: string | null },
  ): void {
    this.db.prepare(
      `INSERT INTO epic_tasks (epic_id, ticket_id, role, origin, crit_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(epic_id, ticket_id) DO UPDATE SET
         role = excluded.role,
         origin = excluded.origin,
         crit_id = excluded.crit_id`
    ).run(epicId, ticketId, opts.role, opts.origin, opts.critId ?? null);
  }

  setEpicTaskDone(epicId: string, ticketId: string): void {
    this.db.prepare(
      'UPDATE epic_tasks SET done = 1 WHERE epic_id = ? AND ticket_id = ?'
    ).run(epicId, ticketId);
  }

  incrementGapCycles(epicId: string, ticketId: string): number {
    this.db.prepare(
      `INSERT INTO epic_tasks (epic_id, ticket_id, role, origin, gap_cycles)
       VALUES (?, ?, 'build', 'gap', 1)
       ON CONFLICT(epic_id, ticket_id) DO UPDATE SET gap_cycles = gap_cycles + 1`
    ).run(epicId, ticketId);
    const row = this.db.prepare(
      'SELECT gap_cycles FROM epic_tasks WHERE epic_id = ? AND ticket_id = ?'
    ).get(epicId, ticketId) as { gap_cycles: number };
    return row.gap_cycles;
  }

  getEpicMaxParallelStacks(projectDir: string): number {
    const key = `project:${path.resolve(projectDir)}`;
    const row = this.db.prepare(
      'SELECT value FROM project_epic_settings WHERE key = ?'
    ).get(key) as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 3;
  }

  setEpicMaxParallelStacks(projectDir: string, n: number): void {
    const key = `project:${path.resolve(projectDir)}`;
    this.db.prepare(
      'INSERT OR REPLACE INTO project_epic_settings (key, value) VALUES (?, ?)'
    ).run(key, String(n));
  }
}
