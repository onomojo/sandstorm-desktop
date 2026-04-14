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
  | 'rate_limited'
  | 'session_paused';

export interface Task {
  id: number;
  stack_id: string;
  prompt: string;
  model: string | null;
  resolved_model: string | null;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
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
  review_verdicts: string | null;
  verify_outputs: string | null;
  execution_summary: string | null;
  execution_started_at: string | null;
  execution_finished_at: string | null;
  review_started_at: string | null;
  review_finished_at: string | null;
  verify_started_at: string | null;
  verify_finished_at: string | null;
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
  task_history: string | null;
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

export interface TaskTokenStep {
  id: number;
  task_id: number;
  iteration: number;
  phase: string;
  input_tokens: number;
  output_tokens: number;
}

export interface ProjectTokenUsageRecord {
  id: number;
  project_dir: string;
  input_tokens: number;
  output_tokens: number;
  updated_at: string;
}

export interface TokenValidationResult {
  valid: boolean;
  stepTotal: { input: number; output: number };
  phaseTotal: { executionInput: number; executionOutput: number; reviewInput: number; reviewOutput: number };
  taskTotal: { input: number; output: number };
}

export interface ModelSettings {
  inner_model: string;
  outer_model: string;
}

export interface SessionMonitorSettingsRecord {
  warningThreshold: number;
  criticalThreshold: number;
  autoHaltThreshold: number;
  autoHaltEnabled: boolean;
  autoResumeAfterReset: boolean;
  pollIntervalMs: number;
  idleTimeoutMs: number;
  pollingDisabled: boolean;
}

/** Raw DB row shape for session_monitor_settings */
interface SessionMonitorSettingsRow {
  key: string;
  warning_threshold: number;
  critical_threshold: number;
  auto_halt_threshold: number;
  auto_halt_enabled: number;
  auto_resume_after_reset: number;
  poll_interval_ms: number;
  idle_timeout_ms: number;
  polling_disabled: number;
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

    if (currentVersion < 8) {
      // Add task execution metadata columns
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN review_verdicts TEXT'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN verify_outputs TEXT'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN execution_summary TEXT'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN execution_started_at TEXT'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN execution_finished_at TEXT'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN review_started_at TEXT'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN review_finished_at TEXT'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN verify_started_at TEXT'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN verify_finished_at TEXT'); } catch { /* exists */ }

      // Add task_history JSON blob to stack_history for archival
      try { this.db.exec('ALTER TABLE stack_history ADD COLUMN task_history TEXT'); } catch { /* exists */ }

      this.setSchemaVersion(8);
    }

    if (currentVersion < 9) {
      // Model settings: global defaults + per-project overrides
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS model_settings (
          key         TEXT PRIMARY KEY,
          inner_model TEXT NOT NULL DEFAULT 'sonnet',
          outer_model TEXT NOT NULL DEFAULT 'opus'
        );
      `);
      // Seed global defaults row
      this.db.exec(`
        INSERT OR IGNORE INTO model_settings (key, inner_model, outer_model)
        VALUES ('global', 'sonnet', 'opus');
      `);
      this.setSchemaVersion(9);
    }

    if (currentVersion < 10) {
      // Per-step token tracking for iteration-level observability
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS task_token_steps (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          iteration     INTEGER NOT NULL,
          phase         TEXT NOT NULL,
          input_tokens  INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0
        );
      `);
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_task_token_steps_task_id ON task_token_steps(task_id);
      `);

      // Outer Claude token tracking per project
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS project_token_usage (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          project_dir   TEXT NOT NULL UNIQUE,
          input_tokens  INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      this.setSchemaVersion(10);
    }

    if (currentVersion < 11) {
      // Session monitor settings — global app-level config for auto-halt thresholds
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session_monitor_settings (
          key                    TEXT PRIMARY KEY DEFAULT 'global',
          warning_threshold      INTEGER NOT NULL DEFAULT 80,
          critical_threshold     INTEGER NOT NULL DEFAULT 95,
          auto_halt_threshold    INTEGER NOT NULL DEFAULT 100,
          auto_halt_enabled      INTEGER NOT NULL DEFAULT 1,
          auto_resume_after_reset INTEGER NOT NULL DEFAULT 0,
          poll_interval_ms       INTEGER NOT NULL DEFAULT 60000
        );
      `);
      this.db.exec(`
        INSERT OR IGNORE INTO session_monitor_settings (key) VALUES ('global');
      `);

