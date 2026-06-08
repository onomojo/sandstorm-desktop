import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { KANBAN_COLUMNS } from '../../shared/kanban';
import { resolveEffectiveBackend } from './backend-resolution';
import type { GlobalBackendInput, ProjectBackendInput, EffectiveBackend, BackendType } from './backend-resolution';
import {
  TOUCHPOINTS,
  PRESETS,
  type TouchpointId,
  type RoutingAssignment,
  type PresetId,
} from './routing';

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
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  rate_limit_reset_at: string | null;
  created_at: string;
  updated_at: string;
  current_model: string | null;
  selfheal_continue_used: number;
  latest_task_token_limited: boolean;
}

export type StackStatus =
  | 'building'
  | 'rebuilding'
  | 'up'
  | 'running'
  | 'completed'
  | 'failed'
  | 'needs_human'
  | 'verify_blocked_environmental'
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
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'needs_human';
  exit_code: number | null;
  warnings: string | null;
  session_id: string | null;
  input_tokens: number;
  output_tokens: number;
  execution_input_tokens: number;
  execution_output_tokens: number;
  review_input_tokens: number;
  review_output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  review_iterations: number;
  verify_retries: number;
  review_verdicts: string | null;
  verify_outputs: string | null;
  execute_outputs: string | null;
  execution_summary: string | null;
  needs_human_questions: string | null;
  execution_started_at: string | null;
  execution_finished_at: string | null;
  review_started_at: string | null;
  review_finished_at: string | null;
  verify_started_at: string | null;
  verify_finished_at: string | null;
  started_at: string;
  finished_at: string | null;
  resumed_at: string | null;
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
  proxy_container_id: string | null;
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
  selfheal_continue_used: number;
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

export type { BackendType, EffectiveBackend } from './backend-resolution';

export interface BackendSettings {
  inner_backend: string;
  outer_backend: string;
  inner_provider: string | null;
  inner_model: string | null;
  outer_provider: string | null;
  outer_model: string | null;
}

export interface RoutingConfig {
  assignments: Partial<Record<TouchpointId, RoutingAssignment>>;
  preset: PresetId | null;
}

export type TicketProvider = 'github' | 'jira';

export interface ProjectTicketConfig {
  provider: TicketProvider;
  jira_url?: string | null;
  jira_username?: string | null;
  jira_api_token?: string | null;
  jira_project_key?: string | null;
  jira_issue_type?: string | null;
  ticket_prefix?: string | null;
  filter_mode?: 'assisted' | 'advanced' | null;
  filter_ownership?: 'created' | 'assigned' | null;
  filter_open_only?: boolean | null;
  filter_query?: string | null;
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

