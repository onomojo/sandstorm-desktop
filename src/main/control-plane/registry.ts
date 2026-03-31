import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';

export interface Stack {
  id: string;
  project: string;
  project_dir: string;
  ticket: string | null;
  branch: string | null;
  description: string | null;
  status: StackStatus;
  error: string | null;
  pr_url: string | null;
  pr_number: number | null;
  runtime: 'docker' | 'podman';
  total_input_tokens: number;
  total_output_tokens: number;
  total_execution_input_tokens: number;
  total_execution_output_tokens: number;
  total_review_input_tokens: number;
  total_review_output_tokens: number;
  rate_limit_reset_at: string | null;
  created_at: string;
  updated_at: string;
  current_model: string | null;
}

export type StackStatus =
  | 'building'
  | 'rebuilding'
  | 'up'
  | 'running'
  | 'completed'
  | 'failed'
  | 'idle'
  | 'stopped'
  | 'pushed'
  | 'pr_created'
  | 'rate_limited';

export interface Task {
  id: number;
  stack_id: string;
  prompt: string;
  model: string | null;
  resolved_model: string | null;
  status: 'running' | 'completed' | 'failed';
  exit_code: number | null;
  warnings: string | null;
  session_id: string | null;
  input_tokens: number;
  output_tokens: number;
  execution_input_tokens: number;
  execution_output_tokens: number;
  review_input_tokens: number;
  review_output_tokens: number;
  review_iterations: number;
  verify_retries: number;
  started_at: string;
  finished_at: string | null;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface PortMapping {
  stack_id: string;
  service: string;
  host_port: number;
  container_port: number;
}

export type HistoryStatus = 'completed' | 'failed' | 'torn_down';

export interface StackHistoryRecord {
  id: number;
  stack_id: string;
  project: string;
  project_dir: string;
  ticket: string | null;
  branch: string | null;
  description: string | null;
  final_status: HistoryStatus;
  error: string | null;
  runtime: 'docker' | 'podman';
  task_prompt: string | null;
  created_at: string;
  finished_at: string;
  duration_seconds: number;
}

export interface Project {
  id: number;
  name: string;
  directory: string;
  added_at: string;
}

export class Registry {
  private db: Database.Database;
  private dbPath: string;