      // Add current_model column to stacks (may already exist via subquery alias)
      try { this.db.exec('ALTER TABLE stacks ADD COLUMN current_model TEXT'); } catch { /* exists */ }

      this.setSchemaVersion(11);
    }

    if (currentVersion < 12) {
      // Update session monitor defaults: autoHaltThreshold 100→95, criticalThreshold 95→90,
      // pollIntervalMs 60000→120000. Add idle_timeout_ms and polling_disabled columns.
      try { this.db.exec('ALTER TABLE session_monitor_settings ADD COLUMN idle_timeout_ms INTEGER NOT NULL DEFAULT 300000'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE session_monitor_settings ADD COLUMN polling_disabled INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }

      // Update defaults for existing rows
      this.db.exec(`
        UPDATE session_monitor_settings
        SET auto_halt_threshold = 95,
            critical_threshold = 90,
            poll_interval_ms = 120000
        WHERE key = 'global'
          AND auto_halt_threshold = 100
          AND critical_threshold = 95
          AND poll_interval_ms = 60000
      `);

      this.setSchemaVersion(12);
    }

    // Future migrations go here:
    // if (currentVersion < 13) { ... this.setSchemaVersion(13); }
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

  createStack(stack: Omit<Stack, 'created_at' | 'updated_at' | 'error' | 'pr_url' | 'pr_number' | 'total_input_tokens' | 'total_output_tokens' | 'total_execution_input_tokens' | 'total_execution_output_tokens' | 'total_review_input_tokens' | 'total_review_output_tokens' | 'rate_limit_reset_at' | 'current_model'>): Stack {
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
    return this.db.prepare(
      `SELECT s.*, (SELECT model FROM tasks WHERE stack_id = s.id ORDER BY id DESC LIMIT 1) as current_model
       FROM stacks s WHERE s.id = ?`
    ).get(id) as Stack | undefined;
  }

  listStacks(): Stack[] {
    return (this.db.prepare(
      `SELECT s.*, (SELECT model FROM tasks WHERE stack_id = s.id ORDER BY id DESC LIMIT 1) as current_model
       FROM stacks s WHERE s.id IS NOT NULL ORDER BY s.created_at DESC`
    ).all() as Stack[]);
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

  getMostRecentTask(stackId: string): Task | undefined {
    return this.db.prepare(
      'SELECT * FROM tasks WHERE stack_id = ? ORDER BY started_at DESC LIMIT 1'
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

  updateTaskMetadata(taskId: number, metadata: {
    review_verdicts?: string;
    verify_outputs?: string;
    execution_summary?: string;
    execution_started_at?: string;
    execution_finished_at?: string;
    review_started_at?: string;
    review_finished_at?: string;
    verify_started_at?: string;
    verify_finished_at?: string;
  }): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        values.push(value);
      }
    }
    if (sets.length === 0) return;
    values.push(taskId);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  // --- Task Token Steps ---

  setTaskTokenSteps(taskId: number, steps: { iteration: number; phase: string; input_tokens: number; output_tokens: number }[]): void {
    const insertOrUpdate = this.db.transaction(() => {
      // Clear existing steps for this task
      this.db.prepare('DELETE FROM task_token_steps WHERE task_id = ?').run(taskId);
      const insert = this.db.prepare(
        'INSERT INTO task_token_steps (task_id, iteration, phase, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)'
      );
      for (const step of steps) {
        insert.run(taskId, step.iteration, step.phase, step.input_tokens, step.output_tokens);
      }
    });
    insertOrUpdate();
  }

  getTaskTokenSteps(taskId: number): TaskTokenStep[] {
    return this.db.prepare(
      'SELECT * FROM task_token_steps WHERE task_id = ? ORDER BY iteration ASC, CASE phase WHEN \'execution\' THEN 0 WHEN \'review\' THEN 1 WHEN \'verify\' THEN 2 ELSE 99 END ASC'
    ).all(taskId) as TaskTokenStep[];
  }

  /**
   * Validate that per-step token sums match phase totals and grand total.
   * Returns validation result with computed sums.
   */
  validateTaskTokens(taskId: number): TokenValidationResult {
    const task = this.db.prepare(
      'SELECT input_tokens, output_tokens, execution_input_tokens, execution_output_tokens, review_input_tokens, review_output_tokens FROM tasks WHERE id = ?'
    ).get(taskId) as {
      input_tokens: number; output_tokens: number;
      execution_input_tokens: number; execution_output_tokens: number;
      review_input_tokens: number; review_output_tokens: number;
    } | undefined;

    if (!task) {
      return { valid: true, stepTotal: { input: 0, output: 0 }, phaseTotal: { executionInput: 0, executionOutput: 0, reviewInput: 0, reviewOutput: 0 }, taskTotal: { input: 0, output: 0 } };
    }

    const steps = this.getTaskTokenSteps(taskId);

    // Sum steps by phase
    let stepExecIn = 0, stepExecOut = 0, stepRevIn = 0, stepRevOut = 0;
    let stepTotalIn = 0, stepTotalOut = 0;

    for (const step of steps) {
      stepTotalIn += step.input_tokens;
      stepTotalOut += step.output_tokens;
      if (step.phase === 'execution') {
        stepExecIn += step.input_tokens;
        stepExecOut += step.output_tokens;
      } else if (step.phase === 'review') {
        stepRevIn += step.input_tokens;
        stepRevOut += step.output_tokens;
      }
      // verify tokens contribute to total but not to exec/review phase fields
    }

    const phaseTotalIn = task.execution_input_tokens + task.review_input_tokens;
    const phaseTotalOut = task.execution_output_tokens + task.review_output_tokens;

    // Steps should match phase totals (execution steps = execution phase, review steps = review phase)
    const stepsMatchPhases =
      stepExecIn === task.execution_input_tokens &&
      stepExecOut === task.execution_output_tokens &&
      stepRevIn === task.review_input_tokens &&
      stepRevOut === task.review_output_tokens;

    // Phase totals should match grand total (verify tokens account for the difference)
    const phasesMatchTotal =
      phaseTotalIn <= task.input_tokens &&
      phaseTotalOut <= task.output_tokens;

    return {
      valid: steps.length === 0 || (stepsMatchPhases && phasesMatchTotal),
      stepTotal: { input: stepTotalIn, output: stepTotalOut },
      phaseTotal: {
        executionInput: task.execution_input_tokens,
        executionOutput: task.execution_output_tokens,
        reviewInput: task.review_input_tokens,
        reviewOutput: task.review_output_tokens,
      },
      taskTotal: { input: task.input_tokens, output: task.output_tokens },
    };
  }

  // --- Project Token Usage (Outer Claude) ---

  getProjectTokenUsage(projectDir: string): ProjectTokenUsageRecord | undefined {
    const normalizedDir = path.resolve(projectDir);
    return this.db.prepare(
      'SELECT * FROM project_token_usage WHERE project_dir = ?'
    ).get(normalizedDir) as ProjectTokenUsageRecord | undefined;
  }

  addProjectTokenUsage(projectDir: string, inputTokens: number, outputTokens: number): void {
    const normalizedDir = path.resolve(projectDir);
    const existing = this.db.prepare(
      'SELECT id FROM project_token_usage WHERE project_dir = ?'
    ).get(normalizedDir) as { id: number } | undefined;

    if (existing) {
      this.db.prepare(
        "UPDATE project_token_usage SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = datetime('now') WHERE project_dir = ?"
      ).run(inputTokens, outputTokens, normalizedDir);
    } else {
      this.db.prepare(
        'INSERT INTO project_token_usage (project_dir, input_tokens, output_tokens) VALUES (?, ?, ?)'
      ).run(normalizedDir, inputTokens, outputTokens);
    }
  }

  listProjectTokenUsage(): ProjectTokenUsageRecord[] {
    return this.db.prepare(
      'SELECT * FROM project_token_usage ORDER BY updated_at DESC'
    ).all() as ProjectTokenUsageRecord[];
  }

  interruptTask(taskId: number): void {
    this.db.prepare(
      "UPDATE tasks SET status = 'interrupted', finished_at = datetime('now') WHERE id = ? AND status = 'running'"
    ).run(taskId);
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

    // Archive all task data as JSON before CASCADE deletion removes them
    const tasks = this.getTasksForStack(id);
    const taskHistory = tasks.length > 0 ? JSON.stringify(tasks) : null;

    const createdMs = new Date(stack.created_at + 'Z').getTime();
    const nowMs = Date.now();
    const durationSeconds = Math.max(0, Math.floor((nowMs - createdMs) / 1000));

    this.db.prepare(
      `INSERT INTO stack_history
        (stack_id, project, project_dir, ticket, branch, description, final_status, error, runtime, task_prompt, task_history, created_at, duration_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      taskHistory,
      stack.created_at,
      durationSeconds,
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

  // --- Model Settings ---

  getGlobalModelSettings(): ModelSettings {
    const row = this.db.prepare(
      "SELECT inner_model, outer_model FROM model_settings WHERE key = 'global'"
    ).get() as ModelSettings | undefined;
    return row ?? { inner_model: 'sonnet', outer_model: 'opus' };
  }

  setGlobalModelSettings(settings: Partial<ModelSettings>): void {
    const current = this.getGlobalModelSettings();
    this.db.prepare(
      "INSERT OR REPLACE INTO model_settings (key, inner_model, outer_model) VALUES ('global', ?, ?)"
    ).run(
      settings.inner_model ?? current.inner_model,
      settings.outer_model ?? current.outer_model,
    );
  }

  getProjectModelSettings(projectDir: string): ModelSettings | null {
    const key = `project:${path.resolve(projectDir)}`;
    const row = this.db.prepare(
      'SELECT inner_model, outer_model FROM model_settings WHERE key = ?'
    ).get(key) as ModelSettings | undefined;
    return row ?? null;
  }

  setProjectModelSettings(projectDir: string, settings: Partial<ModelSettings>): void {
    const key = `project:${path.resolve(projectDir)}`;
    const existing = this.getProjectModelSettings(projectDir);
    const inner = settings.inner_model ?? existing?.inner_model ?? 'global';
    const outer = settings.outer_model ?? existing?.outer_model ?? 'global';
    this.db.prepare(
      'INSERT OR REPLACE INTO model_settings (key, inner_model, outer_model) VALUES (?, ?, ?)'
    ).run(key, inner, outer);
  }

  removeProjectModelSettings(projectDir: string): void {
    const key = `project:${path.resolve(projectDir)}`;
    this.db.prepare('DELETE FROM model_settings WHERE key = ?').run(key);
  }

  /**
   * Resolve the effective model for a project.
   * Resolution order: per-project override > global default > hardcoded fallback
   */
  getEffectiveModels(projectDir: string): ModelSettings {
    const global = this.getGlobalModelSettings();
    const project = this.getProjectModelSettings(projectDir);

    if (!project) return global;

    return {
      inner_model: project.inner_model === 'global' ? global.inner_model : project.inner_model,
      outer_model: project.outer_model === 'global' ? global.outer_model : project.outer_model,
    };
  }

  // --- Session Monitor Settings ---

  getSessionMonitorSettings(): SessionMonitorSettingsRecord {
    const row = this.db.prepare(
      "SELECT * FROM session_monitor_settings WHERE key = 'global'"
    ).get() as SessionMonitorSettingsRow | undefined;
    return row
      ? {
          warningThreshold: row.warning_threshold,
          criticalThreshold: row.critical_threshold,
          autoHaltThreshold: row.auto_halt_threshold,
          autoHaltEnabled: row.auto_halt_enabled === 1,
          autoResumeAfterReset: row.auto_resume_after_reset === 1,
          pollIntervalMs: row.poll_interval_ms,
          idleTimeoutMs: row.idle_timeout_ms,
          pollingDisabled: row.polling_disabled === 1,
        }
      : {
          warningThreshold: 80,
          criticalThreshold: 90,
          autoHaltThreshold: 95,
          autoHaltEnabled: true,
          autoResumeAfterReset: false,
          pollIntervalMs: 120_000,
          idleTimeoutMs: 300_000,
          pollingDisabled: false,
        };
  }

  setSessionMonitorSettings(settings: Partial<SessionMonitorSettingsRecord>): void {
    const current = this.getSessionMonitorSettings();
    this.db.prepare(
      `INSERT OR REPLACE INTO session_monitor_settings
        (key, warning_threshold, critical_threshold, auto_halt_threshold, auto_halt_enabled, auto_resume_after_reset, poll_interval_ms, idle_timeout_ms, polling_disabled)
       VALUES ('global', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      settings.warningThreshold ?? current.warningThreshold,
      settings.criticalThreshold ?? current.criticalThreshold,
      settings.autoHaltThreshold ?? current.autoHaltThreshold,
      (settings.autoHaltEnabled ?? current.autoHaltEnabled) ? 1 : 0,
      (settings.autoResumeAfterReset ?? current.autoResumeAfterReset) ? 1 : 0,
      settings.pollIntervalMs ?? current.pollIntervalMs,
      settings.idleTimeoutMs ?? current.idleTimeoutMs,
      (settings.pollingDisabled ?? current.pollingDisabled) ? 1 : 0,
    );
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