    if (currentVersion < 13) {
      // Add proxy_container_id to ports table for on-demand proxy-based port exposure
      try { this.db.exec('ALTER TABLE ports ADD COLUMN proxy_container_id TEXT'); } catch { /* exists */ }
      // Change composite PK to allow multiple ports per service (drop old constraint, recreate table)
      // SQLite doesn't support ALTER TABLE DROP CONSTRAINT, so we migrate data
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS ports_new (
            stack_id           TEXT NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
            service            TEXT NOT NULL,
            host_port          INTEGER NOT NULL UNIQUE,
            container_port     INTEGER NOT NULL,
            proxy_container_id TEXT,
            PRIMARY KEY (stack_id, service, container_port)
          );
          INSERT OR IGNORE INTO ports_new SELECT stack_id, service, host_port, container_port, proxy_container_id FROM ports;
          DROP TABLE ports;
          ALTER TABLE ports_new RENAME TO ports;
        `);
      } catch { /* migration already applied */ }
      this.setSchemaVersion(13);
    }

    if (currentVersion < 14) {
      // Add resumed_at column to tasks for tracking session-pause continuations
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN resumed_at TEXT'); } catch { /* exists */ }
      this.setSchemaVersion(14);
    }

    if (currentVersion < 15) {
      // Per-project ticket provider configuration: GitHub or Jira, stored with credentials
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS project_ticket_config (
          key              TEXT PRIMARY KEY,
          provider         TEXT NOT NULL,
          jira_url         TEXT,
          jira_username    TEXT,
          jira_api_token   TEXT,
          jira_project_key TEXT,
          jira_issue_type  TEXT,
          ticket_prefix    TEXT
        );
      `);
      this.setSchemaVersion(15);
    }

    if (currentVersion < 16) {
      // Kanban board state — tracks each ticket's column in the app-owned pipeline.
      // Rows seed lazily when tickets are fetched from the provider; column transitions
      // are driven by explicit user actions on the board (no reconciliation with provider state).
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ticket_board (
          ticket_id   TEXT NOT NULL,
          project_dir TEXT NOT NULL,
          column      TEXT NOT NULL DEFAULT 'backlog',
          title       TEXT NOT NULL DEFAULT '',
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (ticket_id, project_dir)
        );
      `);
      this.setSchemaVersion(16);
    }

    if (currentVersion < 17) {
      // Structured questions emitted by the agent at STOP_AND_ASK time.
      // Stored as a JSON string (RefineQuestion[]) so the renderer can render them.
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN needs_human_questions TEXT'); } catch { /* exists */ }

      // Per-project dark factory flag: opt-in automation of the post-refinement pipeline.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS project_dark_factory (
          key     TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 0
        );
      `);
      this.setSchemaVersion(17);
    }

    if (currentVersion < 18) {
      // Add per-task cache token columns for per-ticket cacheHit attribution.
      // DEFAULT 0 means historical tasks (pre-capture) naturally produce cacheHit = 0%.
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }

      // Aggregate cache columns on stacks to mirror existing phase-token pattern
      try { this.db.exec('ALTER TABLE stacks ADD COLUMN total_cache_read_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE stacks ADD COLUMN total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }

      this.setSchemaVersion(18);
    }

    if (currentVersion < 19) {
      // Rollup cache tables for per-ticket cost/token attribution.
      // ticket_rollups caches the aggregated per-ticket cost/token rollup.
      // rollup_dirty_stacks tracks stacks needing re-derivation.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ticket_rollups (
          ticket_id            TEXT PRIMARY KEY,
          title                TEXT NOT NULL DEFAULT '',
          column               TEXT,
          total_cost           REAL NOT NULL DEFAULT 0,
          total_input_tokens   INTEGER NOT NULL DEFAULT 0,
          total_output_tokens  INTEGER NOT NULL DEFAULT 0,
          total_cache_read     INTEGER NOT NULL DEFAULT 0,
          total_cache_creation INTEGER NOT NULL DEFAULT 0,
          primary_model        TEXT,
          unpriced             INTEGER NOT NULL DEFAULT 0,
          computed_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS rollup_dirty_stacks (
          stack_id  TEXT PRIMARY KEY,
          marked_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      this.setSchemaVersion(19);
    }

    if (currentVersion < 20) {
      // Retire orphaned #466 rollup cache (superseded by transcript pipeline, #499)
      this.db.exec('DROP TABLE IF EXISTS ticket_rollups');
      this.db.exec('DROP TABLE IF EXISTS rollup_dirty_stacks');
      this.setSchemaVersion(20);
    }

    if (currentVersion < 21) {
      // Per-touchpoint model routing: global + per-project routing maps with preset support
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS model_routing (
          key         TEXT PRIMARY KEY,
          assignments TEXT NOT NULL DEFAULT '{}',
          preset      TEXT
        );
      `);
      this.setSchemaVersion(21);
    }

    if (currentVersion < 22) {
      // Pluggable agent backend: persist per-surface backend choice and OpenCode credentials
      try { this.db.exec("ALTER TABLE model_settings ADD COLUMN inner_backend TEXT NOT NULL DEFAULT 'claude'"); } catch { /* column already exists */ }
      try { this.db.exec("ALTER TABLE model_settings ADD COLUMN outer_backend TEXT NOT NULL DEFAULT 'claude'"); } catch { /* column already exists */ }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS opencode_settings (
          key      TEXT NOT NULL,
          surface  TEXT NOT NULL,
          provider TEXT,
          model    TEXT,
          PRIMARY KEY (key, surface)
        );
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS backend_secrets (
          key     TEXT NOT NULL,
          surface TEXT NOT NULL,
          name    TEXT,
          value   TEXT,
          PRIMARY KEY (key, surface)
        );
      `);

      this.setSchemaVersion(22);
    }

    if (currentVersion < 23) {
      // Per-iteration execute output markers for failure timeline (#545)
      try { this.db.exec('ALTER TABLE tasks ADD COLUMN execute_outputs TEXT'); } catch { /* exists */ }
      // One-shot self-heal continuation guard on stacks (#545)
      try { this.db.exec('ALTER TABLE stacks ADD COLUMN selfheal_continue_used INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      // Mirror selfheal_continue_used in archive so the guard survives archival inspection
      try { this.db.exec('ALTER TABLE stack_history ADD COLUMN selfheal_continue_used INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
      this.setSchemaVersion(23);
    }

    if (currentVersion < 24) {
      // Per-project backlog filter config (#548)
      try { this.db.exec('ALTER TABLE project_ticket_config ADD COLUMN filter_mode TEXT'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE project_ticket_config ADD COLUMN filter_ownership TEXT'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE project_ticket_config ADD COLUMN filter_open_only INTEGER'); } catch { /* exists */ }
      try { this.db.exec('ALTER TABLE project_ticket_config ADD COLUMN filter_query TEXT'); } catch { /* exists */ }
      this.setSchemaVersion(24);
    }
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

  completeTaskNeedsHuman(taskId: number, reason: string, questionsJson?: string | null): void {
    this.db.prepare(
      "UPDATE tasks SET status = 'needs_human', exit_code = 1, warnings = ?, needs_human_questions = ?, finished_at = datetime('now') WHERE id = ?"
    ).run(reason, questionsJson ?? null, taskId);

    const task = this.db.prepare(
      'SELECT stack_id FROM tasks WHERE id = ?'
    ).get(taskId) as { stack_id: string } | undefined;
    if (task) {
      this.updateStackStatus(task.stack_id, 'needs_human');
    }
  }

  reopenTaskForResume(taskId: number): void {
    this.db.prepare(
      "UPDATE tasks SET status = 'running', finished_at = NULL, exit_code = NULL WHERE id = ?"
    ).run(taskId);
  }

  getNeedsHumanQuestions(stackId: string): string | null {
    const task = this.getMostRecentTask(stackId);
    if (!task || task.status !== 'needs_human') return null;
    return task.needs_human_questions ?? null;
  }

  setSelfhealContinueUsed(stackId: string, value: 0 | 1): void {
    this.db.prepare('UPDATE stacks SET selfheal_continue_used = ? WHERE id = ?').run(value, stackId);
  }

  /** Return all branch names (active stacks + stack_history) for the given ticket. */
  getBranchesForTicket(ticketId: string): string[] {
    const active = this.db.prepare(
      "SELECT branch FROM stacks WHERE ticket = ? AND branch IS NOT NULL"
    ).all(ticketId) as { branch: string }[];
    const history = this.db.prepare(
      "SELECT branch FROM stack_history WHERE ticket = ? AND branch IS NOT NULL"
    ).all(ticketId) as { branch: string }[];
    return [...active, ...history].map((r) => r.branch);
  }

  completeTaskVerifyBlockedEnvironmental(taskId: number, reason: string): void {
    this.db.prepare(
      "UPDATE tasks SET status = 'needs_human', exit_code = 1, warnings = ?, finished_at = datetime('now') WHERE id = ?"
    ).run(reason, taskId);

    const task = this.db.prepare(
      'SELECT stack_id FROM tasks WHERE id = ?'
    ).get(taskId) as { stack_id: string } | undefined;
    if (task) {
      this.updateStackStatus(task.stack_id, 'verify_blocked_environmental');
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

  /** Optional callback invoked after archiveStack — used by rollup store for cache invalidation. */
  onStackArchived?: (stackId: string) => void;
  /** Listeners invoked after setBoardTicketColumn. Signature includes projectDir so subscribers can key by (ticketId, projectDir). */
  private _boardTicketMovedListeners: Array<(ticketId: string, projectDir: string, column: string) => void> = [];

  onBoardTicketMoved(listener: (ticketId: string, projectDir: string, column: string) => void): void {
    this._boardTicketMovedListeners.push(listener);
  }

  /** Exposes the underlying Database instance for modules that need direct SQL access (e.g. rollup store). */
  getDb(): Database.Database {
    return this.db;
  }

  updateTaskTokens(
    taskId: number,
    inputTokens: number,
    outputTokens: number,
    phaseBreakdown?: {
      executionInput: number;
      executionOutput: number;
      reviewInput: number;
      reviewOutput: number;
    },
    cacheTokens?: {
      cacheRead: number;
      cacheCreation: number;
    }
  ): void {
    // Wrap in a transaction to prevent race conditions from concurrent task completions
    const updateFn = this.db.transaction(() => {
      // Read old values first so we can compute the delta for the stack aggregate
      const old = this.db.prepare(
        'SELECT stack_id, input_tokens, output_tokens, execution_input_tokens, execution_output_tokens, review_input_tokens, review_output_tokens, cache_read_tokens, cache_creation_tokens FROM tasks WHERE id = ?'
      ).get(taskId) as {
        stack_id: string;
        input_tokens: number;
        output_tokens: number;
        execution_input_tokens: number;
        execution_output_tokens: number;
        review_input_tokens: number;
        review_output_tokens: number;
        cache_read_tokens: number;
        cache_creation_tokens: number;
      } | undefined;
      if (!old) return;

      const inputDelta = inputTokens - old.input_tokens;
      const outputDelta = outputTokens - old.output_tokens;
      const cacheReadDelta = (cacheTokens?.cacheRead ?? old.cache_read_tokens) - old.cache_read_tokens;
      const cacheCreationDelta = (cacheTokens?.cacheCreation ?? old.cache_creation_tokens) - old.cache_creation_tokens;

      if (phaseBreakdown) {
        const execInDelta = phaseBreakdown.executionInput - old.execution_input_tokens;
        const execOutDelta = phaseBreakdown.executionOutput - old.execution_output_tokens;
        const revInDelta = phaseBreakdown.reviewInput - old.review_input_tokens;
        const revOutDelta = phaseBreakdown.reviewOutput - old.review_output_tokens;

        // SET (not increment) — phase totals are cumulative values
        this.db.prepare(
          'UPDATE tasks SET input_tokens = ?, output_tokens = ?, execution_input_tokens = ?, execution_output_tokens = ?, review_input_tokens = ?, review_output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ? WHERE id = ?'
        ).run(
          inputTokens, outputTokens,
          phaseBreakdown.executionInput, phaseBreakdown.executionOutput,
          phaseBreakdown.reviewInput, phaseBreakdown.reviewOutput,
          cacheTokens?.cacheRead ?? old.cache_read_tokens,
          cacheTokens?.cacheCreation ?? old.cache_creation_tokens,
          taskId
        );

        // Update stack aggregate by the delta
        if (inputDelta !== 0 || outputDelta !== 0 || execInDelta !== 0 || execOutDelta !== 0 || revInDelta !== 0 || revOutDelta !== 0 || cacheReadDelta !== 0 || cacheCreationDelta !== 0) {
          this.db.prepare(
            `UPDATE stacks SET
              total_input_tokens = total_input_tokens + ?,
              total_output_tokens = total_output_tokens + ?,
              total_execution_input_tokens = total_execution_input_tokens + ?,
              total_execution_output_tokens = total_execution_output_tokens + ?,
              total_review_input_tokens = total_review_input_tokens + ?,
              total_review_output_tokens = total_review_output_tokens + ?,
              total_cache_read_tokens = total_cache_read_tokens + ?,
              total_cache_creation_tokens = total_cache_creation_tokens + ?
            WHERE id = ?`
          ).run(inputDelta, outputDelta, execInDelta, execOutDelta, revInDelta, revOutDelta, cacheReadDelta, cacheCreationDelta, old.stack_id);
        }
      } else {
        // Legacy path — no phase breakdown
        this.db.prepare(
          'UPDATE tasks SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ? WHERE id = ?'
        ).run(inputTokens, outputTokens, cacheTokens?.cacheRead ?? old.cache_read_tokens, cacheTokens?.cacheCreation ?? old.cache_creation_tokens, taskId);

        // Update stack aggregate by the delta
        if (inputDelta !== 0 || outputDelta !== 0 || cacheReadDelta !== 0 || cacheCreationDelta !== 0) {
          this.db.prepare(
            'UPDATE stacks SET total_input_tokens = total_input_tokens + ?, total_output_tokens = total_output_tokens + ?, total_cache_read_tokens = total_cache_read_tokens + ?, total_cache_creation_tokens = total_cache_creation_tokens + ? WHERE id = ?'
          ).run(inputDelta, outputDelta, cacheReadDelta, cacheCreationDelta, old.stack_id);
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
    execute_outputs?: string;
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
   * Return per-ticket, per-phase token weight totals for lifecycle cost splitting.
   * Joins task_token_steps → tasks → stacks to resolve the ticket for each step.
   * Only rows where stacks.ticket IS NOT NULL are included (excludes ad-hoc stacks).
   */
  getStepWeightsByTicket(): { ticket: string; phase: string; totalTokens: number }[] {
    return this.db.prepare(`
      SELECT s.ticket, tts.phase, SUM(tts.input_tokens + tts.output_tokens) AS totalTokens
      FROM task_token_steps tts
      JOIN tasks t ON t.id = tts.task_id
      JOIN stacks s ON s.id = t.stack_id
      WHERE s.ticket IS NOT NULL
      GROUP BY s.ticket, tts.phase
    `).all() as { ticket: string; phase: string; totalTokens: number }[];
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

  interruptTask(taskId: number): void {
    this.db.prepare(
      "UPDATE tasks SET status = 'interrupted', finished_at = datetime('now') WHERE id = ? AND status = 'running'"
    ).run(taskId);
  }

  setTaskResumedAt(taskId: number, ts: string): void {
    this.db.prepare(
      'UPDATE tasks SET resumed_at = ? WHERE id = ?'
    ).run(ts, taskId);
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

  getPortByService(stackId: string, service: string, containerPort: number): PortMapping | undefined {
    return this.db.prepare(
      'SELECT * FROM ports WHERE stack_id = ? AND service = ? AND container_port = ?'
    ).get(stackId, service, containerPort) as PortMapping | undefined;
  }

  setPort(stackId: string, service: string, hostPort: number, containerPort: number): void {
    this.db.prepare(
      'INSERT INTO ports (stack_id, service, host_port, container_port) VALUES (?, ?, ?, ?)'
    ).run(stackId, service, hostPort, containerPort);
  }

  setProxyContainerId(stackId: string, service: string, containerPort: number, proxyContainerId: string): void {
    this.db.prepare(
      'UPDATE ports SET proxy_container_id = ? WHERE stack_id = ? AND service = ? AND container_port = ?'
    ).run(proxyContainerId, stackId, service, containerPort);
  }

  releasePort(stackId: string, service: string, containerPort: number): void {
    this.db.prepare(
      'DELETE FROM ports WHERE stack_id = ? AND service = ? AND container_port = ?'
    ).run(stackId, service, containerPort);
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
      latestTask?.prompt ?? null,
      taskHistory,
      stack.created_at,
      durationSeconds,
      stack.selfheal_continue_used ?? 0,
    );

    this.onStackArchived?.(id);
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
    // Use UPDATE to avoid resetting the new inner_backend/outer_backend columns
    this.db.prepare(
      "UPDATE model_settings SET inner_model = ?, outer_model = ? WHERE key = 'global'"
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
    // INSERT OR IGNORE ensures row exists with backend defaults; UPDATE sets only model columns
    this.db.prepare(
      "INSERT OR IGNORE INTO model_settings (key, inner_model, outer_model, inner_backend, outer_backend) VALUES (?, 'global', 'global', 'global', 'global')"
    ).run(key);
    this.db.prepare(
      'UPDATE model_settings SET inner_model = ?, outer_model = ? WHERE key = ?'
    ).run(inner, outer, key);
  }

  removeProjectModelSettings(projectDir: string): void {
    const key = `project:${path.resolve(projectDir)}`;
    this.db.prepare('DELETE FROM model_settings WHERE key = ?').run(key);
  }

  // --- Model Routing ---

  private parseAssignments(json: string): Partial<Record<TouchpointId, RoutingAssignment>> {
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Partial<Record<TouchpointId, RoutingAssignment>>;
      }
      return {};
    } catch {
      return {};
    }
  }

  private getLegacyEffectiveModels(projectDir: string): ModelSettings {
    const global = this.getGlobalModelSettings();
    const project = this.getProjectModelSettings(projectDir);
    if (!project) return global;
    return {
      inner_model: project.inner_model === 'global' ? global.inner_model : project.inner_model,
      outer_model: project.outer_model === 'global' ? global.outer_model : project.outer_model,
    };
  }

  getGlobalRouting(): RoutingConfig {
    const row = this.db.prepare(
      "SELECT assignments, preset FROM model_routing WHERE key = 'global'"
    ).get() as { assignments: string; preset: string | null } | undefined;
    if (!row) return { assignments: {}, preset: null };
    return {
      assignments: this.parseAssignments(row.assignments),
      preset: (row.preset as PresetId | null) ?? null,
    };
  }

  setGlobalRouting(config: Partial<RoutingConfig>): void {
    const current = this.getGlobalRouting();
    const assignments = config.assignments !== undefined ? config.assignments : current.assignments;
    const preset = config.preset !== undefined ? config.preset : current.preset;
    this.db.prepare(
      "INSERT OR REPLACE INTO model_routing (key, assignments, preset) VALUES ('global', ?, ?)"
    ).run(JSON.stringify(assignments), preset ?? null);
  }

  getProjectRouting(projectDir: string): RoutingConfig | null {
    const key = `project:${path.resolve(projectDir)}`;
    const row = this.db.prepare(
      'SELECT assignments, preset FROM model_routing WHERE key = ?'
    ).get(key) as { assignments: string; preset: string | null } | undefined;
    if (!row) return null;
    return {
      assignments: this.parseAssignments(row.assignments),
      preset: (row.preset as PresetId | null) ?? null,
    };
  }

  setProjectRouting(projectDir: string, config: Partial<RoutingConfig>): void {
    const key = `project:${path.resolve(projectDir)}`;
    const existing = this.getProjectRouting(projectDir);
    const assignments = config.assignments !== undefined ? config.assignments : (existing?.assignments ?? {});
    const preset = config.preset !== undefined ? config.preset : (existing?.preset ?? null);
    this.db.prepare(
      'INSERT OR REPLACE INTO model_routing (key, assignments, preset) VALUES (?, ?, ?)'
    ).run(key, JSON.stringify(assignments), preset ?? null);
  }

  removeProjectRouting(projectDir: string): void {
    const key = `project:${path.resolve(projectDir)}`;
    this.db.prepare('DELETE FROM model_routing WHERE key = ?').run(key);
  }

  applyPreset(projectDir: string, presetId: PresetId): void {
    if (!(presetId in PRESETS)) throw new Error(`Unknown preset: ${presetId}`);
    const key = `project:${path.resolve(projectDir)}`;
    this.db.prepare(
      'INSERT OR REPLACE INTO model_routing (key, assignments, preset) VALUES (?, ?, ?)'
    ).run(key, '{}', presetId);
  }

  getEffectiveRoutingFor(projectDir: string, touchpoint: TouchpointId): RoutingAssignment {
    const projectRow = this.getProjectRouting(projectDir);
    if (projectRow) {
      if (projectRow.assignments[touchpoint]) {
        return projectRow.assignments[touchpoint]!;
      }
      if (projectRow.preset && projectRow.preset in PRESETS) {
        return PRESETS[projectRow.preset][touchpoint];
      }
    }

    const globalRow = this.getGlobalRouting();
    if (globalRow.assignments[touchpoint]) {
      return globalRow.assignments[touchpoint]!;
    }
    if (globalRow.preset && globalRow.preset in PRESETS) {
      return PRESETS[globalRow.preset][touchpoint];
    }

    const legacy = this.getLegacyEffectiveModels(projectDir);
    const outerTouchpoints: TouchpointId[] = ['outer', 'refine', 'pr_description'];
    if (outerTouchpoints.includes(touchpoint)) {
      return { backend: 'claude', model: legacy.outer_model };
    }
    return { backend: 'claude', model: legacy.inner_model };
  }

  getEffectiveRouting(projectDir: string): Record<TouchpointId, RoutingAssignment> {
    const result = {} as Record<TouchpointId, RoutingAssignment>;
    for (const t of TOUCHPOINTS) {
      result[t] = this.getEffectiveRoutingFor(projectDir, t);
    }
    return result;
  }

  getContainerPhaseModels(projectDir: string): Record<'execution' | 'review' | 'meta_review', RoutingAssignment> {
    return {
      execution:   this.getEffectiveRoutingFor(projectDir, 'execution'),
      review:      this.getEffectiveRoutingFor(projectDir, 'review'),
      meta_review: this.getEffectiveRoutingFor(projectDir, 'meta_review'),
    };
  }

  // --- Project Ticket Config ---

  getProjectTicketConfig(projectDir: string): ProjectTicketConfig | null {
    const key = `project:${path.resolve(projectDir)}`;
    const row = this.db.prepare(
      'SELECT provider, jira_url, jira_username, jira_api_token, jira_project_key, jira_issue_type, ticket_prefix, filter_mode, filter_ownership, filter_open_only, filter_query FROM project_ticket_config WHERE key = ?'
    ).get(key) as (Omit<ProjectTicketConfig, 'provider' | 'filter_open_only'> & { provider: string; filter_open_only: number | null }) | undefined;
    if (!row) return null;
    return {
      provider: row.provider as TicketProvider,
      jira_url: row.jira_url,
      jira_username: row.jira_username,
      jira_api_token: row.jira_api_token,
      jira_project_key: row.jira_project_key,
      jira_issue_type: row.jira_issue_type,
      ticket_prefix: row.ticket_prefix,
      filter_mode: (row.filter_mode as 'assisted' | 'advanced' | null) ?? null,
      filter_ownership: (row.filter_ownership as 'created' | 'assigned' | null) ?? null,
      filter_open_only: row.filter_open_only != null ? row.filter_open_only !== 0 : null,
      filter_query: row.filter_query ?? null,
    };
  }

  setProjectTicketConfig(projectDir: string, config: ProjectTicketConfig): void {
    const key = `project:${path.resolve(projectDir)}`;
    this.db.prepare(
      `INSERT OR REPLACE INTO project_ticket_config
        (key, provider, jira_url, jira_username, jira_api_token, jira_project_key, jira_issue_type, ticket_prefix, filter_mode, filter_ownership, filter_open_only, filter_query)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      key,
      config.provider,
      config.jira_url ?? null,
      config.jira_username ?? null,
      config.jira_api_token ?? null,
      config.jira_project_key ?? null,
      config.jira_issue_type ?? null,
      config.ticket_prefix ?? null,
      config.filter_mode ?? null,
      config.filter_ownership ?? null,
      config.filter_open_only != null ? (config.filter_open_only ? 1 : 0) : null,
      config.filter_query ?? null,
    );
  }

  removeProjectTicketConfig(projectDir: string): void {
    const key = `project:${path.resolve(projectDir)}`;
    this.db.prepare('DELETE FROM project_ticket_config WHERE key = ?').run(key);
  }

  // --- Dark Factory ---

  getDarkFactoryEnabled(projectDir: string): boolean {
    const key = `project:${path.resolve(projectDir)}`;
    const row = this.db.prepare('SELECT enabled FROM project_dark_factory WHERE key = ?').get(key) as { enabled: number } | undefined;
    return row ? row.enabled === 1 : false;
  }

  setDarkFactoryEnabled(projectDir: string, enabled: boolean): void {
    const key = `project:${path.resolve(projectDir)}`;
    this.db.prepare(
      'INSERT OR REPLACE INTO project_dark_factory (key, enabled) VALUES (?, ?)'
    ).run(key, enabled ? 1 : 0);
  }

  // --- Ticket Board ---

  /** Lazily inserts a ticket at 'backlog' if it doesn't exist; leaves column untouched if it does. */
  seedBoardTicket(ticketId: string, projectDir: string, title: string): void {
    const normalizedDir = path.resolve(projectDir);
    this.db.prepare(
      `INSERT INTO ticket_board (ticket_id, project_dir, column, title)
       VALUES (?, ?, 'backlog', ?)
       ON CONFLICT(ticket_id, project_dir) DO UPDATE SET title = excluded.title`
    ).run(ticketId, normalizedDir, title);
  }

  /** Moves a ticket to a new column. Inserts at the target column if the row doesn't exist. */
  setBoardTicketColumn(ticketId: string, projectDir: string, column: string): void {
    const normalizedDir = path.resolve(projectDir);
    this.db.prepare(
      `INSERT INTO ticket_board (ticket_id, project_dir, column, title)
       VALUES (?, ?, ?, '')
       ON CONFLICT(ticket_id, project_dir) DO UPDATE SET column = excluded.column, updated_at = datetime('now')`
    ).run(ticketId, normalizedDir, column);
    for (const listener of this._boardTicketMovedListeners) {
      listener(ticketId, normalizedDir, column);
    }
  }

  /**
   * Forward-only guard: advances a linked ticket from in_stack → pr_open.
   * No-op if the ticket does not exist or is not currently in in_stack.
   */
  advanceTicketToPrOpenIfInStack(ticketId: string, projectDir: string): void {
    const tickets = this.listBoardTickets(projectDir);
    const ticket = tickets.find(t => t.ticket_id === ticketId);
    if (ticket?.column === 'in_stack') {
      this.setBoardTicketColumn(ticketId, projectDir, 'pr_open');
    }
  }

  /**
   * Startup repair: for every pr_open board ticket whose linked stack has pr_number == null,
   * move the ticket back to in_stack. This repairs cards stranded in pr_open after a failed
   * PR creation (pr_number is set atomically with pr_url only on success).
   * Cards with no linked stack are left unchanged — the stack may be gone and moving back
   * could be wrong.
   */
  reconcilePrOpenStuckTickets(): void {
    const rows = this.db.prepare(
      `SELECT tb.ticket_id, tb.project_dir
       FROM ticket_board tb
       JOIN stacks s ON s.ticket = tb.ticket_id AND s.project_dir = tb.project_dir
       WHERE tb.column = 'pr_open' AND s.pr_number IS NULL`
    ).all() as { ticket_id: string; project_dir: string }[];
    for (const row of rows) {
      this.setBoardTicketColumn(row.ticket_id, row.project_dir, 'in_stack');
    }
  }

  /**
   * Backfill: for every stack with status='pr_created' and a non-null ticket,
   * advance the linked ticket from in_stack → pr_open (forward-only, idempotent).
   */
  reconcilePrCreatedTickets(): void {
    const stacks = this.db.prepare(
      "SELECT ticket, project_dir FROM stacks WHERE status = 'pr_created' AND ticket IS NOT NULL"
    ).all() as { ticket: string; project_dir: string }[];
    for (const stack of stacks) {
      this.advanceTicketToPrOpenIfInStack(stack.ticket, stack.project_dir);
    }
  }

  /** Returns all ticket_board rows for a project, ordered by created_at asc. */
  listBoardTickets(projectDir: string): { ticket_id: string; project_dir: string; column: string; title: string; created_at: string; updated_at: string }[] {
    const normalizedDir = path.resolve(projectDir);
    return this.db.prepare(
      `SELECT ticket_id, project_dir, column, title, created_at, updated_at
       FROM ticket_board WHERE project_dir = ? ORDER BY created_at ASC`
    ).all(normalizedDir) as { ticket_id: string; project_dir: string; column: string; title: string; created_at: string; updated_at: string }[];
  }

  /**
   * Hard-deletes board tickets in early columns (backlog, refining, spec_ready) whose ticket_id
   * is not in openTicketIds. Called after a successful provider sync to remove closed tickets.
   * Tickets in started columns (in_stack, pr_open, merged) are never touched.
   * Returns the number of rows deleted so the caller can log it.
   */
  deleteClosedEarlyColumnTickets(projectDir: string, openTicketIds: string[]): number {
    const normalizedDir = path.resolve(projectDir);
    // Derive early columns from the canonical KANBAN_COLUMNS constant (first 3 entries).
    const earlyColumns = KANBAN_COLUMNS.filter(c =>
      (['backlog', 'refining', 'spec_ready'] as readonly string[]).includes(c)
    );
    const earlyColSql = earlyColumns.map(c => `'${c}'`).join(',');

    if (openTicketIds.length === 0) {
      return this.db.prepare(
        `DELETE FROM ticket_board WHERE project_dir = ? AND column IN (${earlyColSql})`
      ).run(normalizedDir).changes;
    }

    const idPlaceholders = openTicketIds.map(() => '?').join(',');
    return this.db.prepare(
      `DELETE FROM ticket_board WHERE project_dir = ? AND column IN (${earlyColSql}) AND ticket_id NOT IN (${idPlaceholders})`
    ).run(normalizedDir, ...openTicketIds).changes;
  }

  /** Hard-deletes exactly one ticket_board row. No-op when the row is absent. */
  deleteBoardTicket(ticketId: string, projectDir: string): void {
    const normalizedDir = path.resolve(projectDir);
    this.db.prepare(
      `DELETE FROM ticket_board WHERE ticket_id = ? AND project_dir = ?`
    ).run(ticketId, normalizedDir);
  }

  getEffectiveModels(projectDir: string): ModelSettings {
    return {
      inner_model: this.getEffectiveRoutingFor(projectDir, 'execution').model,
      outer_model: this.getEffectiveRoutingFor(projectDir, 'outer').model,
    };
  }

  // --- Backend Settings ---

  getGlobalBackendSettings(): BackendSettings {
    const modelRow = this.db.prepare(
      "SELECT inner_backend, outer_backend FROM model_settings WHERE key = 'global'"
    ).get() as { inner_backend: string; outer_backend: string } | undefined;

    const innerOC = this.db.prepare(
      "SELECT provider, model FROM opencode_settings WHERE key = 'global' AND surface = 'inner'"
    ).get() as { provider: string | null; model: string | null } | undefined;

    const outerOC = this.db.prepare(
      "SELECT provider, model FROM opencode_settings WHERE key = 'global' AND surface = 'outer'"
    ).get() as { provider: string | null; model: string | null } | undefined;

    return {
      inner_backend: modelRow?.inner_backend ?? 'claude',
      outer_backend: modelRow?.outer_backend ?? 'claude',
      inner_provider: innerOC?.provider ?? null,
      inner_model: innerOC?.model ?? null,
      outer_provider: outerOC?.provider ?? null,
      outer_model: outerOC?.model ?? null,
    };
  }

  setGlobalBackendSettings(settings: Partial<BackendSettings>): void {
    const current = this.getGlobalBackendSettings();

    this.db.prepare(
      "UPDATE model_settings SET inner_backend = ?, outer_backend = ? WHERE key = 'global'"
    ).run(
      settings.inner_backend ?? current.inner_backend,
      settings.outer_backend ?? current.outer_backend,
    );

    this.db.prepare(
      "INSERT OR REPLACE INTO opencode_settings (key, surface, provider, model) VALUES ('global', 'inner', ?, ?)"
    ).run(
      settings.inner_provider !== undefined ? settings.inner_provider : current.inner_provider,
      settings.inner_model !== undefined ? settings.inner_model : current.inner_model,
    );

    this.db.prepare(
      "INSERT OR REPLACE INTO opencode_settings (key, surface, provider, model) VALUES ('global', 'outer', ?, ?)"
    ).run(
      settings.outer_provider !== undefined ? settings.outer_provider : current.outer_provider,
      settings.outer_model !== undefined ? settings.outer_model : current.outer_model,
    );
  }

  getProjectBackendSettings(projectDir: string): BackendSettings | null {
    const key = `project:${path.resolve(projectDir)}`;

    const modelRow = this.db.prepare(
      'SELECT inner_backend, outer_backend FROM model_settings WHERE key = ?'
    ).get(key) as { inner_backend: string; outer_backend: string } | undefined;

    if (!modelRow) return null;

    const innerOC = this.db.prepare(
      "SELECT provider, model FROM opencode_settings WHERE key = ? AND surface = 'inner'"
    ).get(key) as { provider: string | null; model: string | null } | undefined;

    const outerOC = this.db.prepare(
      "SELECT provider, model FROM opencode_settings WHERE key = ? AND surface = 'outer'"
    ).get(key) as { provider: string | null; model: string | null } | undefined;

    return {
      inner_backend: modelRow.inner_backend,
      outer_backend: modelRow.outer_backend,
      inner_provider: innerOC?.provider ?? null,
      inner_model: innerOC?.model ?? null,
      outer_provider: outerOC?.provider ?? null,
      outer_model: outerOC?.model ?? null,
    };
  }

  setProjectBackendSettings(projectDir: string, settings: Partial<BackendSettings>): void {
    const key = `project:${path.resolve(projectDir)}`;
    const existing = this.getProjectBackendSettings(projectDir);

    const inner_backend = settings.inner_backend ?? existing?.inner_backend ?? 'global';
    const outer_backend = settings.outer_backend ?? existing?.outer_backend ?? 'global';

    // Ensure row exists with safe defaults; then update only backend columns
    this.db.prepare(
      "INSERT OR IGNORE INTO model_settings (key, inner_model, outer_model, inner_backend, outer_backend) VALUES (?, 'global', 'global', 'global', 'global')"
    ).run(key);
    this.db.prepare(
      'UPDATE model_settings SET inner_backend = ?, outer_backend = ? WHERE key = ?'
    ).run(inner_backend, outer_backend, key);

    const inner_provider = settings.inner_provider !== undefined ? settings.inner_provider : (existing?.inner_provider ?? null);
    const inner_model = settings.inner_model !== undefined ? settings.inner_model : (existing?.inner_model ?? null);
    const outer_provider = settings.outer_provider !== undefined ? settings.outer_provider : (existing?.outer_provider ?? null);
    const outer_model = settings.outer_model !== undefined ? settings.outer_model : (existing?.outer_model ?? null);

    this.db.prepare(
      "INSERT OR REPLACE INTO opencode_settings (key, surface, provider, model) VALUES (?, 'inner', ?, ?)"
    ).run(key, inner_provider, inner_model);

    this.db.prepare(
      "INSERT OR REPLACE INTO opencode_settings (key, surface, provider, model) VALUES (?, 'outer', ?, ?)"
    ).run(key, outer_provider, outer_model);
  }

  getEffectiveBackend(projectDir: string, surface: 'inner' | 'outer'): EffectiveBackend {
    const globalSettings = this.getGlobalBackendSettings();
    const projectSettings = this.getProjectBackendSettings(projectDir);

    const globalInput: GlobalBackendInput = {
      inner_backend: globalSettings.inner_backend as BackendType,
      outer_backend: globalSettings.outer_backend as BackendType,
      inner_provider: globalSettings.inner_provider,
      inner_model: globalSettings.inner_model,
      outer_provider: globalSettings.outer_provider,
      outer_model: globalSettings.outer_model,
    };

    const projectInput: ProjectBackendInput | null = projectSettings
      ? {
          inner_backend: projectSettings.inner_backend,
          outer_backend: projectSettings.outer_backend,
          inner_provider: projectSettings.inner_provider,
          inner_model: projectSettings.inner_model,
          outer_provider: projectSettings.outer_provider,
          outer_model: projectSettings.outer_model,
        }
      : null;

    return resolveEffectiveBackend(globalInput, projectInput, surface);
  }

  // --- Backend Secrets ---

  setBackendSecret(key: string, surface: 'inner' | 'outer', name: string, value: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO backend_secrets (key, surface, name, value) VALUES (?, ?, ?, ?)'
    ).run(key, surface, name, value);
  }

  hasBackendSecret(key: string, surface: 'inner' | 'outer'): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM backend_secrets WHERE key = ? AND surface = ?'
    ).get(key, surface);
    return row != null;
  }

  getBackendSecret(key: string, surface: 'inner' | 'outer'): string | null {
    const row = this.db.prepare(
      'SELECT value FROM backend_secrets WHERE key = ? AND surface = ?'
    ).get(key, surface) as { value: string } | undefined;
    return row?.value ?? null;
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
