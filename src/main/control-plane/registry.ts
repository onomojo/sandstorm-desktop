import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import type { EffectiveBackend, BackendType } from './backend-resolution';
import {
  type TouchpointId,
  type RoutingAssignment,
  type PresetId,
  type AgentBackendKind,
} from './routing';

import { ProjectsModule } from './registry/projects';
import { StacksModule } from './registry/stacks';
import { TasksModule } from './registry/tasks';
import { TokensModule } from './registry/tokens';
import { PortsModule } from './registry/ports';
import { HistoryModule } from './registry/history';
import { ModelSettingsModule } from './registry/model-settings';
import { RoutingConfigModule } from './registry/routing-config';
import { TicketConfigModule } from './registry/ticket-config';
import { DarkFactoryModule } from './registry/dark-factory';
import { BoardModule } from './registry/board';
import { BackendSettingsModule } from './registry/backend-settings';
import { SecretsModule } from './registry/secrets';
import { SessionModule } from './registry/session';
import { EpicsModule } from './registry/epics';

/** Per-ticket phase token totals from tasks columns (backfill when task_token_steps absent). */
export interface TaskPhaseWeightRow {
  ticket: string;
  phase: 'execution' | 'review';
  totalTokens: number;
}

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
  | 'needs_key'
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
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'needs_human' | 'needs_key';
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

export type EpicStatus = 'running' | 'paused' | 'completed' | 'needs_human';
export type EpicTaskRole = 'build' | 'reconcile';
export type EpicTaskOrigin = 'planned' | 'gap';

export interface EpicRunState {
  epic_id: string;
  project_dir: string;
  status: EpicStatus;
  created_at: string;
  updated_at: string;
}

export interface EpicTask {
  epic_id: string;
  ticket_id: string;
  role: EpicTaskRole;
  origin: EpicTaskOrigin;
  crit_id: string | null;
  gap_cycles: number;
  done: number;
}

export class Registry {
  private db: Database.Database;
  private dbPath: string;
  private sessionProtectedTickets = new Set<string>();

  // Domain modules
  private projects: ProjectsModule;
  private stacks: StacksModule;
  private tasks: TasksModule;
  private tokens: TokensModule;
  private ports: PortsModule;
  private history: HistoryModule;
  private modelSettings: ModelSettingsModule;
  private routingConfig: RoutingConfigModule;
  private ticketConfig: TicketConfigModule;
  private darkFactory: DarkFactoryModule;
  private board: BoardModule;
  private backendSettings: BackendSettingsModule;
  private secrets: SecretsModule;
  private session: SessionModule;
  private epics: EpicsModule;

  /** Optional callback invoked after archiveStack — used by rollup store for cache invalidation. */
  onStackArchived?: (stackId: string) => void;
  /** Listeners invoked after setBoardTicketColumn. Signature includes projectDir so subscribers can key by (ticketId, projectDir). */
  private _boardTicketMovedListeners: Array<(ticketId: string, projectDir: string, column: string) => void> = [];

  private constructor(db: Database.Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
    this.projects = new ProjectsModule(db);
    this.stacks = new StacksModule(db);
    this.tasks = new TasksModule(db);
    this.tokens = new TokensModule(db);
    this.ports = new PortsModule(db);
    this.history = new HistoryModule(db);
    this.modelSettings = new ModelSettingsModule(db);
    this.routingConfig = new RoutingConfigModule(db, this.modelSettings);
    this.ticketConfig = new TicketConfigModule(db);
    this.darkFactory = new DarkFactoryModule(db);
    this.board = new BoardModule(db, this.sessionProtectedTickets, (ticketId, projectDir, column) => {
      for (const listener of this._boardTicketMovedListeners) {
        listener(ticketId, projectDir, column);
      }
    });
    this.backendSettings = new BackendSettingsModule(db);
    this.secrets = new SecretsModule(db);
    this.session = new SessionModule(db);
    this.epics = new EpicsModule(db);
  }