  private constructor(db: Database.Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async create(dbPath?: string): Promise<Registry> {
    const resolvedPath =
      dbPath ?? path.join(app.getPath('userData'), 'sandstorm.db');

    // Ensure directory exists
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const db = new Database(resolvedPath);

    // Enable WAL mode for better concurrent read performance
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const registry = new Registry(db, resolvedPath);
    registry.migrate();
    return registry;
  }

  private getSchemaVersion(): number {
    try {
      const row = this.db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
      return row?.version ?? 0;
    } catch {
      return 0;
    }
  }

  private setSchemaVersion(version: number): void {
    this.db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, datetime(\'now\'))').run(version);
  }

  private migrate(): void {
    // Create schema_version table first (migration tracking)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version     INTEGER PRIMARY KEY,
        applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const currentVersion = this.getSchemaVersion();

    if (currentVersion < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT NOT NULL,
          directory   TEXT NOT NULL UNIQUE,
          added_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS stacks (
          id          TEXT PRIMARY KEY,
          project     TEXT NOT NULL,
          project_dir TEXT NOT NULL,
          ticket      TEXT,
          branch      TEXT,
          description TEXT,
          status      TEXT NOT NULL DEFAULT 'building',
          error       TEXT,
          runtime     TEXT NOT NULL DEFAULT 'docker',
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          stack_id    TEXT NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
          prompt      TEXT NOT NULL,
          status      TEXT NOT NULL DEFAULT 'running',
          exit_code   INTEGER,
          started_at  TEXT NOT NULL DEFAULT (datetime('now')),
          finished_at TEXT
        );
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ports (
          stack_id       TEXT NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
          service        TEXT NOT NULL,
          host_port      INTEGER NOT NULL UNIQUE,
          container_port INTEGER NOT NULL,
          PRIMARY KEY (stack_id, service)
        );
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS stack_history (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          stack_id         TEXT NOT NULL,
          project          TEXT NOT NULL,
          project_dir      TEXT NOT NULL,
          ticket           TEXT,
          branch           TEXT,
          description      TEXT,
          final_status     TEXT NOT NULL,
          error            TEXT,
          runtime          TEXT NOT NULL DEFAULT 'docker',
          task_prompt      TEXT,
          created_at       TEXT NOT NULL,
          finished_at      TEXT NOT NULL DEFAULT (datetime('now')),
          duration_seconds INTEGER NOT NULL DEFAULT 0
        );
      `);
      this.setSchemaVersion(1);
    }

    if (currentVersion < 2) {
      // Add pr_url and pr_number columns for pushed/pr_created statuses
      try {
        this.db.exec('ALTER TABLE stacks ADD COLUMN pr_url TEXT');
      } catch {
        // Column already exists
      }
      try {
        this.db.exec('ALTER TABLE stacks ADD COLUMN pr_number INTEGER');
      } catch {
        // Column already exists
      }
      // Add warnings column to tasks table
      try {
        this.db.exec('ALTER TABLE tasks ADD COLUMN warnings TEXT');
      } catch {
        // Column already exists
      }
      this.setSchemaVersion(2);
    }

    if (currentVersion < 3) {
      // Add token tracking columns to tasks
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN session_id TEXT'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }

      // Add aggregate token tracking and rate limit info to stacks
      try { this.db.exec('ALTER TABLE stacks ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE stacks ADD COLUMN total_output_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE stacks ADD COLUMN rate_limit_reset_at TEXT'); } catch { /* exists */ }

      this.setSchemaVersion(3);
    }

    if (currentVersion < 4) {
      // Add model column to tasks for intelligent model selection
      try {
        this.db.exec('ALTER TABLE tasks ADD COLUMN model TEXT');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('duplicate column')) throw err;
      }
      this.setSchemaVersion(4);
    }

    if (currentVersion < 5) {
      // Add loop iteration tracking columns to tasks
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN review_iterations INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN verify_retries INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      this.setSchemaVersion(5);
    }

    if (currentVersion < 6) {
      // Add resolved_model column — the actual model used when "auto" was selected
      try {
        this.db.exec('ALTER TABLE tasks ADD COLUMN resolved_model TEXT');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('duplicate column')) throw err;
      }
      this.setSchemaVersion(6);
    }

    if (currentVersion < 7) {
      // Add per-phase token breakdown columns to tasks
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN execution_input_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN execution_output_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN review_input_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN review_output_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }

      // Add per-phase token breakdown columns to stacks
      try { this.db.exec('ALTER TABLE stacks ADD COLUMN total_execution_input_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE stacks ADD COLUMN total_execution_output_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE stacks ADD COLUMN total_review_input_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE stacks ADD COLUMN total_review_output_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }

      this.setSchemaVersion(7);
    }

    // Future migrations go here:
    // if (currentVersion < 8) { ... this.setSchemaVersion(8); }
  }

  // --- Projects ---

  addProject(directory: string, name?: string): Project {
    const normalizedDir = path.resolve(directory);
    const projectName = name ?? path.basename(normalizedDir);
    const result = this.db.prepare(
      'INSERT INTO projects (name, directory) VALUES (?, ?)'
    ).run(projectName, normalizedDir);
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid) as Project;
  }

  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY added_at ASC').all() as Project[];
  }

  removeProject(id: number): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  getProject(id: number): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  }

  // --- Stacks ---

  createStack(stack: Omit<Stack, 'created_at' | 'updated_at' | 'error' | 'pr_url' | 'pr_number' | 'total_input_tokens' | 'total_output_tokens' | 'total_execution_input_tokens' | 'total_execution_output_tokens' | 'total_review_input_tokens' | 'total_review_output_tokens' | 'rate_limit_reset_at'>): Stack {
    const normalizedDir = path.resolve(stack.project_dir);
    this.db.prepare(
      `INSERT INTO stacks (id, project, project_dir, ticket, branch, description, status, runtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(stack.id, stack.project, normalizedDir, stack.ticket, stack.branch, stack.description, stack.status, stack.runtime);
    return this.getStack(stack.id)!;
  }

  getStack(id: string): Stack | undefined {
    return this.db.prepare(
      `SELECT s.*, (SELECT model FROM tasks WHERE stack_id = s.id ORDER BY id DESC LIMIT 1) as current_model
       FROM stacks s WHERE s.id = ?`
    ).get(id) as Stack | undefined;
  }

  listStacks(): Stack[] {
    return this.db.prepare(
      `SELECT s.*, (SELECT model FROM tasks WHERE stack_id = s.id ORDER BY id DESC LIMIT 1) as current_model
       FROM stacks s ORDER BY s.created_at DESC`
    ).all() as Stack[];
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

  // --- Tasks ---

  createTask(stackId: string, prompt: string, model?: string): Task {
    const result = this.db.prepare(
      "INSERT INTO tasks (stack_id, prompt, model, status) VALUES (?, ?, ?, 'running')"
    ).run(stackId, prompt, model ?? null);
    this.updateStackStatus(stackId, 'running');
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid) as Task;
  }

  completeTask(taskId: number, exitCode: number): void {
    const status = exitCode === 0 ? 'completed' : 'failed';
    this.db.prepare(
      "UPDATE tasks SET status = ?, exit_code = ?, finished_at = datetime('now') WHERE id = ?"
    ).run(status, exitCode, taskId);

    const task = this.db.prepare(
      'SELECT stack_id FROM tasks WHERE id = ?'
    ).get(taskId) as { stack_id: string } | undefined;
    if (task) {
      this.updateStackStatus(
        task.stack_id,
        exitCode === 0 ? 'completed' : 'failed'
      );
    }
  }

  getTasksForStack(stackId: string): Task[] {
    return this.db.prepare(
      'SELECT * FROM tasks WHERE stack_id = ? ORDER BY started_at DESC'
    ).all(stackId) as Task[];
  }

  setTaskWarning(taskId: number, warning: string): void {
    this.db.prepare(
      'UPDATE tasks SET warnings = ? WHERE id = ?'
    ).run(warning, taskId);
  }

  updateTaskResolvedModel(taskId: number, resolvedModel: string): void {
    this.db.prepare(
      'UPDATE tasks SET resolved_model = ? WHERE id = ?'
    ).run(resolvedModel, taskId);
  }

  getRunningTask(stackId: string): Task | undefined {
    return this.db.prepare(
      "SELECT * FROM tasks WHERE stack_id = ? AND status = 'running' LIMIT 1"
    ).get(stackId) as Task | undefined;
  }

  // --- Token Usage ---

  updateTaskTokens(
    taskId: number,
    inputTokens: number,
    outputTokens: number,
    phaseBreakdown?: {
      executionInput: number;
      executionOutput: number;
      reviewInput: number;
      reviewOutput: number;
    }
  ): void {
    // Wrap in a transaction to prevent race conditions from concurrent task completions
    const updateFn = this.db.transaction(() => {
      // Read old values first so we can compute the delta for the stack aggregate
      const old = this.db.prepare(
        'SELECT stack_id, input_tokens, output_tokens, execution_input_tokens, execution_output_tokens, review_input_tokens, review_output_tokens FROM tasks WHERE id = ?'
      ).get(taskId) as {
        stack_id: string;
        input_tokens: number;
        output_tokens: number;
        execution_input_tokens: number;
        execution_output_tokens: number;
        review_input_tokens: number;
        review_output_tokens: number;
      } | undefined;
      if (!old) return;

      const inputDelta = inputTokens - old.input_tokens;
      const outputDelta = outputTokens - old.output_tokens;

      if (phaseBreakdown) {
        const execInDelta = phaseBreakdown.executionInput - old.execution_input_tokens;
        const execOutDelta = phaseBreakdown.executionOutput - old.execution_output_tokens;
        const revInDelta = phaseBreakdown.reviewInput - old.review_input_tokens;
        const revOutDelta = phaseBreakdown.reviewOutput - old.review_output_tokens;

        // SET (not increment) — phase totals are cumulative values
        this.db.prepare(
          'UPDATE tasks SET input_tokens = ?, output_tokens = ?, execution_input_tokens = ?, execution_output_tokens = ?, review_input_tokens = ?, review_output_tokens = ? WHERE id = ?'
        ).run(
          inputTokens, outputTokens,
          phaseBreakdown.executionInput, phaseBreakdown.executionOutput,
          phaseBreakdown.reviewInput, phaseBreakdown.reviewOutput,
          taskId
        );

        // Update stack aggregate by the delta
        if (inputDelta !== 0 || outputDelta !== 0 || execInDelta !== 0 || execOutDelta !== 0 || revInDelta !== 0 || revOutDelta !== 0) {
          this.db.prepare(
            `UPDATE stacks SET
              total_input_tokens = total_input_tokens + ?,
              total_output_tokens = total_output_tokens + ?,
              total_execution_input_tokens = total_execution_input_tokens + ?,
              total_execution_output_tokens = total_execution_output_tokens + ?,
              total_review_input_tokens = total_review_input_tokens + ?,
              total_review_output_tokens = total_review_output_tokens + ?
            WHERE id = ?`
          ).run(inputDelta, outputDelta, execInDelta, execOutDelta, revInDelta, revOutDelta, old.stack_id);
        }
      } else {
        // Legacy path — no phase breakdown
        this.db.prepare(
          'UPDATE tasks SET input_tokens = ?, output_tokens = ? WHERE id = ?'
        ).run(inputTokens, outputTokens, taskId);

        // Update stack aggregate by the delta
        if (inputDelta !== 0 || outputDelta !== 0) {
          this.db.prepare(
            'UPDATE stacks SET total_input_tokens = total_input_tokens + ?, total_output_tokens = total_output_tokens + ? WHERE id = ?'
          ).run(inputDelta, outputDelta, old.stack_id);
        }
      }
    });
    updateFn();
  }

  setTaskSessionId(taskId: number, sessionId: string): void {
    this.db.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run(sessionId, taskId);
  }

  setTaskIterations(taskId: number, reviewIterations: number, verifyRetries: number): void {
    this.db.prepare(
      'UPDATE tasks SET review_iterations = ?, verify_retries = ? WHERE id = ?'
    ).run(reviewIterations, verifyRetries, taskId);
  }

  getStackTokenUsage(stackId: string): TokenUsage {
    const row = this.db.prepare(
      'SELECT total_input_tokens, total_output_tokens FROM stacks WHERE id = ?'
    ).get(stackId) as { total_input_tokens: number; total_output_tokens: number } | undefined;
    return {
      input_tokens: row?.total_input_tokens ?? 0,
      output_tokens: row?.total_output_tokens ?? 0,
    };
  }

  // --- Ports ---

  setPorts(stackId: string, ports: Omit<PortMapping, 'stack_id'>[]): void {
    const insertPort = this.db.prepare(
      'INSERT INTO ports (stack_id, service, host_port, container_port) VALUES (?, ?, ?, ?)'
    );
    const insertMany = this.db.transaction((items: Omit<PortMapping, 'stack_id'>[]) => {
      for (const p of items) {
        insertPort.run(stackId, p.service, p.host_port, p.container_port);
      }
    });
    insertMany(ports);
  }

  getPorts(stackId: string): PortMapping[] {
    return this.db.prepare(
      'SELECT * FROM ports WHERE stack_id = ? ORDER BY host_port ASC'
    ).all(stackId) as PortMapping[];
  }

  getAllAllocatedPorts(): number[] {
    return (this.db.prepare(
      'SELECT host_port FROM ports'
    ).all() as { host_port: number }[]).map((r) => r.host_port);
  }

  releasePorts(stackId: string): void {
    this.db.prepare('DELETE FROM ports WHERE stack_id = ?').run(stackId);
  }

  // --- Stack History ---

  archiveStack(id: string, finalStatus: HistoryStatus): void {
    const stack = this.getStack(id);
    if (!stack) return;

    const latestTask = this.db.prepare(
      'SELECT prompt FROM tasks WHERE stack_id = ? ORDER BY started_at DESC LIMIT 1'
    ).get(id) as { prompt: string } | undefined;

    const createdMs = new Date(stack.created_at + 'Z').getTime();
    const nowMs = Date.now();
    const durationSeconds = Math.max(0, Math.floor((nowMs - createdMs) / 1000));

    this.db.prepare(
      `INSERT INTO stack_history
        (stack_id, project, project_dir, ticket, branch, description, final_status, error, runtime, task_prompt, created_at, duration_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      latestTask?.prompt ?? null,
      stack.created_at,
      durationSeconds,
    );
  }

  listStackHistory(): StackHistoryRecord[] {
    return this.db.prepare(
      'SELECT * FROM stack_history ORDER BY finished_at DESC'
    ).all() as StackHistoryRecord[];
  }

  // --- Legacy Migration ---

  /**
   * Removes legacy JSON stack files left over from before the SQLite migration.
   * Safe to call even if the directory does not exist — it is a no-op in that case.
   */
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

    // Remove the now-empty stacks directory itself
    try {
      const remaining = fs.readdirSync(stacksDir);
      if (remaining.length === 0) {
        fs.rmdirSync(stacksDir);
      }
    } catch { /* best effort */ }
  }

  // --- Cleanup ---

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed
    }
  }
}
