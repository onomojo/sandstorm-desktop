import Database from 'better-sqlite3';
import type { Task } from '../registry';

export class TasksModule {
  constructor(private db: Database.Database) {}

  insertTask(stackId: string, prompt: string, model?: string): Task {
    const result = this.db.prepare(
      "INSERT INTO tasks (stack_id, prompt, model, status) VALUES (?, ?, ?, 'running')"
    ).run(stackId, prompt, model ?? null);
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid) as Task;
  }

  updateTaskStatus(taskId: number, status: 'completed' | 'failed' | 'needs_human' | 'needs_key', exitCode: number, extraFields?: Record<string, unknown>): { stack_id: string } | undefined {
    const sets = ['status = ?', 'exit_code = ?', "finished_at = datetime('now')"];
    const values: unknown[] = [status, exitCode];
    if (extraFields) {
      for (const [k, v] of Object.entries(extraFields)) {
        sets.push(`${k} = ?`);
        values.push(v);
      }
    }
    values.push(taskId);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.db.prepare('SELECT stack_id FROM tasks WHERE id = ?').get(taskId) as { stack_id: string } | undefined;
  }

  reopenTaskForResume(taskId: number): void {
    this.db.prepare(
      "UPDATE tasks SET status = 'running', finished_at = NULL, exit_code = NULL WHERE id = ?"
    ).run(taskId);
  }

  getMostRecentTask(stackId: string): Task | undefined {
    return this.db.prepare(
      'SELECT * FROM tasks WHERE stack_id = ? ORDER BY started_at DESC, id DESC LIMIT 1'
    ).get(stackId) as Task | undefined;
  }

  getNeedsHumanQuestions(stackId: string): string | null {
    const task = this.getMostRecentTask(stackId);
    if (!task || task.status !== 'needs_human') return null;
    return task.needs_human_questions ?? null;
  }

  getTasksForStack(stackId: string): Task[] {
    return this.db.prepare(
      'SELECT * FROM tasks WHERE stack_id = ? ORDER BY started_at DESC, id DESC'
    ).all(stackId) as Task[];
  }

  setTaskWarning(taskId: number, warning: string): void {
    this.db.prepare('UPDATE tasks SET warnings = ? WHERE id = ?').run(warning, taskId);
  }

  updateTaskResolvedModel(taskId: number, resolvedModel: string): void {
    this.db.prepare('UPDATE tasks SET resolved_model = ? WHERE id = ?').run(resolvedModel, taskId);
  }

  getRunningTask(stackId: string): Task | undefined {
    return this.db.prepare(
      "SELECT * FROM tasks WHERE stack_id = ? AND status = 'running' ORDER BY started_at DESC, id DESC LIMIT 1"
    ).get(stackId) as Task | undefined;
  }
}