  static async create(dbPath?: string): Promise<Registry> {
    const resolvedPath =
      dbPath ?? (process.env.PLAYWRIGHT_TEST
        ? ':memory:'
        : path.join(app.getPath('userData'), 'sandstorm.db'));

    // Ensure directory exists (skip for in-memory databases)
    if (resolvedPath !== ':memory:') {
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
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

    if (currentVersion < 25) {
      // Provider credential matrix (#479): backend_secrets.value now stores a JSON bundle when
      // name = '__bundle__'. Existing single-field rows (name='api_key', value='sk-…') remain
      // readable — getBackendSecretBundle treats them as { [name]: value } for backward compat.
      // No DDL change: columns are unchanged, only value semantics widen.
      this.setSchemaVersion(25);
    }

    if (currentVersion < 26) {
      // Epic run-state persistence (#613): durable home for per-epic status, ticket membership,
      // gap-cycle counters, and the concurrency cap setting.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS epics (
          epic_id     TEXT PRIMARY KEY,
          project_dir TEXT NOT NULL,
          status      TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS epic_tasks (
          epic_id    TEXT NOT NULL,
          ticket_id  TEXT NOT NULL,
          role       TEXT NOT NULL,
          origin     TEXT NOT NULL,
          crit_id    TEXT,
          gap_cycles INTEGER NOT NULL DEFAULT 0,
          done       INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (epic_id, ticket_id)
        );
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS project_epic_settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      this.setSchemaVersion(26);
    }

    if (currentVersion < 27) {
      // Per-touchpoint provider credential store (#638)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS provider_secrets (
          key      TEXT NOT NULL,
          provider TEXT NOT NULL,
          value    TEXT NOT NULL,
          PRIMARY KEY (key, provider)
        );
      `);

      // Migrate backend_secrets + opencode_settings → provider_secrets.
      // For each scope key and surface, read the bundle and the configured provider,
      // then write to provider_secrets keyed by (key, provider).
      // Conflict rule: if both surfaces resolve to the same provider with differing bundles,
      // outer wins and a warning is logged.
      const secretKeys = this.db.prepare(
        'SELECT DISTINCT key FROM backend_secrets'
      ).all() as Array<{ key: string }>;

      for (const { key } of secretKeys) {
        const staged: Record<string, Record<string, string>> = {};
        for (const surface of ['inner', 'outer'] as const) {
          const bundle = this.secrets.getBackendSecretBundle(key, surface);
          if (!bundle) continue;
          const ocRow = this.db.prepare(
            'SELECT provider FROM opencode_settings WHERE key = ? AND surface = ?'
          ).get(key, surface) as { provider: string | null } | undefined;
          const provider = ocRow?.provider ?? 'anthropic';
          if (staged[provider]) {
            const existingStr = JSON.stringify(staged[provider]);
            const newStr = JSON.stringify(bundle);
            if (existingStr !== newStr && surface === 'outer') {
              console.warn(
                `[migration v27] Provider '${provider}' key '${key}': conflict — outer bundle wins over inner`
              );
              staged[provider] = bundle;
            }
          } else {
            staged[provider] = bundle;
          }
        }
        for (const [provider, bundle] of Object.entries(staged)) {
          this.db.prepare(
            'INSERT OR REPLACE INTO provider_secrets (key, provider, value) VALUES (?, ?, ?)'
          ).run(key, provider, JSON.stringify(bundle));
        }
      }

      // Update stored routing assignments to include provider.
      // claude → 'anthropic'; opencode → check opencode_settings for the surface, fallback 'anthropic'.
      const outerTouchpoints = new Set(['outer', 'refine', 'pr_description']);
      const routingRows = this.db.prepare(
        'SELECT key, assignments FROM model_routing'
      ).all() as Array<{ key: string; assignments: string }>;

      for (const row of routingRows) {
        try {
          const assignments = JSON.parse(row.assignments || '{}') as Record<
            string,
            { backend: string; model: string; provider?: string }
          >;
          let changed = false;
          for (const [touchpoint, assignment] of Object.entries(assignments)) {
            if (!assignment.provider) {
              if (assignment.backend === 'claude') {
                assignment.provider = 'anthropic';
              } else {
                const surface = outerTouchpoints.has(touchpoint) ? 'outer' : 'inner';
                const ocRow = this.db.prepare(
                  'SELECT provider FROM opencode_settings WHERE key = ? AND surface = ?'
                ).get(row.key, surface) as { provider: string | null } | undefined;
                assignment.provider = ocRow?.provider ?? 'anthropic';
              }
              changed = true;
            }
          }
          if (changed) {
            this.db.prepare('UPDATE model_routing SET assignments = ? WHERE key = ?')
              .run(JSON.stringify(assignments), row.key);
          }
        } catch { /* skip malformed rows */ }
      }

      this.setSchemaVersion(27);
    }

    if (currentVersion < 28) {
      // Add level and merge_strategy columns to project_dark_factory.
      // Backfill runs once inside the level-column guard (idempotent: never re-runs after columns exist).
      let levelColumnAdded = false;
      try {
        this.db.exec("ALTER TABLE project_dark_factory ADD COLUMN level TEXT NOT NULL DEFAULT 'manual'");
        levelColumnAdded = true;
      } catch { /* Column already exists */ }
      if (levelColumnAdded) {
        this.db.exec(
          "UPDATE project_dark_factory SET level = CASE WHEN enabled = 1 THEN 'dark_factory' ELSE 'manual' END"
        );
      }
      try {
        this.db.exec("ALTER TABLE project_dark_factory ADD COLUMN merge_strategy TEXT NOT NULL DEFAULT 'squash'");
      } catch { /* Column already exists */ }
      this.setSchemaVersion(28);
    }
  }

  // --- Projects ---

  addProject(directory: string, name?: string): Project { return this.projects.addProject(directory, name); }
  listProjects(): Project[] { return this.projects.listProjects(); }
  removeProject(id: number): void { this.projects.removeProject(id); }
  getProject(id: number): Project | undefined { return this.projects.getProject(id); }

  // --- Stacks ---

  createStack(stack: Omit<Stack, 'created_at' | 'updated_at' | 'error' | 'pr_url' | 'pr_number' | 'total_input_tokens' | 'total_output_tokens' | 'total_execution_input_tokens' | 'total_execution_output_tokens' | 'total_review_input_tokens' | 'total_review_output_tokens' | 'total_cache_read_tokens' | 'total_cache_creation_tokens' | 'rate_limit_reset_at' | 'current_model' | 'selfheal_continue_used' | 'latest_task_token_limited'>): Stack {
    return this.stacks.createStack(stack);
  }
  getStack(id: string): Stack | undefined { return this.stacks.getStack(id); }
  listStacks(): Stack[] { return this.stacks.listStacks(); }
  updateStackStatus(id: string, status: StackStatus, error?: string): void { this.stacks.updateStackStatus(id, status, error); }
  setPullRequest(id: string, prUrl: string, prNumber: number): void { this.stacks.setPullRequest(id, prUrl, prNumber); }
  deleteStack(id: string): void { this.stacks.deleteStack(id); }

  // --- Tasks (cross-domain: write task row + update stack status) ---

  createTask(stackId: string, prompt: string, model?: string): Task {
    const task = this.tasks.insertTask(stackId, prompt, model);
    this.stacks.updateStackStatus(stackId, 'running');
    return task;
  }

  completeTask(taskId: number, exitCode: number): void {
    const status = exitCode === 0 ? 'completed' : 'failed';
    const task = this.tasks.updateTaskStatus(taskId, status, exitCode);
    if (task) {
      this.stacks.updateStackStatus(task.stack_id, exitCode === 0 ? 'completed' : 'failed');
    }
  }

  completeTaskNeedsHuman(taskId: number, reason: string, questionsJson?: string | null): void {
    const task = this.tasks.updateTaskStatus(taskId, 'needs_human', 1, {
      warnings: reason,
      needs_human_questions: questionsJson ?? null,
    });
    if (task) {
      this.stacks.updateStackStatus(task.stack_id, 'needs_human');
    }
  }

  completeTaskNeedsKey(taskId: number, reason: string): void {
    const task = this.tasks.updateTaskStatus(taskId, 'needs_key', 1, { warnings: reason });
    if (task) {
      this.stacks.updateStackStatus(task.stack_id, 'needs_key');
    }
  }

  completeTaskVerifyBlockedEnvironmental(taskId: number, reason: string): void {
    const task = this.tasks.updateTaskStatus(taskId, 'needs_human', 1, { warnings: reason });
    if (task) {
      this.stacks.updateStackStatus(task.stack_id, 'verify_blocked_environmental');
    }
  }

  reopenTaskForResume(taskId: number): void { this.tasks.reopenTaskForResume(taskId); }
  getNeedsHumanQuestions(stackId: string): string | null { return this.tasks.getNeedsHumanQuestions(stackId); }
  setSelfhealContinueUsed(stackId: string, value: 0 | 1): void { this.stacks.setSelfhealContinueUsed(stackId, value); }
  getBranchesForTicket(ticketId: string): string[] { return this.stacks.getBranchesForTicket(ticketId); }
  getTasksForStack(stackId: string): Task[] { return this.tasks.getTasksForStack(stackId); }
  setTaskWarning(taskId: number, warning: string): void { this.tasks.setTaskWarning(taskId, warning); }
  updateTaskResolvedModel(taskId: number, resolvedModel: string): void { this.tasks.updateTaskResolvedModel(taskId, resolvedModel); }
  getRunningTask(stackId: string): Task | undefined { return this.tasks.getRunningTask(stackId); }
  getMostRecentTask(stackId: string): Task | undefined { return this.tasks.getMostRecentTask(stackId); }

  onBoardTicketMoved(listener: (ticketId: string, projectDir: string, column: string) => void): void {
    this._boardTicketMovedListeners.push(listener);
  }

  /** Exposes the underlying Database instance for modules that need direct SQL access (e.g. rollup store). */
  getDb(): Database.Database { return this.db; }

  // --- Token Usage ---

  updateTaskTokens(
    taskId: number,
    inputTokens: number,
    outputTokens: number,
    phaseBreakdown?: { executionInput: number; executionOutput: number; reviewInput: number; reviewOutput: number },
    cacheTokens?: { cacheRead: number; cacheCreation: number }
  ): void { this.tokens.updateTaskTokens(taskId, inputTokens, outputTokens, phaseBreakdown, cacheTokens); }

  setTaskSessionId(taskId: number, sessionId: string): void { this.tokens.setTaskSessionId(taskId, sessionId); }
  setTaskIterations(taskId: number, reviewIterations: number, verifyRetries: number): void { this.tokens.setTaskIterations(taskId, reviewIterations, verifyRetries); }

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
  }): void { this.tokens.updateTaskMetadata(taskId, metadata); }

  setTaskTokenSteps(taskId: number, steps: { iteration: number; phase: string; input_tokens: number; output_tokens: number }[]): void {
    this.tokens.setTaskTokenSteps(taskId, steps);
  }
  getTaskTokenSteps(taskId: number): TaskTokenStep[] { return this.tokens.getTaskTokenSteps(taskId); }
  getStepWeightsByTicket(): { ticket: string; phase: string; totalTokens: number }[] { return this.tokens.getStepWeightsByTicket(); }
  getTaskPhaseTokensByTicket(): TaskPhaseWeightRow[] { return this.tokens.getTaskPhaseTokensByTicket(); }
  validateTaskTokens(taskId: number): TokenValidationResult { return this.tokens.validateTaskTokens(taskId); }
  interruptTask(taskId: number): void { this.tokens.interruptTask(taskId); }
  setTaskResumedAt(taskId: number, ts: string): void { this.tokens.setTaskResumedAt(taskId, ts); }
  getStackTokenUsage(stackId: string): TokenUsage { return this.tokens.getStackTokenUsage(stackId); }

  // --- Ports ---

  setPorts(stackId: string, ports: Omit<PortMapping, 'stack_id'>[]): void { this.ports.setPorts(stackId, ports); }
  getPorts(stackId: string): PortMapping[] { return this.ports.getPorts(stackId); }
  getAllAllocatedPorts(): number[] { return this.ports.getAllAllocatedPorts(); }
  releasePorts(stackId: string): void { this.ports.releasePorts(stackId); }
  getPortByService(stackId: string, service: string, containerPort: number): PortMapping | undefined { return this.ports.getPortByService(stackId, service, containerPort); }
  setPort(stackId: string, service: string, hostPort: number, containerPort: number): void { this.ports.setPort(stackId, service, hostPort, containerPort); }
  setProxyContainerId(stackId: string, service: string, containerPort: number, proxyContainerId: string): void { this.ports.setProxyContainerId(stackId, service, containerPort, proxyContainerId); }
  releasePort(stackId: string, service: string, containerPort: number): void { this.ports.releasePort(stackId, service, containerPort); }

  // --- Stack History (cross-domain: reads stacks + tasks, writes history, fires callback) ---

  archiveStack(id: string, finalStatus: HistoryStatus): void {
    const stack = this.stacks.getStack(id);
    if (!stack) return;
    const latestTaskPrompt = this.tasks.getMostRecentTask(id)?.prompt ?? null;
    const tasks = this.tasks.getTasksForStack(id);
    this.history.insertArchiveRecord(stack, latestTaskPrompt, tasks, finalStatus);
    this.onStackArchived?.(id);
  }

  listStackHistory(): StackHistoryRecord[] { return this.history.listStackHistory(); }
  purgeOldHistory(retentionDays: number = 14): number { return this.history.purgeOldHistory(retentionDays); }
  cleanupLegacyStackJsonFiles(projectDir: string): void { this.history.cleanupLegacyStackJsonFiles(projectDir); }

  // --- Model Settings ---

  getGlobalModelSettings(): ModelSettings { return this.modelSettings.getGlobalModelSettings(); }
  setGlobalModelSettings(settings: Partial<ModelSettings>): void { this.modelSettings.setGlobalModelSettings(settings); }
  getProjectModelSettings(projectDir: string): ModelSettings | null { return this.modelSettings.getProjectModelSettings(projectDir); }
  setProjectModelSettings(projectDir: string, settings: Partial<ModelSettings>): void { this.modelSettings.setProjectModelSettings(projectDir, settings); }
  removeProjectModelSettings(projectDir: string): void { this.modelSettings.removeProjectModelSettings(projectDir); }

  // --- Model Routing ---

  getLegacyEffectiveModels(projectDir: string): ModelSettings { return this.routingConfig.getLegacyEffectiveModels(projectDir); }
  getGlobalRouting(): RoutingConfig { return this.routingConfig.getGlobalRouting(); }
  setGlobalRouting(config: Partial<RoutingConfig>): void { this.routingConfig.setGlobalRouting(config); }
  getProjectRouting(projectDir: string): RoutingConfig | null { return this.routingConfig.getProjectRouting(projectDir); }
  setProjectRouting(projectDir: string, config: Partial<RoutingConfig>): void { this.routingConfig.setProjectRouting(projectDir, config); }
  removeProjectRouting(projectDir: string): void { this.routingConfig.removeProjectRouting(projectDir); }
  applyPreset(projectDir: string, presetId: PresetId): void { this.routingConfig.applyPreset(projectDir, presetId); }
  getEffectiveRoutingFor(projectDir: string, touchpoint: TouchpointId): RoutingAssignment { return this.routingConfig.getEffectiveRoutingFor(projectDir, touchpoint); }
  getEffectiveRouting(projectDir: string): Record<TouchpointId, RoutingAssignment> { return this.routingConfig.getEffectiveRouting(projectDir); }
  getContainerPhaseModels(projectDir: string): Record<'execution' | 'review' | 'meta_review', RoutingAssignment> { return this.routingConfig.getContainerPhaseModels(projectDir); }

  // --- Project Ticket Config ---

  getProjectTicketConfig(projectDir: string): ProjectTicketConfig | null { return this.ticketConfig.getProjectTicketConfig(projectDir); }
  setProjectTicketConfig(projectDir: string, config: ProjectTicketConfig): void { this.ticketConfig.setProjectTicketConfig(projectDir, config); }
  removeProjectTicketConfig(projectDir: string): void { this.ticketConfig.removeProjectTicketConfig(projectDir); }

  // --- Dark Factory ---

  getDarkFactoryEnabled(projectDir: string): boolean { return this.darkFactory.getDarkFactoryEnabled(projectDir); }
  setDarkFactoryEnabled(projectDir: string, enabled: boolean): void { this.darkFactory.setDarkFactoryEnabled(projectDir, enabled); }
  getDarkFactoryConfig(projectDir: string): { level: string; merge_strategy: string } { return this.darkFactory.getDarkFactoryConfig(projectDir); }
  setDarkFactoryConfig(projectDir: string, config: { level: string; merge_strategy: string }): void { this.darkFactory.setDarkFactoryConfig(projectDir, config); }

  // --- Ticket Board ---

  seedBoardTicket(ticketId: string, projectDir: string, title: string): void { this.board.seedBoardTicket(ticketId, projectDir, title); }
  setBoardTicketColumn(ticketId: string, projectDir: string, column: string): void { this.board.setBoardTicketColumn(ticketId, projectDir, column); }
  advanceTicketToPrOpenIfInStack(ticketId: string, projectDir: string): void { this.board.advanceTicketToPrOpenIfInStack(ticketId, projectDir); }
  reconcilePrOpenStuckTickets(): void { this.board.reconcilePrOpenStuckTickets(); }
  reconcilePrCreatedTickets(): void { this.board.reconcilePrCreatedTickets(); }
  listBoardTickets(projectDir: string): { ticket_id: string; project_dir: string; column: string; title: string; created_at: string; updated_at: string }[] { return this.board.listBoardTickets(projectDir); }
  listBoardTicketsInOrder(projectDir: string, orderedIds: string[]): { ticket_id: string; project_dir: string; column: string; title: string; created_at: string; updated_at: string }[] { return this.board.listBoardTicketsInOrder(projectDir, orderedIds); }
  deleteClosedEarlyColumnTickets(projectDir: string, openTicketIds: string[]): number { return this.board.deleteClosedEarlyColumnTickets(projectDir, openTicketIds); }
  deleteBoardTicket(ticketId: string, projectDir: string): void { this.board.deleteBoardTicket(ticketId, projectDir); }

  getEffectiveModels(projectDir: string): ModelSettings { return this.routingConfig.getEffectiveModels(projectDir); }

  // --- Backend Settings ---

  getGlobalBackendSettings(): BackendSettings { return this.backendSettings.getGlobalBackendSettings(); }
  setGlobalBackendSettings(settings: Partial<BackendSettings>): void { this.backendSettings.setGlobalBackendSettings(settings); }
  getProjectBackendSettings(projectDir: string): BackendSettings | null { return this.backendSettings.getProjectBackendSettings(projectDir); }
  setProjectBackendSettings(projectDir: string, settings: Partial<BackendSettings>): void { this.backendSettings.setProjectBackendSettings(projectDir, settings); }
  getEffectiveBackend(projectDir: string, surface: 'inner' | 'outer'): EffectiveBackend { return this.backendSettings.getEffectiveBackend(projectDir, surface); }

  // --- Backend Secrets ---

  setBackendSecret(key: string, surface: 'inner' | 'outer', name: string, value: string): void { this.secrets.setBackendSecret(key, surface, name, value); }
  hasBackendSecret(key: string, surface: 'inner' | 'outer'): boolean { return this.secrets.hasBackendSecret(key, surface); }
  getBackendSecret(key: string, surface: 'inner' | 'outer'): string | null { return this.secrets.getBackendSecret(key, surface); }
  setBackendSecretBundle(key: string, surface: 'inner' | 'outer', bundle: Record<string, string>): void { this.secrets.setBackendSecretBundle(key, surface, bundle); }
  getBackendSecretBundle(key: string, surface: 'inner' | 'outer'): Record<string, string> | null { return this.secrets.getBackendSecretBundle(key, surface); }

  // --- Provider Secrets ---

  hasProviderSecret(key: string, provider: string): boolean { return this.secrets.hasProviderSecret(key, provider); }
  getProviderSecretBundle(key: string, provider: string): Record<string, string> | null { return this.secrets.getProviderSecretBundle(key, provider); }
  setProviderSecretBundle(key: string, provider: string, bundle: Record<string, string>): void { this.secrets.setProviderSecretBundle(key, provider, bundle); }
  removeProviderSecret(key: string, provider: string): void { this.secrets.removeProviderSecret(key, provider); }
  getStoredProviderKeys(scope: string): string[] { return this.secrets.getStoredProviderKeys(scope); }

  getEffectiveTouchpointDescriptor(
    projectDir: string,
    touchpoint: TouchpointId,
  ): { backend: AgentBackendKind; provider: string; model: string; credentials: Record<string, string> | null } {
    const assignment = this.routingConfig.getEffectiveRoutingFor(projectDir, touchpoint);
    const projectKey = `project:${path.resolve(projectDir)}`;
    const credentials =
      this.secrets.getProviderSecretBundle(projectKey, assignment.provider) ??
      this.secrets.getProviderSecretBundle('global', assignment.provider);
    return {
      backend: assignment.backend,
      provider: assignment.provider,
      model: assignment.model,
      credentials,
    };
  }

  // --- Session Monitor Settings ---

  getSessionMonitorSettings(): SessionMonitorSettingsRecord { return this.session.getSessionMonitorSettings(); }
  setSessionMonitorSettings(settings: Partial<SessionMonitorSettingsRecord>): void { this.session.setSessionMonitorSettings(settings); }

  // --- Epic Run State ---

  getEpicRunState(epicId: string): EpicRunState | null { return this.epics.getEpicRunState(epicId); }
  upsertEpicRunState(epicId: string, projectDir: string, status: EpicStatus): void { this.epics.upsertEpicRunState(epicId, projectDir, status); }
  getEpicTasks(epicId: string): EpicTask[] { return this.epics.getEpicTasks(epicId); }
  getAllEpicTasks(): EpicTask[] { return this.epics.getAllEpicTasks(); }
  getAllEpicIds(): string[] { return this.epics.getAllEpicIds(); }
  getEpicForTicket(ticketId: string): { epicId: string; role: EpicTaskRole; critId: string | null } | null { return this.epics.getEpicForTicket(ticketId); }
  upsertEpicTask(epicId: string, ticketId: string, opts: { role: EpicTaskRole; origin: EpicTaskOrigin; critId?: string | null }): void { this.epics.upsertEpicTask(epicId, ticketId, opts); }
  setEpicTaskDone(epicId: string, ticketId: string): void { this.epics.setEpicTaskDone(epicId, ticketId); }
  incrementGapCycles(epicId: string, ticketId: string): number { return this.epics.incrementGapCycles(epicId, ticketId); }
  getEpicMaxParallelStacks(projectDir: string): number { return this.epics.getEpicMaxParallelStacks(projectDir); }
  setEpicMaxParallelStacks(projectDir: string, n: number): void { this.epics.setEpicMaxParallelStacks(projectDir, n); }

  // --- Cleanup ---

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed
    }
  }
}
