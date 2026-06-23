import Database from 'better-sqlite3';
import path from 'path';
import type { Stack, StackStatus } from '../registry';

export class StacksModule {
  constructor(private db: Database.Database) {}

  createStack(stack: Omit<Stack, 'created_at' | 'updated_at' | 'error' | 'pr_url' | 'pr_number' | 'total_input_tokens' | 'total_output_tokens' | 'total_execution_input_tokens' | 'total_execution_output_tokens' | 'total_review_input_tokens' | 'total_review_output_tokens' | 'total_cache_read_tokens' | 'total_cache_creation_tokens' | 'rate_limit_reset_at' | 'current_model' | 'selfheal_continue_used' | 'latest_task_token_limited'>): Stack {
    if (!stack.id) {
      throw new Error('Stack id is required and cannot be null or empty');
    }
    const normalizedDir = path.resolve(stack.project_dir);
    this.db.prepare(
      `INSERT INTO stacks (id, project, project_dir, ticket, branch, description, status, runtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(stack.id, stack.project, normalizedDir, stack.ticket, stack.branch, stack.description, stack.status, stack.runtime);
    return this.getStack(stack.id)!;
  }

  getStack(id: string): Stack | undefined {
    const row = this.db.prepare(
      `SELECT s.*,
       (SELECT model FROM tasks WHERE stack_id = s.id ORDER BY id DESC LIMIT 1) as current_model,
       COALESCE(
         (SELECT CASE WHEN LOWER(execution_summary) LIKE '%you''ve hit your session limit%' THEN 1 ELSE 0 END
          FROM tasks WHERE stack_id = s.id ORDER BY id DESC LIMIT 1),
         0
       ) as latest_task_token_limited
       FROM stacks s WHERE s.id = ?`
    ).get(id) as (Omit<Stack, 'latest_task_token_limited'> & { latest_task_token_limited: number }) | undefined;
    if (!row) return undefined;
    return { ...row, latest_task_token_limited: row.latest_task_token_limited !== 0 };
  }

  listStacks(): Stack[] {
    const rows = (this.db.prepare(
      `SELECT s.*,
       (SELECT model FROM tasks WHERE stack_id = s.id ORDER BY id DESC LIMIT 1) as current_model,
       COALESCE(
         (SELECT CASE WHEN LOWER(execution_summary) LIKE '%you''ve hit your session limit%' THEN 1 ELSE 0 END
          FROM tasks WHERE stack_id = s.id ORDER BY id DESC LIMIT 1),
         0
       ) as latest_task_token_limited
       FROM stacks s WHERE s.id IS NOT NULL ORDER BY s.created_at DESC`
    ).all() as (Omit<Stack, 'latest_task_token_limited'> & { latest_task_token_limited: number })[]);
    return rows.map(row => ({ ...row, latest_task_token_limited: row.latest_task_token_limited !== 0 }));
  }

  updateStackStatus(id: string, status: StackStatus, error?: string): void {
    if (error !== undefined) {
      this.db.prepare(
        "UPDATE stacks SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(status, error, id);
    } else {
      this.db.prepare(
        "UPDATE stacks SET status = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(status, id);
    }
  }

  setPullRequest(id: string, prUrl: string, prNumber: number): void {
    this.db.prepare(
      "UPDATE stacks SET status = 'pr_created', pr_url = ?, pr_number = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(prUrl, prNumber, id);
  }

  deleteStack(id: string): void {
    this.db.prepare('DELETE FROM stacks WHERE id = ?').run(id);
  }

  setSelfhealContinueUsed(stackId: string, value: 0 | 1): void {
    this.db.prepare('UPDATE stacks SET selfheal_continue_used = ? WHERE id = ?').run(value, stackId);
  }

  getBranchesForTicket(ticketId: string): string[] {
    const active = this.db.prepare(
      "SELECT branch FROM stacks WHERE ticket = ? AND branch IS NOT NULL"
    ).all(ticketId) as { branch: string }[];
    const history = this.db.prepare(
      "SELECT branch FROM stack_history WHERE ticket = ? AND branch IS NOT NULL"
    ).all(ticketId) as { branch: string }[];
    return [...active, ...history].map((r) => r.branch);
  }
}
