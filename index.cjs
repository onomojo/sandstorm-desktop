"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const electron = require("electron");
const path = require("path");
const Database = require("better-sqlite3");
const fs = require("fs");
const net = require("net");
const events = require("events");
const child_process = require("child_process");
const Dockerode = require("dockerode");
const http = require("http");
const crypto = require("crypto");
const os = require("os");
const nodePty = require("node-pty");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const nodePty__namespace = /* @__PURE__ */ _interopNamespaceDefault(nodePty);
class Registry {
  db;
  dbPath;
  constructor(db, dbPath) {
    this.db = db;
    this.dbPath = dbPath;
  }
  static async create(dbPath) {
    const resolvedPath = dbPath ?? path.join(electron.app.getPath("userData"), "sandstorm.db");
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const db = new Database(resolvedPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    const registry = new Registry(db, resolvedPath);
    registry.migrate();
    return registry;
  }
  getSchemaVersion() {
    try {
      const row = this.db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get();
      return row?.version ?? 0;
    } catch {
      return 0;
    }
  }
  setSchemaVersion(version) {
    this.db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, datetime('now'))").run(version);
  }
  migrate() {
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
      try {
        this.db.exec("ALTER TABLE stacks ADD COLUMN pr_url TEXT");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE stacks ADD COLUMN pr_number INTEGER");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN warnings TEXT");
      } catch {
      }
      this.setSchemaVersion(2);
    }
    if (currentVersion < 3) {
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN session_id TEXT");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE stacks ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE stacks ADD COLUMN total_output_tokens INTEGER NOT NULL DEFAULT 0");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE stacks ADD COLUMN rate_limit_reset_at TEXT");
      } catch {
      }
      this.setSchemaVersion(3);
    }
    if (currentVersion < 4) {
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN model TEXT");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate column")) throw err;
      }
      this.setSchemaVersion(4);
    }
    if (currentVersion < 5) {
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN review_iterations INTEGER NOT NULL DEFAULT 0");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN verify_retries INTEGER NOT NULL DEFAULT 0");
      } catch {
      }
      this.setSchemaVersion(5);
    }
    if (currentVersion < 6) {
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN resolved_model TEXT");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate column")) throw err;
      }
      this.setSchemaVersion(6);
    }
    if (currentVersion < 7) {
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN execution_input_tokens INTEGER NOT NULL DEFAULT 0");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN execution_output_tokens INTEGER NOT NULL DEFAULT 0");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN review_input_tokens INTEGER NOT NULL DEFAULT 0");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN review_output_tokens INTEGER NOT NULL DEFAULT 0");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE stacks ADD COLUMN total_execution_input_tokens INTEGER NOT NULL DEFAULT 0");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE stacks ADD COLUMN total_execution_output_tokens INTEGER NOT NULL DEFAULT 0");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE stacks ADD COLUMN total_review_input_tokens INTEGER NOT NULL DEFAULT 0");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE stacks ADD COLUMN total_review_output_tokens INTEGER NOT NULL DEFAULT 0");
      } catch {
      }
      this.setSchemaVersion(7);
    }
    if (currentVersion < 8) {
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN review_verdicts TEXT");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN verify_outputs TEXT");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN execution_summary TEXT");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN execution_started_at TEXT");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN execution_finished_at TEXT");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN review_started_at TEXT");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN review_finished_at TEXT");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN verify_started_at TEXT");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE tasks ADD COLUMN verify_finished_at TEXT");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE stack_history ADD COLUMN task_history TEXT");
      } catch {
      }
      this.setSchemaVersion(8);
    }
    if (currentVersion < 9) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS model_settings (
          key         TEXT PRIMARY KEY,
          inner_model TEXT NOT NULL DEFAULT 'sonnet',
          outer_model TEXT NOT NULL DEFAULT 'opus'
        );
      `);
      this.db.exec(`
        INSERT OR IGNORE INTO model_settings (key, inner_model, outer_model)
        VALUES ('global', 'sonnet', 'opus');
      `);
      this.setSchemaVersion(9);
    }
    if (currentVersion < 10) {
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
      try {
        this.db.exec("ALTER TABLE stacks ADD COLUMN current_model TEXT");
      } catch {
      }
      this.setSchemaVersion(11);
    }
    if (currentVersion < 12) {
      try {
        this.db.exec("ALTER TABLE session_monitor_settings ADD COLUMN idle_timeout_ms INTEGER NOT NULL DEFAULT 300000");
      } catch {
      }
      try {
        this.db.exec("ALTER TABLE session_monitor_settings ADD COLUMN polling_disabled INTEGER NOT NULL DEFAULT 0");
      } catch {
      }
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
  }
  // --- Projects ---
  addProject(directory, name) {
    const normalizedDir = path.resolve(directory);
    const projectName = name ?? path.basename(normalizedDir);
    const result = this.db.prepare(
      "INSERT INTO projects (name, directory) VALUES (?, ?)"
    ).run(projectName, normalizedDir);
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(result.lastInsertRowid);
  }
  listProjects() {
    return this.db.prepare("SELECT * FROM projects ORDER BY added_at ASC").all();
  }
  removeProject(id) {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
  getProject(id) {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
  }
  // --- Stacks ---
  createStack(stack) {
    const normalizedDir = path.resolve(stack.project_dir);
    this.db.prepare(
      `INSERT INTO stacks (id, project, project_dir, ticket, branch, description, status, runtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(stack.id, stack.project, normalizedDir, stack.ticket, stack.branch, stack.description, stack.status, stack.runtime);
    return this.getStack(stack.id);
  }
  getStack(id) {
    return this.db.prepare(
      `SELECT s.*, (SELECT model FROM tasks WHERE stack_id = s.id ORDER BY id DESC LIMIT 1) as current_model
       FROM stacks s WHERE s.id = ?`
    ).get(id);
  }
  listStacks() {
    return this.db.prepare(
      `SELECT s.*, (SELECT model FROM tasks WHERE stack_id = s.id ORDER BY id DESC LIMIT 1) as current_model
       FROM stacks s ORDER BY s.created_at DESC`
    ).all();
  }
  updateStackStatus(id, status, error) {
    if (error !== void 0) {
      this.db.prepare(
        "UPDATE stacks SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(status, error, id);
    } else {
      this.db.prepare(
        "UPDATE stacks SET status = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(status, id);
    }
  }
  setPullRequest(id, prUrl, prNumber) {
    this.db.prepare(
      "UPDATE stacks SET status = 'pr_created', pr_url = ?, pr_number = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(prUrl, prNumber, id);
  }
  deleteStack(id) {
    this.db.prepare("DELETE FROM stacks WHERE id = ?").run(id);
  }
  // --- Tasks ---
  createTask(stackId, prompt, model) {
    const result = this.db.prepare(
      "INSERT INTO tasks (stack_id, prompt, model, status) VALUES (?, ?, ?, 'running')"
    ).run(stackId, prompt, model ?? null);
    this.updateStackStatus(stackId, "running");
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(result.lastInsertRowid);
  }
  completeTask(taskId, exitCode) {
    const status = exitCode === 0 ? "completed" : "failed";
    this.db.prepare(
      "UPDATE tasks SET status = ?, exit_code = ?, finished_at = datetime('now') WHERE id = ?"
    ).run(status, exitCode, taskId);
    const task = this.db.prepare(
      "SELECT stack_id FROM tasks WHERE id = ?"
    ).get(taskId);
    if (task) {
      this.updateStackStatus(
        task.stack_id,
        exitCode === 0 ? "completed" : "failed"
      );
    }
  }
  getTasksForStack(stackId) {
    return this.db.prepare(
      "SELECT * FROM tasks WHERE stack_id = ? ORDER BY started_at DESC"
    ).all(stackId);
  }
  setTaskWarning(taskId, warning) {
    this.db.prepare(
      "UPDATE tasks SET warnings = ? WHERE id = ?"
    ).run(warning, taskId);
  }
  updateTaskResolvedModel(taskId, resolvedModel) {
    this.db.prepare(
      "UPDATE tasks SET resolved_model = ? WHERE id = ?"
    ).run(resolvedModel, taskId);
  }
  getRunningTask(stackId) {
    return this.db.prepare(
      "SELECT * FROM tasks WHERE stack_id = ? AND status = 'running' LIMIT 1"
    ).get(stackId);
  }
  getMostRecentTask(stackId) {
    return this.db.prepare(
      "SELECT * FROM tasks WHERE stack_id = ? ORDER BY started_at DESC LIMIT 1"
    ).get(stackId);
  }
  // --- Token Usage ---
  updateTaskTokens(taskId, inputTokens, outputTokens, phaseBreakdown) {
    const updateFn = this.db.transaction(() => {
      const old = this.db.prepare(
        "SELECT stack_id, input_tokens, output_tokens, execution_input_tokens, execution_output_tokens, review_input_tokens, review_output_tokens FROM tasks WHERE id = ?"
      ).get(taskId);
      if (!old) return;
      const inputDelta = inputTokens - old.input_tokens;
      const outputDelta = outputTokens - old.output_tokens;
      if (phaseBreakdown) {
        const execInDelta = phaseBreakdown.executionInput - old.execution_input_tokens;
        const execOutDelta = phaseBreakdown.executionOutput - old.execution_output_tokens;
        const revInDelta = phaseBreakdown.reviewInput - old.review_input_tokens;
        const revOutDelta = phaseBreakdown.reviewOutput - old.review_output_tokens;
        this.db.prepare(
          "UPDATE tasks SET input_tokens = ?, output_tokens = ?, execution_input_tokens = ?, execution_output_tokens = ?, review_input_tokens = ?, review_output_tokens = ? WHERE id = ?"
        ).run(
          inputTokens,
          outputTokens,
          phaseBreakdown.executionInput,
          phaseBreakdown.executionOutput,
          phaseBreakdown.reviewInput,
          phaseBreakdown.reviewOutput,
          taskId
        );
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
        this.db.prepare(
          "UPDATE tasks SET input_tokens = ?, output_tokens = ? WHERE id = ?"
        ).run(inputTokens, outputTokens, taskId);
        if (inputDelta !== 0 || outputDelta !== 0) {
          this.db.prepare(
            "UPDATE stacks SET total_input_tokens = total_input_tokens + ?, total_output_tokens = total_output_tokens + ? WHERE id = ?"
          ).run(inputDelta, outputDelta, old.stack_id);
        }
      }
    });
    updateFn();
  }
  setTaskSessionId(taskId, sessionId) {
    this.db.prepare("UPDATE tasks SET session_id = ? WHERE id = ?").run(sessionId, taskId);
  }
  setTaskIterations(taskId, reviewIterations, verifyRetries) {
    this.db.prepare(
      "UPDATE tasks SET review_iterations = ?, verify_retries = ? WHERE id = ?"
    ).run(reviewIterations, verifyRetries, taskId);
  }
  updateTaskMetadata(taskId, metadata) {
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== void 0) {
        sets.push(`${key} = ?`);
        values.push(value);
      }
    }
    if (sets.length === 0) return;
    values.push(taskId);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }
  // --- Task Token Steps ---
  setTaskTokenSteps(taskId, steps) {
    const insertOrUpdate = this.db.transaction(() => {
      this.db.prepare("DELETE FROM task_token_steps WHERE task_id = ?").run(taskId);
      const insert = this.db.prepare(
        "INSERT INTO task_token_steps (task_id, iteration, phase, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)"
      );
      for (const step of steps) {
        insert.run(taskId, step.iteration, step.phase, step.input_tokens, step.output_tokens);
      }
    });
    insertOrUpdate();
  }
  getTaskTokenSteps(taskId) {
    return this.db.prepare(
      "SELECT * FROM task_token_steps WHERE task_id = ? ORDER BY iteration ASC, CASE phase WHEN 'execution' THEN 0 WHEN 'review' THEN 1 WHEN 'verify' THEN 2 ELSE 99 END ASC"
    ).all(taskId);
  }
  /**
   * Validate that per-step token sums match phase totals and grand total.
   * Returns validation result with computed sums.
   */
  validateTaskTokens(taskId) {
    const task = this.db.prepare(
      "SELECT input_tokens, output_tokens, execution_input_tokens, execution_output_tokens, review_input_tokens, review_output_tokens FROM tasks WHERE id = ?"
    ).get(taskId);
    if (!task) {
      return { valid: true, stepTotal: { input: 0, output: 0 }, phaseTotal: { executionInput: 0, executionOutput: 0, reviewInput: 0, reviewOutput: 0 }, taskTotal: { input: 0, output: 0 } };
    }
    const steps = this.getTaskTokenSteps(taskId);
    let stepExecIn = 0, stepExecOut = 0, stepRevIn = 0, stepRevOut = 0;
    let stepTotalIn = 0, stepTotalOut = 0;
    for (const step of steps) {
      stepTotalIn += step.input_tokens;
      stepTotalOut += step.output_tokens;
      if (step.phase === "execution") {
        stepExecIn += step.input_tokens;
        stepExecOut += step.output_tokens;
      } else if (step.phase === "review") {
        stepRevIn += step.input_tokens;
        stepRevOut += step.output_tokens;
      }
    }
    const phaseTotalIn = task.execution_input_tokens + task.review_input_tokens;
    const phaseTotalOut = task.execution_output_tokens + task.review_output_tokens;
    const stepsMatchPhases = stepExecIn === task.execution_input_tokens && stepExecOut === task.execution_output_tokens && stepRevIn === task.review_input_tokens && stepRevOut === task.review_output_tokens;
    const phasesMatchTotal = phaseTotalIn <= task.input_tokens && phaseTotalOut <= task.output_tokens;
    return {
      valid: steps.length === 0 || stepsMatchPhases && phasesMatchTotal,
      stepTotal: { input: stepTotalIn, output: stepTotalOut },
      phaseTotal: {
        executionInput: task.execution_input_tokens,
        executionOutput: task.execution_output_tokens,
        reviewInput: task.review_input_tokens,
        reviewOutput: task.review_output_tokens
      },
      taskTotal: { input: task.input_tokens, output: task.output_tokens }
    };
  }
  // --- Project Token Usage (Outer Claude) ---
  getProjectTokenUsage(projectDir) {
    const normalizedDir = path.resolve(projectDir);
    return this.db.prepare(
      "SELECT * FROM project_token_usage WHERE project_dir = ?"
    ).get(normalizedDir);
  }
  addProjectTokenUsage(projectDir, inputTokens, outputTokens) {
    const normalizedDir = path.resolve(projectDir);
    const existing = this.db.prepare(
      "SELECT id FROM project_token_usage WHERE project_dir = ?"
    ).get(normalizedDir);
    if (existing) {
      this.db.prepare(
        "UPDATE project_token_usage SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = datetime('now') WHERE project_dir = ?"
      ).run(inputTokens, outputTokens, normalizedDir);
    } else {
      this.db.prepare(
        "INSERT INTO project_token_usage (project_dir, input_tokens, output_tokens) VALUES (?, ?, ?)"
      ).run(normalizedDir, inputTokens, outputTokens);
    }
  }
  listProjectTokenUsage() {
    return this.db.prepare(
      "SELECT * FROM project_token_usage ORDER BY updated_at DESC"
    ).all();
  }
  interruptTask(taskId) {
    this.db.prepare(
      "UPDATE tasks SET status = 'interrupted', finished_at = datetime('now') WHERE id = ? AND status = 'running'"
    ).run(taskId);
  }
  getStackTokenUsage(stackId) {
    const row = this.db.prepare(
      "SELECT total_input_tokens, total_output_tokens FROM stacks WHERE id = ?"
    ).get(stackId);
    return {
      input_tokens: row?.total_input_tokens ?? 0,
      output_tokens: row?.total_output_tokens ?? 0
    };
  }
  // --- Ports ---
  setPorts(stackId, ports) {
    const insertPort = this.db.prepare(
      "INSERT INTO ports (stack_id, service, host_port, container_port) VALUES (?, ?, ?, ?)"
    );
    const insertMany = this.db.transaction((items) => {
      for (const p of items) {
        insertPort.run(stackId, p.service, p.host_port, p.container_port);
      }
    });
    insertMany(ports);
  }
  getPorts(stackId) {
    return this.db.prepare(
      "SELECT * FROM ports WHERE stack_id = ? ORDER BY host_port ASC"
    ).all(stackId);
  }
  getAllAllocatedPorts() {
    return this.db.prepare(
      "SELECT host_port FROM ports"
    ).all().map((r) => r.host_port);
  }
  releasePorts(stackId) {
    this.db.prepare("DELETE FROM ports WHERE stack_id = ?").run(stackId);
  }
  // --- Stack History ---
  archiveStack(id, finalStatus) {
    const stack = this.getStack(id);
    if (!stack) return;
    const latestTask = this.db.prepare(
      "SELECT prompt FROM tasks WHERE stack_id = ? ORDER BY started_at DESC LIMIT 1"
    ).get(id);
    const tasks = this.getTasksForStack(id);
    const taskHistory = tasks.length > 0 ? JSON.stringify(tasks) : null;
    const createdMs = (/* @__PURE__ */ new Date(stack.created_at + "Z")).getTime();
    const nowMs = Date.now();
    const durationSeconds = Math.max(0, Math.floor((nowMs - createdMs) / 1e3));
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
      durationSeconds
    );
  }
  listStackHistory() {
    return this.db.prepare(
      "SELECT * FROM stack_history ORDER BY finished_at DESC"
    ).all();
  }
  purgeOldHistory(retentionDays = 14) {
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
  cleanupLegacyStackJsonFiles(projectDir) {
    const stacksDir = path.join(projectDir, ".sandstorm", "stacks");
    if (!fs.existsSync(stacksDir)) return;
    try {
      const entries = fs.readdirSync(stacksDir);
      for (const entry of entries) {
        if (entry.endsWith(".json")) {
          try {
            fs.unlinkSync(path.join(stacksDir, entry));
          } catch {
          }
        }
      }
    } catch {
    }
    const archiveDir = path.join(stacksDir, "archive");
    if (fs.existsSync(archiveDir)) {
      try {
        fs.rmSync(archiveDir, { recursive: true, force: true });
      } catch {
      }
    }
    try {
      const remaining = fs.readdirSync(stacksDir);
      if (remaining.length === 0) {
        fs.rmdirSync(stacksDir);
      }
    } catch {
    }
  }
  // --- Model Settings ---
  getGlobalModelSettings() {
    const row = this.db.prepare(
      "SELECT inner_model, outer_model FROM model_settings WHERE key = 'global'"
    ).get();
    return row ?? { inner_model: "sonnet", outer_model: "opus" };
  }
  setGlobalModelSettings(settings) {
    const current = this.getGlobalModelSettings();
    this.db.prepare(
      "INSERT OR REPLACE INTO model_settings (key, inner_model, outer_model) VALUES ('global', ?, ?)"
    ).run(
      settings.inner_model ?? current.inner_model,
      settings.outer_model ?? current.outer_model
    );
  }
  getProjectModelSettings(projectDir) {
    const key = `project:${path.resolve(projectDir)}`;
    const row = this.db.prepare(
      "SELECT inner_model, outer_model FROM model_settings WHERE key = ?"
    ).get(key);
    return row ?? null;
  }
  setProjectModelSettings(projectDir, settings) {
    const key = `project:${path.resolve(projectDir)}`;
    const existing = this.getProjectModelSettings(projectDir);
    const inner = settings.inner_model ?? existing?.inner_model ?? "global";
    const outer = settings.outer_model ?? existing?.outer_model ?? "global";
    this.db.prepare(
      "INSERT OR REPLACE INTO model_settings (key, inner_model, outer_model) VALUES (?, ?, ?)"
    ).run(key, inner, outer);
  }
  removeProjectModelSettings(projectDir) {
    const key = `project:${path.resolve(projectDir)}`;
    this.db.prepare("DELETE FROM model_settings WHERE key = ?").run(key);
  }
  /**
   * Resolve the effective model for a project.
   * Resolution order: per-project override > global default > hardcoded fallback
   */
  getEffectiveModels(projectDir) {
    const global = this.getGlobalModelSettings();
    const project = this.getProjectModelSettings(projectDir);
    if (!project) return global;
    return {
      inner_model: project.inner_model === "global" ? global.inner_model : project.inner_model,
      outer_model: project.outer_model === "global" ? global.outer_model : project.outer_model
    };
  }
  // --- Session Monitor Settings ---
  getSessionMonitorSettings() {
    const row = this.db.prepare(
      "SELECT * FROM session_monitor_settings WHERE key = 'global'"
    ).get();
    return row ? {
      warningThreshold: row.warning_threshold,
      criticalThreshold: row.critical_threshold,
      autoHaltThreshold: row.auto_halt_threshold,
      autoHaltEnabled: row.auto_halt_enabled === 1,
      autoResumeAfterReset: row.auto_resume_after_reset === 1,
      pollIntervalMs: row.poll_interval_ms,
      idleTimeoutMs: row.idle_timeout_ms,
      pollingDisabled: row.polling_disabled === 1
    } : {
      warningThreshold: 80,
      criticalThreshold: 90,
      autoHaltThreshold: 95,
      autoHaltEnabled: true,
      autoResumeAfterReset: false,
      pollIntervalMs: 12e4,
      idleTimeoutMs: 3e5,
      pollingDisabled: false
    };
  }
  setSessionMonitorSettings(settings) {
    const current = this.getSessionMonitorSettings();
    this.db.prepare(
      `INSERT OR REPLACE INTO session_monitor_settings
        (key, warning_threshold, critical_threshold, auto_halt_threshold, auto_halt_enabled, auto_resume_after_reset, poll_interval_ms, idle_timeout_ms, polling_disabled)
       VALUES ('global', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      settings.warningThreshold ?? current.warningThreshold,
      settings.criticalThreshold ?? current.criticalThreshold,
      settings.autoHaltThreshold ?? current.autoHaltThreshold,
      settings.autoHaltEnabled ?? current.autoHaltEnabled ? 1 : 0,
      settings.autoResumeAfterReset ?? current.autoResumeAfterReset ? 1 : 0,
      settings.pollIntervalMs ?? current.pollIntervalMs,
      settings.idleTimeoutMs ?? current.idleTimeoutMs,
      settings.pollingDisabled ?? current.pollingDisabled ? 1 : 0
    );
  }
  // --- Cleanup ---
  close() {
    try {
      this.db.close();
    } catch {
    }
  }
}
class PortAllocator {
  constructor(registry, range = [1e4, 19999]) {
    this.registry = registry;
    this.rangeStart = range[0];
    this.rangeEnd = range[1];
  }
  rangeStart;
  rangeEnd;
  async allocate(stackId, services) {
    const allocated = new Set(this.registry.getAllAllocatedPorts());
    const result = /* @__PURE__ */ new Map();
    const newPorts = [];
    for (const svc of services) {
      const port = await this.findAvailablePort(allocated);
      allocated.add(port);
      result.set(svc.service, port);
      newPorts.push({
        service: svc.service,
        host_port: port,
        container_port: svc.containerPort
      });
    }
    this.registry.setPorts(stackId, newPorts);
    return result;
  }
  release(stackId) {
    this.registry.releasePorts(stackId);
  }
  async findAvailablePort(excluded) {
    for (let port = this.rangeStart; port <= this.rangeEnd; port++) {
      if (excluded.has(port)) continue;
      if (await this.isPortFree(port)) {
        return port;
      }
    }
    throw new Error(
      `No available ports in range ${this.rangeStart}-${this.rangeEnd}`
    );
  }
  isPortFree(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
  }
}
function parsePhaseTokenTotals(output) {
  let input_tokens = 0;
  let output_tokens = 0;
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      input_tokens += parsed.in ?? 0;
      output_tokens += parsed.out ?? 0;
    } catch {
    }
  }
  return { input_tokens, output_tokens };
}
function parsePhaseTokenSteps(executionOutput, reviewOutput) {
  const stepMap = /* @__PURE__ */ new Map();
  function processLines(output, defaultPhase) {
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const iteration = parsed.iter ?? 1;
        const phase = parsed.phase ?? defaultPhase;
        const inTokens = parsed.in ?? 0;
        const outTokens = parsed.out ?? 0;
        if (inTokens === 0 && outTokens === 0) continue;
        const key = `${iteration}:${phase}`;
        const existing = stepMap.get(key);
        if (existing) {
          existing.input_tokens += inTokens;
          existing.output_tokens += outTokens;
        } else {
          stepMap.set(key, { iteration, phase, input_tokens: inTokens, output_tokens: outTokens });
        }
      } catch {
      }
    }
  }
  processLines(executionOutput, "execution");
  processLines(reviewOutput, "review");
  const phaseOrder = { execution: 0, review: 1, verify: 2 };
  return Array.from(stepMap.values()).sort((a, b) => {
    if (a.iteration !== b.iteration) return a.iteration - b.iteration;
    return (phaseOrder[a.phase] ?? 99) - (phaseOrder[b.phase] ?? 99);
  });
}
function parseTokenUsage(output) {
  let resultInputTotal = 0;
  let resultOutputTotal = 0;
  let currentTurnInput = 0;
  let currentTurnOutput = 0;
  let sessionId = null;
  let resolvedModel = null;
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "result" && parsed.usage) {
        resultInputTotal += parsed.usage.input_tokens ?? 0;
        resultOutputTotal += parsed.usage.output_tokens ?? 0;
        currentTurnInput = 0;
        currentTurnOutput = 0;
      }
      if (parsed.session_id) {
        sessionId = parsed.session_id;
      }
      const event = parsed.type === "stream_event" ? parsed.event : parsed;
      if (!event) continue;
      if (event.type === "message_start" && event.message) {
        if (event.message.model && !resolvedModel) {
          resolvedModel = event.message.model;
        }
        if (event.message.usage) {
          const msgUsage = event.message.usage;
          if (msgUsage.input_tokens) {
            currentTurnInput = msgUsage.input_tokens;
          }
          currentTurnOutput = 0;
        }
      }
      if (event.type === "message_delta" && event.usage) {
        if (event.usage.output_tokens) {
          currentTurnOutput = event.usage.output_tokens;
        }
      }
    } catch {
    }
  }
  return {
    input_tokens: resultInputTotal + currentTurnInput,
    output_tokens: resultOutputTotal + currentTurnOutput,
    session_id: sessionId,
    resolved_model: resolvedModel
  };
}
const MAX_CONSECUTIVE_ERRORS = 30;
const MAX_STALE_POLLS = 30;
const SUSPICIOUS_DURATION_MS = 3e4;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 3e4;
class TaskWatcher extends events.EventEmitter {
  constructor(registry, dockerRuntime, podmanRuntime, options) {
    super();
    this.registry = registry;
    this.dockerRuntime = dockerRuntime;
    this.podmanRuntime = podmanRuntime;
    this.pollInterval = options?.pollInterval ?? 2e3;
    this.tokenPollInterval = options?.tokenPollInterval ?? 5e3;
  }
  watchers = /* @__PURE__ */ new Map();
  errorCounts = /* @__PURE__ */ new Map();
  /** Tracks whether we've seen "running" status for the current watch cycle.
   *  Prevents stale "completed" from a prior task from triggering false completion.
   *  Assumes the task runner always writes "running" before completion and that
   *  at least one poll lands while the task is in "running" state (safe because
   *  Claude tasks take many seconds and the default poll interval is 2 s). */
  seenRunning = /* @__PURE__ */ new Map();
  stalePollCounts = /* @__PURE__ */ new Map();
  pollInterval;
  onStatusChange;
  /** Tracks the last time we polled tokens for each stack (to throttle reads) */
  lastTokenPoll = /* @__PURE__ */ new Map();
  /** How often to poll tokens while a task is running (ms) */
  tokenPollInterval;
  /** Track active output streams for cleanup */
  activeOutputStreams = /* @__PURE__ */ new Map();
  /** Track container IDs for each watched stack (for on-demand progress queries) */
  containerIds = /* @__PURE__ */ new Map();
  /**
   * Resolve the correct container runtime for a stack based on its stored
   * runtime preference in the registry.
   */
  getRuntimeForStack(stackId) {
    const stack = this.registry.getStack(stackId);
    if (stack?.runtime === "podman") return this.podmanRuntime;
    return this.dockerRuntime;
  }
  /** Register a callback invoked whenever a task status changes (for UI notifications) */
  setOnStatusChange(callback) {
    this.onStatusChange = callback;
  }
  watch(stackId, containerId) {
    if (this.watchers.has(stackId)) {
      this.unwatch(stackId);
    }
    this.errorCounts.set(stackId, 0);
    this.seenRunning.set(stackId, false);
    this.stalePollCounts.set(stackId, 0);
    this.containerIds.set(stackId, containerId);
    this.schedulePoll(stackId, containerId, this.pollInterval);
  }
  unwatch(stackId) {
    const timeout = this.watchers.get(stackId);
    if (timeout) {
      clearTimeout(timeout);
      this.watchers.delete(stackId);
    }
    this.errorCounts.delete(stackId);
    this.seenRunning.delete(stackId);
    this.stalePollCounts.delete(stackId);
    this.lastTokenPoll.delete(stackId);
    this.containerIds.delete(stackId);
    const controller = this.activeOutputStreams.get(stackId);
    if (controller) {
      controller.abort();
      this.activeOutputStreams.delete(stackId);
    }
  }
  unwatchAll() {
    for (const [id] of this.watchers) {
      this.unwatch(id);
    }
  }
  completeTaskAndNotify(task, stackId, status, exitCode, containerId) {
    this.registry.completeTask(task.id, exitCode);
    let warning = null;
    if (status === "completed" && exitCode === 0 && task.started_at) {
      const durationMs = Date.now() - (/* @__PURE__ */ new Date(task.started_at + "Z")).getTime();
      if (durationMs < SUSPICIOUS_DURATION_MS) {
        warning = `Task completed suspiciously fast (${Math.round(durationMs / 1e3)}s) — may not have produced real changes`;
        this.registry.setTaskWarning(task.id, warning);
      }
    }
    if (containerId) {
      this.readTaskTokens(task.id, stackId, containerId).catch(() => {
      });
      this.readTaskIterations(task.id, stackId, containerId).catch(() => {
      });
      this.readTaskMetadata(task.id, stackId, containerId).catch(() => {
      });
    }
    const updatedTask = {
      ...task,
      status,
      exit_code: exitCode,
      warnings: warning,
      finished_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    const event = status === "completed" ? "task:completed" : "task:failed";
    this.emit(event, { stackId, task: updatedTask });
    this.onStatusChange?.();
    this.unwatch(stackId);
  }
  /**
   * Read token usage from phase totals files and raw log inside the container.
   * Phase totals files are written by token-counter.sh in the run_claude pipeline.
   * The raw log is still read for session_id and resolved_model extraction.
   */
  async readTaskTokens(taskId, stackId, containerId) {
    const runtime = this.getRuntimeForStack(stackId);
    try {
      const [execResult, reviewResult, rawResult] = await Promise.all([
        runtime.exec(containerId, ["cat", "/tmp/claude-tokens-execution"]).catch(() => ({ stdout: "" })),
        runtime.exec(containerId, ["cat", "/tmp/claude-tokens-review"]).catch(() => ({ stdout: "" })),
        runtime.exec(containerId, ["cat", "/tmp/claude-raw.log"]).catch(() => ({ stdout: "" }))
      ]);
      const execTokens = parsePhaseTokenTotals(execResult.stdout);
      const reviewTokens = parsePhaseTokenTotals(reviewResult.stdout);
      const totalInput = execTokens.input_tokens + reviewTokens.input_tokens;
      const totalOutput = execTokens.output_tokens + reviewTokens.output_tokens;
      if (totalInput > 0 || totalOutput > 0) {
        this.registry.updateTaskTokens(taskId, totalInput, totalOutput, {
          executionInput: execTokens.input_tokens,
          executionOutput: execTokens.output_tokens,
          reviewInput: reviewTokens.input_tokens,
          reviewOutput: reviewTokens.output_tokens
        });
      }
      const steps = parsePhaseTokenSteps(execResult.stdout, reviewResult.stdout);
      if (steps.length > 0) {
        this.registry.setTaskTokenSteps(taskId, steps);
      }
      const rawOutput = rawResult.stdout;
      if (rawOutput) {
        const usage = parseTokenUsage(rawOutput);
        if (usage.session_id) {
          this.registry.setTaskSessionId(taskId, usage.session_id);
        }
        if (usage.resolved_model) {
          this.registry.updateTaskResolvedModel(taskId, usage.resolved_model);
        }
      }
    } catch {
    }
  }
  /**
   * Read loop iteration counts from files written by task-runner.sh.
   */
  async readTaskIterations(taskId, stackId, containerId) {
    const runtime = this.getRuntimeForStack(stackId);
    let reviewIterations = 0;
    let verifyRetries = 0;
    try {
      const result = await runtime.exec(containerId, [
        "cat",
        "/tmp/claude-task.review-iterations"
      ]);
      const parsed = parseInt(result.stdout.trim(), 10);
      if (!isNaN(parsed)) reviewIterations = parsed;
    } catch {
    }
    try {
      const result = await runtime.exec(containerId, [
        "cat",
        "/tmp/claude-task.verify-retries"
      ]);
      const parsed = parseInt(result.stdout.trim(), 10);
      if (!isNaN(parsed)) verifyRetries = parsed;
    } catch {
    }
    if (reviewIterations > 0 || verifyRetries > 0) {
      this.registry.setTaskIterations(taskId, reviewIterations, verifyRetries);
    }
  }
  /**
   * Read task execution metadata files (review verdicts, verify outputs,
   * execution summary, phase timing) from the container.
   */
  async readTaskMetadata(taskId, stackId, containerId) {
    const runtime = this.getRuntimeForStack(stackId);
    const metadata = {};
    try {
      const lsResult = await runtime.exec(containerId, [
        "sh",
        "-c",
        "ls /tmp/claude-review-verdict-*.txt 2>/dev/null || true"
      ]);
      const files = lsResult.stdout.trim().split("\n").filter(Boolean);
      if (files.length > 0) {
        const verdicts = [];
        for (const file of files.sort()) {
          try {
            const result = await runtime.exec(containerId, ["cat", file]);
            verdicts.push(result.stdout);
          } catch {
          }
        }
        if (verdicts.length > 0) {
          metadata.review_verdicts = JSON.stringify(verdicts);
        }
      }
    } catch {
    }
    try {
      const lsResult = await runtime.exec(containerId, [
        "sh",
        "-c",
        "ls /tmp/claude-verify-output-*.txt 2>/dev/null || true"
      ]);
      const files = lsResult.stdout.trim().split("\n").filter(Boolean);
      if (files.length > 0) {
        const outputs = [];
        for (const file of files.sort()) {
          try {
            const result = await runtime.exec(containerId, ["cat", file]);
            outputs.push(result.stdout);
          } catch {
          }
        }
        if (outputs.length > 0) {
          metadata.verify_outputs = JSON.stringify(outputs);
        }
      }
    } catch {
    }
    try {
      const result = await runtime.exec(containerId, [
        "cat",
        "/tmp/claude-execution-summary.txt"
      ]);
      if (result.stdout.trim()) {
        metadata.execution_summary = result.stdout;
      }
    } catch {
    }
    try {
      const result = await runtime.exec(containerId, [
        "cat",
        "/tmp/claude-phase-timing.txt"
      ]);
      const lines = result.stdout.trim().split("\n").filter(Boolean);
      const timing = {};
      for (const line of lines) {
        const [key, value] = line.split("=", 2);
        if (key && value) {
          timing[key] = value;
        }
      }
      if (timing.execution_started_at) metadata.execution_started_at = timing.execution_started_at;
      if (timing.execution_finished_at) metadata.execution_finished_at = timing.execution_finished_at;
      if (timing.review_started_at) metadata.review_started_at = timing.review_started_at;
      if (timing.review_finished_at) metadata.review_finished_at = timing.review_finished_at;
      if (timing.verify_started_at) metadata.verify_started_at = timing.verify_started_at;
      if (timing.verify_finished_at) metadata.verify_finished_at = timing.verify_finished_at;
    } catch {
    }
    if (Object.keys(metadata).length > 0) {
      this.registry.updateTaskMetadata(taskId, metadata);
    }
  }
  /**
   * Read current workflow progress from the container (phase, iterations, live tokens).
   * Called during the token poll interval while a task is running.
   */
  async readWorkflowProgress(stackId, containerId, task) {
    const runtime = this.getRuntimeForStack(stackId);
    const [timingResult, reviewIterResult, verifyRetryResult, execTokenResult, reviewTokenResult] = await Promise.all([
      runtime.exec(containerId, ["cat", "/tmp/claude-phase-timing.txt"]).catch(() => ({ stdout: "" })),
      runtime.exec(containerId, ["cat", "/tmp/claude-task.review-iterations"]).catch(() => ({ stdout: "" })),
      runtime.exec(containerId, ["cat", "/tmp/claude-task.verify-retries"]).catch(() => ({ stdout: "" })),
      runtime.exec(containerId, ["cat", "/tmp/claude-tokens-execution"]).catch(() => ({ stdout: "" })),
      runtime.exec(containerId, ["cat", "/tmp/claude-tokens-review"]).catch(() => ({ stdout: "" }))
    ]);
    const reviewIterations = parseInt(reviewIterResult.stdout.trim(), 10) || 0;
    const verifyRetries = parseInt(verifyRetryResult.stdout.trim(), 10) || 0;
    const timing = {};
    for (const line of timingResult.stdout.trim().split("\n").filter(Boolean)) {
      const [key, value] = line.split("=", 2);
      if (key && value) timing[key] = value;
    }
    let currentPhase = "execution";
    const phases = [];
    if (timing.verify_started_at && !timing.verify_finished_at) {
      currentPhase = "verify";
      phases.push({ phase: "execution", status: "passed" });
      phases.push({ phase: "review", status: "passed" });
      phases.push({ phase: "verify", status: "running" });
    } else if (timing.review_started_at && !timing.review_finished_at) {
      currentPhase = "review";
      phases.push({ phase: "execution", status: "passed" });
      phases.push({ phase: "review", status: "running" });
      phases.push({ phase: "verify", status: "pending" });
    } else if (timing.review_finished_at && timing.verify_finished_at) {
      currentPhase = "execution";
      phases.push({ phase: "execution", status: "running" });
      phases.push({ phase: "review", status: "pending" });
      phases.push({ phase: "verify", status: "failed" });
    } else if (timing.review_finished_at && !timing.verify_started_at) {
      currentPhase = "execution";
      phases.push({ phase: "execution", status: "running" });
      phases.push({ phase: "review", status: "failed" });
      phases.push({ phase: "verify", status: "pending" });
    } else {
      phases.push({ phase: "execution", status: "running" });
      phases.push({ phase: "review", status: "pending" });
      phases.push({ phase: "verify", status: "pending" });
    }
    const tokenSteps = parsePhaseTokenSteps(execTokenResult.stdout, reviewTokenResult.stdout);
    const steps = tokenSteps.map((s) => ({
      phase: s.phase,
      iteration: s.iteration,
      input_tokens: s.input_tokens,
      output_tokens: s.output_tokens,
      live: false
    }));
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].phase === currentPhase) {
        steps[i].live = true;
        break;
      }
    }
    if (!steps.some((s) => s.phase === currentPhase)) {
      const iteration = currentPhase === "verify" ? verifyRetries + 1 : reviewIterations + 1;
      steps.push({
        phase: currentPhase,
        iteration,
        input_tokens: 0,
        output_tokens: 0,
        live: true
      });
    }
    const outerIteration = verifyRetries + 1;
    const innerIteration = reviewIterations + 1;
    return {
      stackId,
      currentPhase,
      outerIteration,
      innerIteration,
      phases,
      steps,
      taskPrompt: task.prompt,
      startedAt: task.started_at,
      model: task.resolved_model || task.model
    };
  }
  /**
   * Get the current workflow progress for a stack (on-demand, for IPC handlers).
   */
  async getWorkflowProgress(stackId) {
    const task = this.registry.getRunningTask(stackId);
    if (!task) return null;
    const containerId = this.containerIds.get(stackId);
    if (!containerId) return null;
    try {
      return await this.readWorkflowProgress(stackId, containerId, task);
    } catch (err) {
      console.warn(`[TaskWatcher] getWorkflowProgress failed for ${stackId}:`, err?.message ?? err);
      return null;
    }
  }
  /**
   * Read whatever metadata files exist for a task (used during teardown
   * to capture partial data before the container is removed).
   */
  async capturePartialMetadata(taskId, stackId, containerId) {
    await Promise.all([
      this.readTaskTokens(taskId, stackId, containerId).catch(() => {
      }),
      this.readTaskIterations(taskId, stackId, containerId).catch(() => {
      }),
      this.readTaskMetadata(taskId, stackId, containerId).catch(() => {
      })
    ]);
  }
  /**
   * Schedule the next poll with adaptive timing.
   * Uses exponential backoff on consecutive failures.
   */
  schedulePoll(stackId, containerId, delayMs) {
    const timeout = setTimeout(async () => {
      await this.checkTaskStatus(stackId, containerId);
    }, delayMs);
    this.watchers.set(stackId, timeout);
  }
  async checkTaskStatus(stackId, containerId) {
    const task = this.registry.getRunningTask(stackId);
    if (!task) {
      this.unwatch(stackId);
      return;
    }
    const runtime = this.getRuntimeForStack(stackId);
    try {
      const result = await runtime.exec(containerId, [
        "cat",
        "/tmp/claude-task.status"
      ]);
      const status = result.stdout.trim();
      if (status === "running") {
        const wasFirstRunning = !this.seenRunning.get(stackId);
        this.seenRunning.set(stackId, true);
        this.errorCounts.set(stackId, 0);
        const now = Date.now();
        const lastPoll = this.lastTokenPoll.get(stackId) ?? 0;
        if (wasFirstRunning || now - lastPoll >= this.tokenPollInterval) {
          this.lastTokenPoll.set(stackId, now);
          const runningTask = this.registry.getRunningTask(stackId);
          if (runningTask) {
            this.readTaskTokens(runningTask.id, stackId, containerId).catch((err) => {
              console.warn(`[TaskWatcher] Failed to read tokens for ${stackId}:`, err?.message ?? err);
            });
            this.readWorkflowProgress(stackId, containerId, runningTask).then((progress) => {
              this.emit("task:workflow-progress", progress);
            }).catch((err) => {
              console.warn(`[TaskWatcher] Failed to read workflow progress for ${stackId}:`, err?.message ?? err);
            });
          }
        }
        this.schedulePoll(stackId, containerId, this.pollInterval);
        return;
      }
      if (status === "completed" || status === "failed") {
        if (!this.seenRunning.get(stackId)) {
          const staleCount = (this.stalePollCounts.get(stackId) ?? 0) + 1;
          this.stalePollCounts.set(stackId, staleCount);
          if (staleCount < MAX_STALE_POLLS) {
            this.schedulePoll(stackId, containerId, this.pollInterval);
            return;
          }
        }
        let exitCode;
        try {
          const exitResult = await runtime.exec(containerId, [
            "cat",
            "/tmp/claude-task.exit"
          ]);
          exitCode = parseInt(exitResult.stdout.trim(), 10);
          if (isNaN(exitCode)) exitCode = status === "completed" ? 0 : 1;
        } catch {
          exitCode = status === "completed" ? 0 : 1;
        }
        this.completeTaskAndNotify(task, stackId, status, exitCode, containerId);
        return;
      }
      this.errorCounts.set(stackId, 0);
      this.schedulePoll(stackId, containerId, this.pollInterval);
    } catch {
      const count = (this.errorCounts.get(stackId) ?? 0) + 1;
      this.errorCounts.set(stackId, count);
      if (count >= MAX_CONSECUTIVE_ERRORS) {
        this.completeTaskAndNotify(
          task,
          stackId,
          "failed",
          1
        );
        return;
      }
      const backoffDelay = Math.min(
        BACKOFF_BASE_MS * Math.pow(2, count - 1),
        BACKOFF_MAX_MS
      );
      this.schedulePoll(stackId, containerId, backoffDelay);
    }
  }
  async streamOutput(stackId, containerId, callback) {
    const existing = this.activeOutputStreams.get(stackId);
    if (existing) {
      existing.abort();
    }
    const controller = new AbortController();
    this.activeOutputStreams.set(stackId, controller);
    try {
      const runtime = this.getRuntimeForStack(stackId);
      for await (const chunk of runtime.logs(containerId, {
        follow: true,
        tail: 100
      })) {
        if (controller.signal.aborted) break;
        callback(chunk);
        this.emit("task:output", {
          stackId,
          taskId: 0,
          data: chunk
        });
      }
    } catch {
    } finally {
      this.activeOutputStreams.delete(stackId);
    }
  }
}
var ErrorCode = /* @__PURE__ */ ((ErrorCode2) => {
  ErrorCode2["STACK_NOT_FOUND"] = "STACK_NOT_FOUND";
  ErrorCode2["CONTAINER_UNREACHABLE"] = "CONTAINER_UNREACHABLE";
  ErrorCode2["AUTH_EXPIRED"] = "AUTH_EXPIRED";
  ErrorCode2["AUTH_FAILED"] = "AUTH_FAILED";
  ErrorCode2["RUNTIME_UNAVAILABLE"] = "RUNTIME_UNAVAILABLE";
  ErrorCode2["PROJECT_NOT_FOUND"] = "PROJECT_NOT_FOUND";
  ErrorCode2["PROJECT_NOT_INITIALIZED"] = "PROJECT_NOT_INITIALIZED";
  ErrorCode2["INIT_FAILED"] = "INIT_FAILED";
  ErrorCode2["TASK_DISPATCH_FAILED"] = "TASK_DISPATCH_FAILED";
  ErrorCode2["COMPOSE_FAILED"] = "COMPOSE_FAILED";
  ErrorCode2["INVALID_INPUT"] = "INVALID_INPUT";
  ErrorCode2["INTERNAL_ERROR"] = "INTERNAL_ERROR";
  ErrorCode2["GATE_CHECK_REQUIRED"] = "GATE_CHECK_REQUIRED";
  return ErrorCode2;
})(ErrorCode || {});
class SandstormError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "SandstormError";
    this.code = code;
  }
  toJSON() {
    return { code: this.code, message: this.message };
  }
}
function getScriptStatus(projectDir) {
  const scriptPath = path.join(projectDir, ".sandstorm", "scripts", "fetch-ticket.sh");
  console.log(`[sandstorm] getScriptStatus: checking "${scriptPath}"`);
  if (!fs.existsSync(scriptPath)) return "missing";
  try {
    fs.accessSync(scriptPath, fs.constants.X_OK);
    return "ok";
  } catch {
    return "not_executable";
  }
}
async function fetchTicketContext(ticketId, projectDir) {
  const scriptPath = path.join(projectDir, ".sandstorm", "scripts", "fetch-ticket.sh");
  console.log(`[sandstorm] fetchTicketContext: projectDir="${projectDir}", scriptPath="${scriptPath}"`);
  if (!fs.existsSync(scriptPath)) {
    console.warn(
      `[sandstorm] No fetch-ticket script found at ${scriptPath}. Configure a ticket provider with 'sandstorm init' or create the script manually.`
    );
    return null;
  }
  try {
    fs.accessSync(scriptPath, fs.constants.X_OK);
  } catch {
    console.warn(
      `[sandstorm] fetch-ticket.sh exists but is not executable. Run: chmod +x ${scriptPath}`
    );
    return null;
  }
  try {
    return await runFetchScript(scriptPath, ticketId, projectDir);
  } catch {
    return null;
  }
}
function runFetchScript(scriptPath, ticketId, cwd) {
  return new Promise((resolve, reject) => {
    child_process.execFile(
      scriptPath,
      [ticketId],
      { cwd, timeout: 3e4 },
      (err, stdout, stderr) => {
        if (err) {
          if (stderr) {
            console.warn(`[sandstorm] fetch-ticket.sh failed: ${stderr.trim()}`);
          }
          return reject(err);
        }
        resolve(stdout);
      }
    );
  });
}
function referencesTicket(prompt) {
  if (/(?:^|\s)#\d+/.test(prompt)) return true;
  if (/[\w.-]+\/[\w.-]+#\d+/.test(prompt)) return true;
  if (/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/.test(prompt)) return true;
  if (/(?:^|\s)[A-Z]{2,}-\d+/.test(prompt)) return true;
  if (/linear\.app\/[\w.-]+\/issue\/[\w-]+/.test(prompt)) return true;
  return false;
}
function sanitizeComposeName(input) {
  const name = input.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").replace(/-{2,}/g, "-").replace(/^[-]+/, "").replace(/[-]+$/, "");
  return name || "stack";
}
class StackManager {
  constructor(registry, portAllocator, taskWatcher, dockerRuntime, podmanRuntime, cliDir = "") {
    this.registry = registry;
    this.portAllocator = portAllocator;
    this.taskWatcher = taskWatcher;
    this.dockerRuntime = dockerRuntime;
    this.podmanRuntime = podmanRuntime;
    this.cliDir = cliDir;
    this.taskWatcher.setOnStatusChange(() => this.notifyUpdate());
    this.appVersion = StackManager.resolveAppVersion();
  }
  onStackUpdate;
  appVersion;
  /**
   * Resolve the app's git commit hash.
   * Prefers the build-time define; falls back to git at runtime (dev mode).
   */
  static resolveAppVersion() {
    try {
      if (typeof __GIT_COMMIT__ !== "undefined" && __GIT_COMMIT__ !== "unknown") {
        return __GIT_COMMIT__;
      }
    } catch {
    }
    try {
      return child_process.execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
    } catch {
      return "unknown";
    }
  }
  getAppVersion() {
    return this.appVersion;
  }
  setOnStackUpdate(callback) {
    this.onStackUpdate = callback;
  }
  notifyUpdate() {
    this.onStackUpdate?.();
  }
  /**
   * Resolve the correct container runtime for a stack based on its stored
   * runtime preference, rather than relying on the global default.
   */
  getRuntimeForStack(stack) {
    return stack.runtime === "podman" ? this.podmanRuntime : this.dockerRuntime;
  }
  /**
   * Resolve path to the sandstorm CLI entry point.
   */
  getCliBin() {
    return path.join(this.cliDir, "bin", "sandstorm");
  }
  /**
   * Run a sandstorm CLI command in the given project directory.
   */
  runCli(projectDir, args, env) {
    return new Promise((resolve, reject) => {
      const child = child_process.spawn("bash", [this.getCliBin(), ...args], {
        cwd: projectDir,
        env: {
          ...process.env,
          ...env,
          PATH: [
            `${process.env.HOME}/.local/bin`,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/local/sbin",
            process.env.PATH
          ].join(":")
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => stdout += d.toString());
      child.stderr.on("data", (d) => stderr += d.toString());
      child.on(
        "close",
        (code) => resolve({ stdout, stderr, exitCode: code ?? 1 })
      );
      child.on("error", reject);
    });
  }
  /**
   * Check whether a create/dispatch call requires the spec quality gate.
   * Throws GATE_CHECK_REQUIRED if the task references a ticket
   * but gateApproved and forceBypass are both falsy.
   */
  enforceSpecGate(opts) {
    if (opts.gateApproved || opts.forceBypass) {
      if (opts.forceBypass && !opts.gateApproved) {
        console.warn("[sandstorm] Spec quality gate bypassed via forceBypass flag");
      }
      return;
    }
    const hasTicket = !!opts.ticket;
    const hasTicketRef = opts.task ? referencesTicket(opts.task) : false;
    if (hasTicket || hasTicketRef) {
      throw new SandstormError(
        ErrorCode.GATE_CHECK_REQUIRED,
        "Task references a ticket but gateApproved was not set. Run /spec-check on the ticket first, then retry with gateApproved: true."
      );
    }
  }
  createStack(opts) {
    this.enforceSpecGate(opts);
    const projectName = path.basename(opts.projectDir);
    if (!opts.model) {
      const effective = this.registry.getEffectiveModels(opts.projectDir);
      opts = { ...opts, model: effective.inner_model };
    }
    if (opts.model === "auto") {
      opts = { ...opts, model: void 0 };
    }
    const stack = this.registry.createStack({
      id: opts.name,
      project: projectName,
      project_dir: opts.projectDir,
      ticket: opts.ticket ?? null,
      branch: opts.branch ?? null,
      description: opts.description ?? null,
      status: "building",
      runtime: opts.runtime
    });
    this.buildStackInBackground(opts, projectName).catch(() => {
    });
    return stack;
  }
  /**
   * Check whether the project's Claude base image needs rebuilding.
   * Compares the image's sandstorm.app-version label to the current app version.
   * Returns true if the image is outdated or missing a version stamp.
   */
  async checkImageNeedsRebuild(projectDir) {
    if (this.appVersion === "unknown") return false;
    try {
      const projectName = path.basename(projectDir).toLowerCase().replace(/[^a-z0-9]/g, "-");
      const imageName = `sandstorm-${projectName}-claude`;
      const result = await new Promise((resolve) => {
        const child = child_process.spawn("docker", [
          "image",
          "inspect",
          imageName,
          "--format",
          '{{index .Config.Labels "sandstorm.app-version"}}'
        ], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        child.stdout.on("data", (d) => stdout += d.toString());
        child.on("close", (code) => resolve({ stdout: stdout.trim(), exitCode: code ?? 1 }));
        child.on("error", () => resolve({ stdout: "", exitCode: 1 }));
      });
      if (result.exitCode !== 0) {
        return false;
      }
      const imageVersion = result.stdout;
      if (!imageVersion || imageVersion === "<no value>") {
        return true;
      }
      return imageVersion !== this.appVersion;
    } catch {
      return false;
    }
  }
  async buildStackInBackground(opts, _projectName) {
    try {
      const needsRebuild = await this.checkImageNeedsRebuild(opts.projectDir);
      if (needsRebuild) {
        this.registry.updateStackStatus(opts.name, "rebuilding");
        this.notifyUpdate();
      }
      const servicePorts = await this.discoverServicePorts(opts.projectDir);
      const portMap = await this.portAllocator.allocate(opts.name, servicePorts);
      const portEnv = {};
      for (const [serviceKey, hostPort] of portMap) {
        portEnv[`SANDSTORM_PORT_${serviceKey}`] = String(hostPort);
      }
      portEnv["SANDSTORM_APP_VERSION"] = this.appVersion;
      const args = ["up", opts.name];
      if (opts.ticket) args.push("--ticket", opts.ticket);
      if (opts.branch) args.push("--branch", opts.branch);
      const result = await this.runCli(opts.projectDir, args, portEnv);
      if (result.exitCode !== 0) {
        throw new SandstormError(ErrorCode.COMPOSE_FAILED, result.stderr.trim() || result.stdout.trim() || "Stack creation failed");
      }
      this.registry.updateStackStatus(opts.name, "up");
      this.notifyUpdate();
      if (opts.task) {
        const gateOpts = { gateApproved: opts.gateApproved, forceBypass: opts.forceBypass };
        try {
          await this.dispatchTask(opts.name, opts.task, opts.model, gateOpts);
        } catch (firstErr) {
          await new Promise((resolve) => setTimeout(resolve, 1e4));
          try {
            await this.dispatchTask(opts.name, opts.task, opts.model, gateOpts);
          } catch (retryErr) {
            const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            this.registry.updateStackStatus(opts.name, "failed", `Task dispatch failed after retry: ${msg}`);
            this.notifyUpdate();
            return;
          }
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.registry.updateStackStatus(opts.name, "failed", errorMessage);
      this.notifyUpdate();
    }
  }
  stopStack(stackId) {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);
    this.taskWatcher.unwatch(stackId);
    this.registry.updateStackStatus(stackId, "stopped");
    this.notifyUpdate();
    this.stopInBackground(stack, stackId).catch(() => {
    });
  }
  async stopInBackground(stack, stackId) {
    try {
      await this.runCli(stack.project_dir, ["stop", stackId]);
    } catch {
    }
  }
  startStack(stackId) {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);
    this.registry.updateStackStatus(stackId, "building");
    this.notifyUpdate();
    this.startInBackground(stack, stackId).catch(() => {
    });
  }
  async startInBackground(stack, stackId) {
    try {
      const result = await this.runCli(stack.project_dir, ["start", stackId]);
      if (result.exitCode !== 0) {
        throw new SandstormError(ErrorCode.COMPOSE_FAILED, result.stderr.trim() || result.stdout.trim() || "Stack start failed");
      }
      this.registry.updateStackStatus(stackId, "up");
      this.notifyUpdate();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.registry.updateStackStatus(stackId, "failed", errorMessage);
      this.notifyUpdate();
    }
  }
  /**
   * Pause all running stacks due to session token limit.
   * Uses docker stop (not teardown) so stacks can be resumed.
   * Returns the list of stack IDs that were paused.
   */
  sessionPauseAllStacks() {
    const stacks = this.registry.listStacks();
    const runningStatuses = /* @__PURE__ */ new Set(["running", "up", "building", "rebuilding", "idle", "completed", "pushed", "pr_created"]);
    const paused = [];
    for (const stack of stacks) {
      if (runningStatuses.has(stack.status)) {
        this.taskWatcher.unwatch(stack.id);
        this.registry.updateStackStatus(stack.id, "session_paused");
        paused.push(stack.id);
        this.stopInBackground(stack, stack.id).catch(() => {
        });
      }
    }
    if (paused.length > 0) {
      this.notifyUpdate();
    }
    return paused;
  }
  /**
   * Resume a stack that was paused due to session limit.
   */
  sessionResumeStack(stackId) {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);
    if (stack.status !== "session_paused") return;
    this.registry.updateStackStatus(stackId, "building");
    this.notifyUpdate();
    this.startInBackground(stack, stackId).catch(() => {
    });
  }
  /**
   * Resume all stacks that were paused due to session limit.
   */
  sessionResumeAllStacks() {
    const stacks = this.registry.listStacks();
    const resumed = [];
    for (const stack of stacks) {
      if (stack.status === "session_paused") {
        this.registry.updateStackStatus(stack.id, "building");
        resumed.push(stack.id);
        this.startInBackground(stack, stack.id).catch(() => {
        });
      }
    }
    if (resumed.length > 0) {
      this.notifyUpdate();
    }
    return resumed;
  }
  async teardownStack(stackId) {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);
    this.taskWatcher.unwatch(stackId);
    const runningTask = this.registry.getRunningTask(stackId);
    if (runningTask) {
      try {
        const runtime = this.getRuntimeForStack(stack);
        const claudeContainer = await this.findClaudeContainer(stack, runtime).catch(() => null);
        if (claudeContainer) {
          await this.taskWatcher.capturePartialMetadata(
            runningTask.id,
            stackId,
            claudeContainer.id
          ).catch(() => {
          });
        }
      } catch {
      }
      this.registry.interruptTask(runningTask.id);
    }
    const finalStatus = stack.status === "completed" ? "completed" : stack.status === "failed" ? "failed" : "torn_down";
    this.registry.archiveStack(stackId, finalStatus);
    this.portAllocator.release(stackId);
    this.registry.deleteStack(stackId);
    this.notifyUpdate();
    this.teardownInBackground(stack, stackId).catch(() => {
    });
  }
  async teardownInBackground(stack, stackId) {
    try {
      await this.runCli(stack.project_dir, ["down", stackId]);
    } catch {
    }
  }
  /**
   * Wait for the inner Claude agent to be ready inside the container.
   * Checks every `intervalMs` for up to `timeoutMs` by exec-ing into
   * the container and looking for a running claude process or readiness file.
   */
  async waitForClaudeReady(containerId, runtime, timeoutMs = 6e4, intervalMs = 2e3) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const readyResult = await runtime.exec(containerId, [
          "test",
          "-f",
          "/tmp/claude-ready"
        ]);
        if (readyResult.exitCode === 0) return;
      } catch {
      }
      try {
        const psResult = await runtime.exec(containerId, [
          "pgrep",
          "-f",
          "claude"
        ]);
        if (psResult.exitCode === 0 && psResult.stdout.trim()) return;
      } catch {
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `Claude agent in container "${containerId}" not ready after ${timeoutMs / 1e3}s`
    );
  }
  async dispatchTask(stackId, prompt, model, opts) {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);
    if (!model) {
      const effective = this.registry.getEffectiveModels(stack.project_dir);
      model = effective.inner_model;
    }
    if (model === "auto") {
      model = void 0;
    }
    this.enforceSpecGate({
      ticket: stack.ticket ?? void 0,
      task: prompt,
      gateApproved: opts?.gateApproved,
      forceBypass: opts?.forceBypass
    });
    if (stack.ticket) {
      const ticketContext = await fetchTicketContext(stack.ticket, stack.project_dir);
      if (ticketContext) {
        prompt = `${ticketContext}

---

## Task

${prompt}`;
      }
    }
    const task = this.registry.createTask(stackId, prompt, model);
    const runtime = this.getRuntimeForStack(stack);
    try {
      const claudeContainer = await this.findClaudeContainer(stack, runtime);
      await this.waitForClaudeReady(claudeContainer.id, runtime);
      const cliArgs = ["task", stackId];
      if (model) cliArgs.push("--model", model);
      cliArgs.push(prompt);
      const result = await this.runCli(stack.project_dir, cliArgs);
      if (result.exitCode !== 0) {
        throw new SandstormError(
          ErrorCode.TASK_DISPATCH_FAILED,
          result.stderr.trim() || result.stdout.trim() || "Task dispatch failed"
        );
      }
      this.taskWatcher.watch(stackId, claudeContainer.id);
      this.taskWatcher.streamOutput(stackId, claudeContainer.id, () => {
      }).catch(() => {
      });
      return task;
    } catch (err) {
      this.registry.completeTask(task.id, 1);
      this.notifyUpdate();
      throw err;
    }
  }
  async getStackWithServices(stackId) {
    const stack = this.registry.getStack(stackId);
    if (!stack) return void 0;
    const services = await this.getServices(stack);
    return { ...stack, services };
  }
  async listStacksWithServices() {
    const stacks = this.registry.listStacks();
    const results = [];
    for (const stack of stacks) {
      const services = await this.getServices(stack);
      results.push({ ...stack, services });
    }
    return results;
  }
  async getDiff(stackId) {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);
    const result = await this.runCli(stack.project_dir, ["diff", stackId]);
    return result.stdout;
  }
  async push(stackId, message) {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);
    const args = ["push", stackId];
    if (message) args.push(message);
    const result = await this.runCli(stack.project_dir, args);
    if (result.exitCode !== 0) {
      throw new SandstormError(ErrorCode.COMPOSE_FAILED, result.stderr.trim() || result.stdout.trim() || "Push failed");
    }
    this.registry.updateStackStatus(stackId, "pushed");
    this.notifyUpdate();
  }
  setPullRequest(stackId, prUrl, prNumber) {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);
    this.registry.setPullRequest(stackId, prUrl, prNumber);
    this.notifyUpdate();
  }
  getTaskStatus(stackId) {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);
    const runningTask = this.registry.getRunningTask(stackId);
    if (runningTask) {
      return { status: "running", task: runningTask };
    }
    const tasks = this.registry.getTasksForStack(stackId);
    if (tasks.length > 0) {
      return { status: tasks[0].status, task: tasks[0] };
    }
    return { status: "idle" };
  }
  async getTaskOutput(stackId, lines = 50) {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);
    const runtime = this.getRuntimeForStack(stack);
    const claudeContainer = await this.findClaudeContainer(stack, runtime);
    try {
      const result = await runtime.exec(claudeContainer.id, [
        "tail",
        "-n",
        String(lines),
        "/tmp/claude-task.log"
      ]);
      return result.stdout;
    } catch {
      return "(no task output available)";
    }
  }
  async getLogs(stackId, service) {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new SandstormError(ErrorCode.STACK_NOT_FOUND, `Stack "${stackId}" not found`);
    const composeProjectName = `sandstorm-${sanitizeComposeName(stack.project)}-${sanitizeComposeName(stack.id)}`;
    const filterName = service ? `${composeProjectName}-${service}` : composeProjectName;
    const runtime = this.getRuntimeForStack(stack);
    const containers = await runtime.listContainers({ name: filterName });
    if (containers.length === 0) {
      throw new SandstormError(ErrorCode.CONTAINER_UNREACHABLE, `No containers found for stack "${stackId}"${service ? ` service "${service}"` : ""}`);
    }
    const logParts = [];
    for (const c of containers) {
      const chunks = [];
      for await (const chunk of runtime.logs(c.id, { tail: 100 })) {
        chunks.push(chunk);
      }
      const serviceName = this.extractServiceName(c.name, composeProjectName);
      logParts.push(`=== ${serviceName} ===
${chunks.join("")}`);
    }
    return logParts.join("\n\n");
  }
  getTasksForStack(stackId) {
    return this.registry.getTasksForStack(stackId);
  }
  listStackHistory() {
    return this.registry.listStackHistory();
  }
  async getStackMemoryUsage(stackId) {
    const stats = await this.getStackDetailedStats(stackId);
    return stats.totalMemory;
  }
  async getStackDetailedStats(stackId) {
    const stack = this.registry.getStack(stackId);
    if (!stack) return { stackId, totalMemory: 0, containers: [] };
    const composeProjectName = `sandstorm-${sanitizeComposeName(stack.project)}-${sanitizeComposeName(stack.id)}`;
    const runtime = this.getRuntimeForStack(stack);
    const containers = await runtime.listContainers({ name: composeProjectName });
    const entries = [];
    let totalMemory = 0;
    for (const c of containers) {
      if (c.status !== "running") continue;
      try {
        const stats = await runtime.containerStats(c.id);
        const serviceName = this.extractServiceName(c.name, composeProjectName);
        entries.push({
          name: serviceName,
          containerId: c.id,
          memoryUsage: stats.memoryUsage,
          memoryLimit: stats.memoryLimit,
          cpuPercent: stats.cpuPercent
        });
        totalMemory += stats.memoryUsage;
      } catch {
      }
    }
    return { stackId, totalMemory, containers: entries };
  }
  getStackTaskMetrics(stackId) {
    const tasks = this.registry.getTasksForStack(stackId);
    let completedTasks = 0;
    let failedTasks = 0;
    let runningTasks = 0;
    let totalDurationMs = 0;
    let durationCount = 0;
    for (const task of tasks) {
      if (task.status === "completed") {
        completedTasks++;
        if (task.finished_at && task.started_at) {
          const dur = new Date(task.finished_at).getTime() - new Date(task.started_at).getTime();
          if (dur > 0) {
            totalDurationMs += dur;
            durationCount++;
          }
        }
      } else if (task.status === "failed") {
        failedTasks++;
      } else {
        runningTasks++;
      }
    }
    return {
      stackId,
      totalTasks: tasks.length,
      completedTasks,
      failedTasks,
      runningTasks,
      avgTaskDurationMs: durationCount > 0 ? totalDurationMs / durationCount : 0
    };
  }
  // --- Workflow Progress ---
  async getWorkflowProgress(stackId) {
    const liveProgress = await this.taskWatcher.getWorkflowProgress(stackId);
    if (liveProgress) return liveProgress;
    return this.reconstructWorkflowProgress(stackId);
  }
  reconstructWorkflowProgress(stackId) {
    const task = this.registry.getMostRecentTask(stackId);
    if (!task) return null;
    const tokenSteps = this.registry.getTaskTokenSteps(task.id);
    const phases = [];
    let currentPhase = "idle";
    if (task.status === "running") {
      return null;
    } else if (task.status === "completed") {
      currentPhase = "idle";
      phases.push({ phase: "execution", status: "passed" });
      phases.push({ phase: "review", status: "passed" });
      phases.push({ phase: "verify", status: "passed" });
    } else if (task.status === "failed") {
      if (task.verify_started_at && !task.verify_finished_at) {
        currentPhase = "verify";
        phases.push({ phase: "execution", status: "passed" });
        phases.push({ phase: "review", status: "passed" });
        phases.push({ phase: "verify", status: "failed" });
      } else if (task.review_started_at && !task.review_finished_at) {
        currentPhase = "review";
        phases.push({ phase: "execution", status: "passed" });
        phases.push({ phase: "review", status: "failed" });
        phases.push({ phase: "verify", status: "pending" });
      } else {
        currentPhase = "execution";
        phases.push({ phase: "execution", status: "failed" });
        phases.push({ phase: "review", status: "pending" });
        phases.push({ phase: "verify", status: "pending" });
      }
    } else {
      currentPhase = "idle";
      phases.push({ phase: "execution", status: task.execution_started_at ? "passed" : "pending" });
      phases.push({ phase: "review", status: task.review_started_at ? "passed" : "pending" });
      phases.push({ phase: "verify", status: task.verify_started_at ? "passed" : "pending" });
    }
    const steps = tokenSteps.map((s) => ({
      phase: s.phase,
      iteration: s.iteration,
      input_tokens: s.input_tokens,
      output_tokens: s.output_tokens,
      live: false
    }));
    return {
      stackId,
      currentPhase,
      outerIteration: task.verify_retries + 1,
      innerIteration: task.review_iterations + 1,
      phases,
      steps,
      taskPrompt: task.prompt,
      startedAt: task.started_at,
      model: task.resolved_model || task.model
    };
  }
  // --- Token Usage ---
  getStackTokenUsage(stackId) {
    const usage = this.registry.getStackTokenUsage(stackId);
    return {
      stackId,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_tokens: usage.input_tokens + usage.output_tokens
    };
  }
  getGlobalTokenUsage() {
    const stacks = this.registry.listStacks();
    let totalInput = 0;
    let totalOutput = 0;
    const perStack = [];
    const projectMap = /* @__PURE__ */ new Map();
    for (const stack of stacks) {
      totalInput += stack.total_input_tokens;
      totalOutput += stack.total_output_tokens;
      if (stack.total_input_tokens > 0 || stack.total_output_tokens > 0) {
        perStack.push({
          stackId: stack.id,
          input_tokens: stack.total_input_tokens,
          output_tokens: stack.total_output_tokens,
          total_tokens: stack.total_input_tokens + stack.total_output_tokens
        });
      }
      const existing = projectMap.get(stack.project_dir);
      if (existing) {
        existing.input += stack.total_input_tokens;
        existing.output += stack.total_output_tokens;
      } else {
        projectMap.set(stack.project_dir, {
          project: stack.project,
          project_dir: stack.project_dir,
          input: stack.total_input_tokens,
          output: stack.total_output_tokens
        });
      }
    }
    const perProject = [];
    for (const entry of projectMap.values()) {
      if (entry.input > 0 || entry.output > 0) {
        perProject.push({
          project: entry.project,
          project_dir: entry.project_dir,
          input_tokens: entry.input,
          output_tokens: entry.output,
          total_tokens: entry.input + entry.output
        });
      }
    }
    return {
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      total_tokens: totalInput + totalOutput,
      per_stack: perStack.sort((a, b) => b.total_tokens - a.total_tokens),
      per_project: perProject.sort((a, b) => b.total_tokens - a.total_tokens)
    };
  }
  getRateLimitState() {
    const stacks = this.registry.listStacks();
    const rateLimitedStacks = stacks.filter((s) => s.status === "rate_limited");
    if (rateLimitedStacks.length === 0) {
      return { active: false, reset_at: null, affected_stacks: [], reason: null };
    }
    const resetTimes = rateLimitedStacks.map((s) => s.rate_limit_reset_at).filter((t) => t !== null);
    const reset_at = resetTimes.length > 0 ? resetTimes.reduce((latest, t) => t > latest ? t : latest) : null;
    const reasons = rateLimitedStacks.map((s) => s.error).filter((e) => e !== null);
    const reason = reasons.length > 0 ? reasons[0] : null;
    return {
      active: true,
      reset_at,
      affected_stacks: rateLimitedStacks.map((s) => s.id),
      reason
    };
  }
  // --- Private helpers ---
  async getServices(stack) {
    const composeProjectName = `sandstorm-${sanitizeComposeName(stack.project)}-${sanitizeComposeName(stack.id)}`;
    const runtime = this.getRuntimeForStack(stack);
    const containers = await runtime.listContainers({
      name: composeProjectName
    });
    const ports = this.registry.getPorts(stack.id);
    const portMap = new Map(ports.map((p) => [p.service, p]));
    return containers.map((c) => {
      const serviceName = this.extractServiceName(c.name, composeProjectName);
      const portInfo = portMap.get(serviceName);
      return {
        name: serviceName,
        status: c.status,
        exitCode: c.status === "exited" ? void 0 : void 0,
        hostPort: portInfo?.host_port,
        containerPort: portInfo?.container_port,
        containerId: c.id
      };
    });
  }
  async findClaudeContainer(stack, runtime) {
    const resolvedRuntime = runtime ?? this.getRuntimeForStack(stack);
    const composeProjectName = `sandstorm-${sanitizeComposeName(stack.project)}-${sanitizeComposeName(stack.id)}`;
    const containers = await resolvedRuntime.listContainers({
      name: `${composeProjectName}-claude`
    });
    if (!containers[0]) {
      throw new SandstormError(
        ErrorCode.CONTAINER_UNREACHABLE,
        `Agent container not found for stack "${stack.id}". Expected container matching "${composeProjectName}-claude". Check that Docker containers are running (docker ps) and that the compose project name matches.`
      );
    }
    return containers[0];
  }
  extractServiceName(containerName, projectName) {
    const withoutProject = containerName.replace(`${projectName}-`, "");
    return withoutProject.replace(/-\d+$/, "");
  }
  discoverServicePorts(projectDir) {
    try {
      const configPath = path.join(projectDir, ".sandstorm", "config");
      if (!fs.existsSync(configPath)) return Promise.resolve([]);
      const config = fs.readFileSync(configPath, "utf-8");
      const portMapLine = config.split("\n").find((l) => l.startsWith("PORT_MAP="));
      if (!portMapLine) return Promise.resolve([]);
      const portMapValue = portMapLine.split("=")[1]?.replace(/"/g, "");
      if (!portMapValue) return Promise.resolve([]);
      return Promise.resolve(
        portMapValue.split(",").map((entry) => {
          const [service, , containerPort, index] = entry.split(":");
          return {
            service: `${service}_${index || "0"}`,
            containerPort: parseInt(containerPort, 10)
          };
        })
      );
    } catch {
      return Promise.resolve([]);
    }
  }
  // --- Stale Workspace Detection & Cleanup ---
  /**
   * Detect stale/orphaned workspace directories by cross-referencing:
   * 1. Workspace directories on disk (.sandstorm/workspaces/<id>/)
   * 2. Active stacks in the SQLite registry
   * 3. Running Docker containers
   *
   * A workspace is considered stale if:
   * - It has no matching active stack in the registry, OR
   * - Its matching stack has status "completed" or "failed"
   * AND there are no running containers for it.
   */
  async detectStaleWorkspaces() {
    const projects = this.registry.listProjects();
    const activeStacks = this.registry.listStacks();
    const activeStackIds = new Set(activeStacks.map((s) => s.id));
    const staleWorkspaces = [];
    for (const project of projects) {
      const workspacesDir = path.join(project.directory, ".sandstorm", "workspaces");
      if (!fs.existsSync(workspacesDir)) continue;
      let entries;
      try {
        entries = fs.readdirSync(workspacesDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const workspacePath = path.join(workspacesDir, entry);
        let stat;
        try {
          stat = fs.statSync(workspacePath);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;
        const stackId = entry;
        const matchingStack = activeStacks.find((s) => s.id === stackId);
        if (matchingStack) {
          const activeStatuses = /* @__PURE__ */ new Set([
            "building",
            "rebuilding",
            "up",
            "running",
            "idle",
            "stopped",
            "pushed",
            "pr_created",
            "rate_limited"
          ]);
          if (activeStatuses.has(matchingStack.status)) continue;
        }
        let hasRunningContainers = false;
        try {
          const composeProjectName = `sandstorm-${sanitizeComposeName(project.name)}-${sanitizeComposeName(stackId)}`;
          const containers = await this.dockerRuntime.listContainers({ name: composeProjectName });
          hasRunningContainers = containers.some((c) => c.status === "running");
        } catch {
        }
        if (hasRunningContainers) continue;
        let sizeBytes = 0;
        try {
          sizeBytes = this.estimateDirectorySize(workspacePath);
        } catch {
        }
        let hasUnpushedChanges = false;
        try {
          hasUnpushedChanges = this.checkUnpushedChanges(workspacePath);
        } catch {
          hasUnpushedChanges = true;
        }
        const reason = !matchingStack && !activeStackIds.has(stackId) ? "orphaned" : "completed";
        staleWorkspaces.push({
          stackId,
          project: project.name,
          projectDir: project.directory,
          workspacePath,
          sizeBytes,
          hasUnpushedChanges,
          reason,
          lastModified: stat.mtime.toISOString()
        });
      }
    }
    return staleWorkspaces;
  }
  /**
   * Clean up specific stale workspace directories.
   * Uses a Docker container to handle files owned by container users.
   */
  async cleanupStaleWorkspaces(workspacePaths) {
    const results = [];
    const projects = this.registry.listProjects();
    for (const workspacePath of workspacePaths) {
      try {
        const normalized = path.resolve(workspacePath);
        const isValidPath = projects.some((project) => {
          const allowedDir = path.resolve(path.join(project.directory, ".sandstorm", "workspaces"));
          return normalized.startsWith(allowedDir + path.sep) || normalized === allowedDir;
        });
        if (!isValidPath) {
          results.push({ workspacePath, success: false, error: "Path is not within a registered project workspace directory" });
          continue;
        }
        const parentDir = path.dirname(normalized);
        const dirName = path.basename(normalized);
        try {
          const child = child_process.spawn("docker", [
            "run",
            "--rm",
            "-v",
            `${parentDir}:/workspaces`,
            "alpine",
            "rm",
            "-rf",
            `/workspaces/${dirName}`
          ], { stdio: ["ignore", "pipe", "pipe"] });
          await new Promise((resolve, reject) => {
            child.on("close", (code) => {
              if (code === 0 || !fs.existsSync(workspacePath)) {
                resolve();
              } else {
                reject(new Error(`Docker rm exited with code ${code}`));
              }
            });
            child.on("error", reject);
          });
        } catch {
          fs.rmSync(workspacePath, { recursive: true, force: true });
        }
        results.push({ workspacePath, success: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ workspacePath, success: false, error: message });
      }
    }
    return results;
  }
  /**
   * Rough estimate of directory size by summing immediate children.
   * Not recursive for performance — gives a lower bound.
   */
  estimateDirectorySize(dirPath) {
    let totalSize = 0;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        try {
          const entryPath = path.join(dirPath, entry.name);
          const stat = fs.statSync(entryPath);
          totalSize += stat.size;
          if (entry.isDirectory()) {
            totalSize += 4096;
          }
        } catch {
        }
      }
    } catch {
    }
    return totalSize;
  }
  /**
   * Check if a workspace git repo has unpushed changes.
   */
  checkUnpushedChanges(workspacePath) {
    try {
      const statusResult = child_process.execSync("git status --porcelain", {
        cwd: workspacePath,
        encoding: "utf-8",
        timeout: 5e3,
        stdio: ["ignore", "pipe", "pipe"]
      });
      if (statusResult.trim().length > 0) return true;
      try {
        const logResult = child_process.execSync("git log @{upstream}..HEAD --oneline 2>/dev/null", {
          cwd: workspacePath,
          encoding: "utf-8",
          timeout: 5e3,
          shell: "/bin/sh",
          stdio: ["ignore", "pipe", "pipe"]
        });
        if (logResult.trim().length > 0) return true;
      } catch {
        try {
          const logResult = child_process.execSync("git log --oneline -1", {
            cwd: workspacePath,
            encoding: "utf-8",
            timeout: 5e3,
            stdio: ["ignore", "pipe", "pipe"]
          });
          if (logResult.trim().length > 0) return true;
        } catch {
        }
      }
      return false;
    } catch {
      return false;
    }
  }
  destroy() {
  }
}
class DockerConnectionManager extends events.EventEmitter {
  _isConnected = false;
  healthInterval = null;
  pingFn;
  /** Exponential backoff state for API calls */
  failureCount = 0;
  backoffUntil = 0;
  /** Rate limiting: track in-flight stats calls */
  statsInFlight = 0;
  maxConcurrentStats;
  /** Rate limiting: throttle API calls per window */
  callTimestamps = [];
  maxCallsPerWindow;
  windowMs;
  /** Health check interval (ms) — faster when disconnected to detect recovery */
  healthIntervalConnected;
  healthIntervalDisconnected;
  constructor(pingFn, opts) {
    super();
    this.pingFn = pingFn;
    this.maxConcurrentStats = opts?.maxConcurrentStats ?? 4;
    this.maxCallsPerWindow = opts?.maxCallsPerWindow ?? 30;
    this.windowMs = opts?.windowMs ?? 1e4;
    this.healthIntervalConnected = opts?.healthIntervalConnected ?? 15e3;
    this.healthIntervalDisconnected = opts?.healthIntervalDisconnected ?? 5e3;
  }
  get isConnected() {
    return this._isConnected;
  }
  /**
   * Start periodic health checks. Call once at app startup.
   */
  start() {
    if (this.healthInterval) return;
    this.scheduleHealthCheck();
    this.checkHealth().catch(() => {
    });
  }
  /**
   * Stop health checks. Call on app shutdown.
   */
  stop() {
    if (this.healthInterval) {
      clearTimeout(this.healthInterval);
      this.healthInterval = null;
    }
  }
  /**
   * Check if we should back off from API calls.
   * Returns true if the caller should proceed, false if it should skip.
   */
  shouldThrottle() {
    if (!this._isConnected) return true;
    if (Date.now() < this.backoffUntil) return true;
    return false;
  }
  /**
   * Check rate limit. Returns true if the call is allowed.
   */
  acquireRateLimit() {
    const now = Date.now();
    this.callTimestamps = this.callTimestamps.filter(
      (t) => now - t < this.windowMs
    );
    if (this.callTimestamps.length >= this.maxCallsPerWindow) {
      return false;
    }
    this.callTimestamps.push(now);
    return true;
  }
  /**
   * Guard for concurrent stats calls. Returns true if allowed.
   */
  acquireStatsSlot() {
    if (this.statsInFlight >= this.maxConcurrentStats) return false;
    this.statsInFlight++;
    return true;
  }
  releaseStatsSlot() {
    this.statsInFlight = Math.max(0, this.statsInFlight - 1);
  }
  /**
   * Report a successful API call — resets backoff.
   */
  reportSuccess() {
    this.failureCount = 0;
    this.backoffUntil = 0;
  }
  /**
   * Report a failed API call — increments backoff.
   */
  reportFailure() {
    this.failureCount++;
    const delay = Math.min(1e3 * Math.pow(2, this.failureCount - 1), 3e4);
    this.backoffUntil = Date.now() + delay;
  }
  /**
   * Get current backoff delay in ms (0 if not backing off).
   */
  get currentBackoffMs() {
    const remaining = this.backoffUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  }
  async checkHealth() {
    try {
      const available = await this.pingFn();
      if (available && !this._isConnected) {
        this._isConnected = true;
        this.failureCount = 0;
        this.backoffUntil = 0;
        this.emit("connected");
      } else if (!available && this._isConnected) {
        this._isConnected = false;
        this.emit("disconnected");
      } else if (available) {
        this._isConnected = true;
      } else {
        this._isConnected = false;
      }
    } catch {
      if (this._isConnected) {
        this._isConnected = false;
        this.emit("disconnected");
      }
    }
  }
  scheduleHealthCheck() {
    const interval = this._isConnected ? this.healthIntervalConnected : this.healthIntervalDisconnected;
    this.healthInterval = setTimeout(async () => {
      await this.checkHealth();
      if (this.healthInterval !== null) {
        this.scheduleHealthCheck();
      }
    }, interval);
  }
  destroy() {
    this.stop();
    this.removeAllListeners();
  }
}
const EXEC_TIMEOUT_MS = 3e4;
const DOCKER_HEADER_SIZE = 8;
function demuxDockerStream(buf) {
  const frames = [];
  let offset = 0;
  while (offset + DOCKER_HEADER_SIZE <= buf.length) {
    const streamType = buf[offset];
    const frameSize = buf.readUInt32BE(offset + 4);
    if (offset + DOCKER_HEADER_SIZE + frameSize > buf.length) {
      break;
    }
    const content = buf.subarray(
      offset + DOCKER_HEADER_SIZE,
      offset + DOCKER_HEADER_SIZE + frameSize
    ).toString("utf-8");
    frames.push({ type: streamType, content });
    offset += DOCKER_HEADER_SIZE + frameSize;
  }
  const remainder = offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0);
  return { frames, remainder };
}
function resolveDockerSocket(explicit) {
  if (explicit) return explicit;
  const candidates = [
    "/var/run/docker.sock"
  ];
  if (process.env.HOME) {
    candidates.push(path.join(process.env.HOME, ".docker", "run", "docker.sock"));
  }
  for (const sock of candidates) {
    try {
      if (fs.existsSync(sock)) return sock;
    } catch {
    }
  }
  return "/var/run/docker.sock";
}
class DockerRuntime {
  name = "docker";
  docker;
  connectionManager;
  /** Track active log streams for cleanup */
  activeStreams = /* @__PURE__ */ new Set();
  constructor(socketPath) {
    this.docker = new Dockerode({
      socketPath: resolveDockerSocket(socketPath)
    });
    this.connectionManager = new DockerConnectionManager(
      () => this.pingDocker()
    );
    this.connectionManager.start();
  }
  getConnectionManager() {
    return this.connectionManager;
  }
  async composeUp(projectDir, opts) {
    const args = ["compose", ...this.composeFileArgs(opts)];
    if (opts.projectName) args.push("-p", opts.projectName);
    args.push("up", "-d");
    if (opts.build) args.push("--build");
    await this.runCommand("docker", args, projectDir, opts.env);
  }
  async composeDown(projectDir, opts) {
    const args = ["compose", ...this.composeFileArgs(opts)];
    if (opts.projectName) args.push("-p", opts.projectName);
    args.push("down", "-v", "--remove-orphans");
    await this.runCommand("docker", args, projectDir, opts.env);
  }
  async listContainers(filter) {
    if (this.connectionManager.shouldThrottle()) return [];
    try {
      const filters = {};
      if (filter?.label) filters.label = [filter.label];
      if (filter?.name) filters.name = [filter.name];
      if (filter?.status) filters.status = [filter.status];
      const containers = await this.docker.listContainers({
        all: true,
        filters: Object.keys(filters).length > 0 ? filters : void 0
      });
      this.connectionManager.reportSuccess();
      return containers.map((c) => ({
        id: c.Id,
        name: c.Names[0]?.replace(/^\//, "") ?? "",
        image: c.Image,
        status: this.mapState(c.State),
        state: c.State,
        ports: (c.Ports ?? []).map((p) => ({
          hostPort: p.PublicPort ?? 0,
          containerPort: p.PrivatePort,
          protocol: p.Type
        })),
        labels: c.Labels ?? {},
        created: new Date(c.Created * 1e3).toISOString()
      }));
    } catch (err) {
      this.connectionManager.reportFailure();
      throw err;
    }
  }
  async inspect(containerId) {
    const container = this.docker.getContainer(containerId);
    const data = await container.inspect();
    return {
      id: data.Id,
      name: data.Name.replace(/^\//, ""),
      state: {
        status: this.mapState(data.State.Status),
        running: data.State.Running,
        exitCode: data.State.ExitCode,
        startedAt: data.State.StartedAt,
        finishedAt: data.State.FinishedAt
      },
      config: {
        image: data.Config.Image,
        env: data.Config.Env ?? []
      }
    };
  }
  async *logs(containerId, opts) {
    const container = this.docker.getContainer(containerId);
    const baseOpts = {
      stdout: true,
      stderr: true,
      tail: opts?.tail ?? 100,
      since: opts?.since ? Math.floor(new Date(opts.since).getTime() / 1e3) : void 0
    };
    let stream;
    if (opts?.follow) {
      stream = await container.logs({ ...baseOpts, follow: true });
    } else {
      stream = await container.logs({ ...baseOpts, follow: false });
    }
    if (typeof stream === "string" || Buffer.isBuffer(stream)) {
      yield Buffer.isBuffer(stream) ? stream.toString("utf-8") : stream;
      return;
    }
    const readable = stream;
    this.activeStreams.add(readable);
    try {
      let remainder = Buffer.alloc(0);
      for await (const chunk of readable) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const input = remainder.length > 0 ? Buffer.concat([remainder, buf]) : buf;
        const { frames, remainder: leftover } = demuxDockerStream(input);
        remainder = leftover;
        for (const frame of frames) {
          yield frame.content;
        }
      }
      if (remainder.length > 0) {
        yield remainder.toString("utf-8");
      }
    } finally {
      this.activeStreams.delete(readable);
      if ("destroy" in readable && typeof readable.destroy === "function") {
        readable.destroy();
      }
    }
  }
  async exec(containerId, cmd, opts) {
    const container = this.docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: opts?.workdir,
      Env: opts?.env
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    let stdout = "";
    let stderr = "";
    let remainder = Buffer.alloc(0);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        stream.destroy();
        reject(new Error(`exec timed out after ${EXEC_TIMEOUT_MS}ms: ${cmd.join(" ")}`));
      }, EXEC_TIMEOUT_MS);
      stream.on("data", (chunk) => {
        const input = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
        const result = demuxDockerStream(input);
        remainder = result.remainder;
        for (const frame of result.frames) {
          if (frame.type === 1) stdout += frame.content;
          else if (frame.type === 2) stderr += frame.content;
          else stdout += frame.content;
        }
      });
      stream.on("end", async () => {
        if (remainder.length > 0) {
          stdout += remainder.toString("utf-8");
          remainder = Buffer.alloc(0);
        }
        clearTimeout(timeout);
        try {
          const inspection = await exec.inspect();
          resolve({
            exitCode: inspection.ExitCode ?? 0,
            stdout,
            stderr
          });
        } catch {
          resolve({ exitCode: 0, stdout, stderr });
        }
      });
      stream.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
  async containerStats(containerId) {
    if (this.connectionManager.shouldThrottle()) {
      return { memoryUsage: 0, memoryLimit: 0, cpuPercent: 0 };
    }
    if (!this.connectionManager.acquireStatsSlot()) {
      return { memoryUsage: 0, memoryLimit: 0, cpuPercent: 0 };
    }
    try {
      if (!this.connectionManager.acquireRateLimit()) {
        return { memoryUsage: 0, memoryLimit: 0, cpuPercent: 0 };
      }
      const container = this.docker.getContainer(containerId);
      const stats = await container.stats({ stream: false });
      const data = typeof stats === "string" ? JSON.parse(stats) : stats;
      this.connectionManager.reportSuccess();
      const memoryUsage = data.memory_stats?.usage ?? 0;
      const memoryLimit = data.memory_stats?.limit ?? 0;
      let cpuPercent = 0;
      const cpuDelta = (data.cpu_stats?.cpu_usage?.total_usage ?? 0) - (data.precpu_stats?.cpu_usage?.total_usage ?? 0);
      const systemDelta = (data.cpu_stats?.system_cpu_usage ?? 0) - (data.precpu_stats?.system_cpu_usage ?? 0);
      const numCpus = data.cpu_stats?.online_cpus ?? 1;
      if (systemDelta > 0 && cpuDelta >= 0) {
        cpuPercent = cpuDelta / systemDelta * numCpus * 100;
      }
      return { memoryUsage, memoryLimit, cpuPercent };
    } catch (err) {
      this.connectionManager.reportFailure();
      throw err;
    } finally {
      this.connectionManager.releaseStatsSlot();
    }
  }
  async isAvailable() {
    return this.pingDocker();
  }
  async version() {
    const info = await this.docker.version();
    return `Docker ${info.Version}`;
  }
  /**
   * Clean up all active streams and stop health monitoring.
   * Call on app shutdown.
   */
  destroy() {
    for (const stream of this.activeStreams) {
      if ("destroy" in stream && typeof stream.destroy === "function") {
        stream.destroy();
      }
    }
    this.activeStreams.clear();
    this.connectionManager.destroy();
  }
  async pingDocker() {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }
  mapState(state) {
    const normalized = state.toLowerCase();
    if (normalized === "running") return "running";
    if (normalized === "exited") return "exited";
    if (normalized === "restarting") return "restarting";
    if (normalized === "paused") return "paused";
    if (normalized === "created") return "created";
    if (normalized === "dead") return "dead";
    return normalized;
  }
  composeFileArgs(opts) {
    return opts.composeFiles.flatMap((f) => ["-f", f]);
  }
  runCommand(cmd, args, cwd, env) {
    return new Promise((resolve, reject) => {
      const child = child_process.spawn(cmd, args, {
        cwd,
        env: {
          ...process.env,
          ...env,
          PATH: [
            ...process.env.HOME ? [`${process.env.HOME}/.local/bin`] : [],
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/local/sbin",
            process.env.PATH
          ].filter(Boolean).join(":")
        },
        stdio: "pipe"
      });
      let stderr = "";
      child.stderr?.on("data", (d) => stderr += d.toString());
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
      });
      child.on("error", reject);
    });
  }
}
class PodmanRuntime {
  name = "podman";
  async composeUp(projectDir, opts) {
    const args = this.composeFileArgs(opts);
    if (opts.projectName) args.push("-p", opts.projectName);
    args.push("up", "-d");
    if (opts.build) args.push("--build");
    await this.runCommand("podman-compose", args, projectDir, opts.env);
  }
  async composeDown(projectDir, opts) {
    const args = this.composeFileArgs(opts);
    if (opts.projectName) args.push("-p", opts.projectName);
    args.push("down", "-v");
    await this.runCommand("podman-compose", args, projectDir, opts.env);
  }
  async listContainers(filter) {
    const args = ["ps", "-a", "--format", "json"];
    if (filter?.name) args.push("--filter", `name=${filter.name}`);
    if (filter?.label) args.push("--filter", `label=${filter.label}`);
    if (filter?.status) args.push("--filter", `status=${filter.status}`);
    const result = await this.runCapture("podman", args);
    if (!result.trim()) return [];
    const containers = result.trim().split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
    return containers.map((c) => ({
      id: c.Id ?? c.id ?? "",
      name: (c.Names?.[0] ?? c.Name ?? "").replace(/^\//, ""),
      image: c.Image ?? "",
      status: this.mapState(c.State ?? c.status ?? ""),
      state: c.State ?? c.status ?? "",
      ports: this.parsePorts(c.Ports ?? []),
      labels: c.Labels ?? {},
      created: c.Created ?? c.CreatedAt ?? ""
    }));
  }
  async inspect(containerId) {
    const result = await this.runCapture("podman", [
      "inspect",
      containerId,
      "--format",
      "json"
    ]);
    const data = JSON.parse(result);
    const info = Array.isArray(data) ? data[0] : data;
    return {
      id: info.Id,
      name: (info.Name ?? "").replace(/^\//, ""),
      state: {
        status: this.mapState(info.State?.Status ?? ""),
        running: info.State?.Running ?? false,
        exitCode: info.State?.ExitCode ?? 0,
        startedAt: info.State?.StartedAt ?? "",
        finishedAt: info.State?.FinishedAt ?? ""
      },
      config: {
        image: info.Config?.Image ?? "",
        env: info.Config?.Env ?? []
      }
    };
  }
  async *logs(containerId, opts) {
    const args = ["logs"];
    if (opts?.follow) args.push("-f");
    if (opts?.tail) args.push("--tail", String(opts.tail));
    if (opts?.since) args.push("--since", opts.since);
    args.push(containerId);
    const child = child_process.spawn("podman", args, { stdio: ["ignore", "pipe", "pipe"] });
    if (child.stdout) {
      for await (const chunk of child.stdout) {
        yield chunk.toString("utf-8");
      }
    }
  }
  async exec(containerId, cmd, opts) {
    const args = ["exec"];
    if (opts?.workdir) args.push("-w", opts.workdir);
    if (opts?.env) {
      for (const e of opts.env) args.push("-e", e);
    }
    args.push(containerId, ...cmd);
    return new Promise((resolve, reject) => {
      const child = child_process.spawn("podman", args, {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => stdout += d.toString());
      child.stderr?.on("data", (d) => stderr += d.toString());
      child.on(
        "close",
        (code) => resolve({ exitCode: code ?? 0, stdout, stderr })
      );
      child.on("error", reject);
    });
  }
  async containerStats(containerId) {
    const result = await this.runCapture("podman", [
      "stats",
      "--no-stream",
      "--format",
      "json",
      containerId
    ]);
    const data = JSON.parse(result);
    const entry = Array.isArray(data) ? data[0] : data;
    let memoryUsage = 0;
    let memoryLimit = 0;
    const memStr = entry?.MemUsage ?? entry?.mem_usage ?? "";
    const memParts = memStr.split("/").map((s) => s.trim());
    if (memParts.length === 2) {
      memoryUsage = this.parseMemoryStr(memParts[0]);
      memoryLimit = this.parseMemoryStr(memParts[1]);
    }
    const cpuStr = entry?.CPU ?? entry?.cpu ?? "0";
    const cpuPercent = parseFloat(cpuStr.replace("%", "")) || 0;
    return { memoryUsage, memoryLimit, cpuPercent };
  }
  parseMemoryStr(s) {
    const match = s.match(/([\d.]+)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)?/i);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    const unit = (match[2] ?? "B").toUpperCase();
    const multipliers = {
      B: 1,
      KB: 1024,
      KIB: 1024,
      MB: 1048576,
      MIB: 1048576,
      GB: 1073741824,
      GIB: 1073741824,
      TB: 1099511627776,
      TIB: 1099511627776
    };
    return val * (multipliers[unit] ?? 1);
  }
  async isAvailable() {
    try {
      await this.runCapture("podman", ["version", "--format", "json"]);
      return true;
    } catch {
      return false;
    }
  }
  async version() {
    const result = await this.runCapture("podman", [
      "version",
      "--format",
      "{{.Client.Version}}"
    ]);
    return `Podman ${result.trim()}`;
  }
  mapState(state) {
    const normalized = state.toLowerCase();
    if (normalized === "running") return "running";
    if (normalized === "exited") return "exited";
    if (normalized === "restarting") return "restarting";
    if (normalized === "paused") return "paused";
    if (normalized === "created") return "created";
    if (normalized === "dead") return "dead";
    return normalized;
  }
  parsePorts(ports) {
    return ports.filter((p) => p.host_port).map((p) => ({
      hostPort: p.host_port,
      containerPort: p.container_port,
      protocol: p.protocol ?? "tcp"
    }));
  }
  composeFileArgs(opts) {
    return opts.composeFiles.flatMap((f) => ["-f", f]);
  }
  runCapture(cmd, args) {
    return new Promise((resolve, reject) => {
      const child = child_process.spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => stdout += d.toString());
      child.stderr?.on("data", (d) => stderr += d.toString());
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
      });
      child.on("error", reject);
    });
  }
  runCommand(cmd, args, cwd, env) {
    return new Promise((resolve, reject) => {
      const child = child_process.spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: "pipe"
      });
      let stderr = "";
      child.stderr?.on("data", (d) => stderr += d.toString());
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
      });
      child.on("error", reject);
    });
  }
}
const QUALITY_GATE_FILE = "spec-quality-gate.md";
function getDefaultSpecQualityGate() {
  return `# Spec Quality Gate

Criteria for determining whether a ticket is ready for agent dispatch.
Each criterion is **pass/fail**. If any fails, the specific gap must be
resolved before the ticket enters the execution pipeline.

Customize this file to match your project's needs. This is the single
source of truth for what "ready" means in this project.

---

## Criteria

### Problem Statement
Is the "why" clearly stated? What's broken or missing?
- The ticket must explain the motivation, not just the desired change.

### Current vs Desired Behavior
Can someone understand what changes?
- Describe what happens today and what should happen after the work is done.

### Scope Boundaries
What's explicitly in scope? What's out?
- Unbounded tickets lead to scope creep. Define the edges.

### Migration Path
If it changes existing behavior, how do existing users/projects transition?
- Skip if the change is purely additive with no breaking impact.

### Edge Cases
Are known edge cases called out?
- List scenarios that could break or behave unexpectedly.

### Ambiguity Check
Are there decision points where the agent would have to guess?
- Every ambiguity is a coin flip. Resolve them before dispatch.

### Testability
Is it clear how to verify the work is correct?
- Define what "done" looks like in concrete, testable terms.

### Files/Areas Affected
Are the impacted areas of the codebase identified?
- Point the agent at the right part of the codebase.

### Assumptions — Zero Unresolved
List every assumption the agent would make if it started now.
- **Assumptions are ambiguity. Ambiguity means the spec is incomplete.**
- If an assumption can be validated by reading code, checking APIs, or running commands — the evaluator MUST validate it and replace it with a verified fact or flag it as incorrect.
- If an assumption requires human input (business logic, domain knowledge, product direction, edge case decisions) — it MUST be surfaced as an explicit question that blocks the gate.
- The gate MUST NOT pass with unresolved assumptions. Every assumption must become either a verified fact or an answered question.

### End-to-End Data Flow Verification
When a feature spans multiple system boundaries (API → DB → frontend, CLI → config → runtime, etc.):
- Testability MUST include at least one item that traces data through the entire pipeline without mocks.
- Every integration boundary the data crosses must be explicitly identified.
- A verification step must prove data arrives at the final destination under realistic conditions.
- Flag any ticket where the testability section consists entirely of mocked tests for features that span multiple layers.

### Dependency Contracts
When the ticket references another ticket, module, or external system's output:
- The data contract must be explicit — what format, what interface, when available.
- Read/write timing must be compatible — if the source writes at end-of-process and the consumer reads mid-process, that's a conflict.
- How contract compatibility is verified must be specified.
- If the data source doesn't exist yet, the ticket must include creating it or explicitly depend on a ticket that does.

### Automated Visual Verification (UI Tickets)
When the ticket describes visual changes (components, panels, layouts, modals, pages):
- An automated visual verification step against the real running application is required — not mocked component renders.
- Visual verification must exercise the same code path the user sees (real IPC, real backend, real data flow).
- If the project provides headless browser infrastructure, the verification step must use it.
- Skip this criterion if the ticket has no UI/visual changes.

### All Verification Must Be Automatable
Every verification item must be executable autonomously with no human involvement:
- No "manually verify", "visually confirm", "deploy and check".
- No optional verification checkboxes that can be skipped.
- If a verification step can't be expressed as an automated command, test, or assertion, it's not valid.
- The fix isn't "make sure humans check the boxes" — it's "eliminate manual steps entirely".
`;
}
function getSpecQualityGate(projectDir) {
  const filePath = path.join(projectDir, ".sandstorm", QUALITY_GATE_FILE);
  console.log(`[sandstorm] getSpecQualityGate: checking "${filePath}"`);
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf-8");
}
function saveSpecQualityGate(projectDir, content) {
  const sandstormDir = path.join(projectDir, ".sandstorm");
  if (!fs.existsSync(sandstormDir)) {
    fs.mkdirSync(sandstormDir, { recursive: true });
  }
  fs.writeFileSync(path.join(sandstormDir, QUALITY_GATE_FILE), content, "utf-8");
}
function isSpecQualityGateMissing(projectDir) {
  const sandstormDir = path.join(projectDir, ".sandstorm");
  if (!fs.existsSync(path.join(sandstormDir, "config"))) return false;
  return !fs.existsSync(path.join(sandstormDir, QUALITY_GATE_FILE));
}
function ensureSpecQualityGate(projectDir) {
  if (!isSpecQualityGateMissing(projectDir)) return false;
  saveSpecQualityGate(projectDir, getDefaultSpecQualityGate());
  return true;
}
function validateProjectDir(projectDir) {
  if (!projectDir || typeof projectDir !== "string" || !projectDir.trim()) {
    return {
      error: 'projectDir is required and must be a non-empty string. Pass the absolute path to the project directory (e.g., "/home/user/my-project").'
    };
  }
  if (!path.isAbsolute(projectDir)) {
    return {
      error: `projectDir must be an absolute path, got relative path: "${projectDir}". Use the full path (e.g., "/home/user/my-project") instead of a relative path like "." or "./project".`
    };
  }
  return null;
}
const tools = [
  {
    name: "create_stack",
    description: "Create a new Sandstorm stack with a name, project directory, and optional task. When a ticket is specified or the task references a GitHub issue, gateApproved must be true (run /spec-check first) or forceBypass must be true.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'Stack name (e.g., "auth-refactor")' },
        projectDir: { type: "string", description: "Absolute path to the project directory" },
        ticket: { type: "string", description: 'Ticket ID (e.g., "EXP-342")' },
        branch: { type: "string", description: "Git branch name" },
        description: { type: "string", description: "Short description of the work" },
        runtime: { type: "string", enum: ["docker", "podman"], description: "Container runtime" },
        task: { type: "string", description: "Task to dispatch immediately after creation" },
        gateApproved: { type: "boolean", description: "Set to true after running /spec-check and getting user approval. Required when a ticket is specified or the task references a GitHub issue." },
        forceBypass: { type: "boolean", description: "Set to true to bypass the spec quality gate. Only use when the user explicitly requests skipping the gate." },
        model: {
          type: "string",
          enum: ["auto", "sonnet", "opus"],
          description: `Claude model for inner agent. If omitted, uses the project's configured default model (set in Model Settings). When explicitly set to "auto", YOU must analyze the task complexity and choose the best model via lightweight triage:

**Choose "sonnet" (fast & efficient) when:**
- Typo fixes, config changes, simple bug fixes
- Well-defined tasks with clear scope (1-3 files)
- Routine refactors following existing patterns
- Straightforward feature additions with no design decisions

**Choose "opus" (most capable) when:**
- Architectural changes or multi-file features requiring design decisions
- Tricky bugs that need deep reasoning or cross-cutting analysis
- Security-sensitive or performance-critical work
- Tasks involving new patterns not yet established in the codebase
- Open-ended features where the approach is ambiguous

When you choose a model via triage, communicate your reasoning briefly (e.g., "Using Sonnet — straightforward config change" or "Using Opus — multi-file architectural refactor").`
        }
      },
      required: ["name", "projectDir"]
    }
  },
  {
    name: "list_stacks",
    description: "List all current stacks with their status and services",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "dispatch_task",
    description: "Dispatch a task to an existing stack. When the stack has a ticket or the prompt references a GitHub issue, gateApproved must be true (run /spec-check first) or forceBypass must be true.",
    inputSchema: {
      type: "object",
      properties: {
        stackId: { type: "string", description: "Stack ID to dispatch to" },
        prompt: { type: "string", description: "Task description for inner Claude" },
        gateApproved: { type: "boolean", description: "Set to true after running /spec-check and getting user approval. Required when a ticket is specified or the prompt references a GitHub issue." },
        forceBypass: { type: "boolean", description: "Set to true to bypass the spec quality gate. Only use when the user explicitly requests skipping the gate." },
        model: {
          type: "string",
          enum: ["auto", "sonnet", "opus"],
          description: `Claude model for this task. If omitted, uses the project's configured default model (set in Model Settings). When explicitly set to "auto", YOU must analyze the task complexity and choose the best model via lightweight triage:

**Choose "sonnet"** for: typo fixes, config changes, simple bugs, well-defined tasks (1-3 files), routine refactors, straightforward additions.
**Choose "opus"** for: architectural changes, multi-file features with design decisions, tricky bugs, security/performance-critical work, new patterns, ambiguous scope.

Communicate your reasoning briefly when auto-selecting.`
        }
      },
      required: ["stackId", "prompt"]
    }
  },
  {
    name: "get_diff",
    description: "Get the git diff from a stack",
    inputSchema: {
      type: "object",
      properties: {
        stackId: { type: "string", description: "Stack ID" }
      },
      required: ["stackId"]
    }
  },
  {
    name: "push_stack",
    description: "Commit and push changes from a stack",
    inputSchema: {
      type: "object",
      properties: {
        stackId: { type: "string", description: "Stack ID" },
        message: { type: "string", description: "Commit message" }
      },
      required: ["stackId"]
    }
  },
  {
    name: "get_task_status",
    description: "Get the current task status for a stack (running, completed, failed, idle)",
    inputSchema: {
      type: "object",
      properties: {
        stackId: { type: "string", description: "Stack ID" }
      },
      required: ["stackId"]
    }
  },
  {
    name: "get_task_output",
    description: "Get the latest output from the running or most recent task in a stack",
    inputSchema: {
      type: "object",
      properties: {
        stackId: { type: "string", description: "Stack ID" },
        lines: {
          type: "number",
          description: "Number of lines to return (default: 50)"
        }
      },
      required: ["stackId"]
    }
  },
  {
    name: "teardown_stack",
    description: "Tear down a stack — stops containers, removes workspace, archives to history",
    inputSchema: {
      type: "object",
      properties: {
        stackId: { type: "string", description: "Stack ID to tear down" }
      },
      required: ["stackId"]
    }
  },
  {
    name: "get_logs",
    description: "Get container logs from a stack, optionally filtered to a specific service",
    inputSchema: {
      type: "object",
      properties: {
        stackId: { type: "string", description: "Stack ID" },
        service: {
          type: "string",
          description: 'Service name to get logs for (e.g., "claude", "app"). Omit for all services.'
        }
      },
      required: ["stackId"]
    }
  },
  {
    name: "set_pr",
    description: "Record that a pull request was created for a stack. Updates the stack status to pr_created and stores the PR URL and number.",
    inputSchema: {
      type: "object",
      properties: {
        stackId: { type: "string", description: "Stack ID" },
        prUrl: { type: "string", description: "Full URL of the pull request" },
        prNumber: { type: "number", description: "Pull request number" }
      },
      required: ["stackId", "prUrl", "prNumber"]
    }
  },
  {
    name: "spec_check",
    description: "Run the spec quality gate against a ticket. Spawns an ephemeral agent to evaluate the ticket against the project's quality gate criteria. Returns a structured pass/fail report with gaps and assumptions. Use this instead of running /spec-check in-session to avoid inflating the outer session with evaluation tokens.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: 'Ticket ID (e.g., "178", "#178", "PROJ-123")' },
        projectDir: { type: "string", description: "Absolute path to the project directory" }
      },
      required: ["ticketId", "projectDir"]
    }
  },
  {
    name: "spec_refine",
    description: "Refine a ticket that failed the spec quality gate. Spawns an ephemeral agent to incorporate user answers into the ticket and re-evaluate. Call without userAnswers to get the initial gaps and questions. Call with userAnswers to update the ticket and re-check. The outer Claude shuttles questions/answers between the user and this tool — each call is a fresh ephemeral process.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", description: 'Ticket ID (e.g., "178", "#178")' },
        projectDir: { type: "string", description: "Absolute path to the project directory" },
        userAnswers: { type: "string", description: "User answers to the gap questions from the previous spec_check or spec_refine call. Omit on the first call to get the initial gaps." }
      },
      required: ["ticketId", "projectDir"]
    }
  }
];
async function handleToolCall(name, input) {
  switch (name) {
    case "create_stack": {
      const dirError = validateProjectDir(input.projectDir);
      if (dirError) return dirError;
      return exports.stackManager.createStack({
        name: input.name,
        projectDir: input.projectDir,
        ticket: input.ticket,
        branch: input.branch,
        description: input.description,
        runtime: input.runtime ?? "docker",
        task: input.task,
        model: input.model,
        gateApproved: input.gateApproved,
        forceBypass: input.forceBypass
      });
    }
    case "list_stacks":
      return exports.stackManager.listStacksWithServices();
    case "dispatch_task":
      return exports.stackManager.dispatchTask(
        input.stackId,
        input.prompt,
        input.model,
        {
          gateApproved: input.gateApproved,
          forceBypass: input.forceBypass
        }
      );
    case "get_diff":
      return exports.stackManager.getDiff(input.stackId);
    case "push_stack":
      await exports.stackManager.push(
        input.stackId,
        input.message
      );
      return { success: true };
    case "get_task_status":
      return exports.stackManager.getTaskStatus(input.stackId);
    case "get_task_output":
      return exports.stackManager.getTaskOutput(
        input.stackId,
        input.lines ?? 50
      );
    case "teardown_stack":
      await exports.stackManager.teardownStack(input.stackId);
      return { success: true };
    case "get_logs":
      return exports.stackManager.getLogs(
        input.stackId,
        input.service
      );
    case "set_pr":
      exports.stackManager.setPullRequest(
        input.stackId,
        input.prUrl,
        input.prNumber
      );
      return { success: true };
    case "spec_check": {
      const dirError = validateProjectDir(input.projectDir);
      if (dirError) return dirError;
      return handleSpecCheck(
        input.ticketId,
        input.projectDir
      );
    }
    case "spec_refine": {
      const dirError = validateProjectDir(input.projectDir);
      if (dirError) return dirError;
      return handleSpecRefine(
        input.ticketId,
        input.projectDir,
        input.userAnswers
      );
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
async function handleSpecCheck(ticketId, projectDir) {
  const scriptPath = path.join(projectDir, ".sandstorm", "scripts", "fetch-ticket.sh");
  console.log(`[sandstorm] spec_check: projectDir="${projectDir}", scriptPath="${scriptPath}"`);
  const scriptStatus = getScriptStatus(projectDir);
  if (scriptStatus === "missing") {
    return {
      passed: false,
      reason: `fetch-ticket.sh not found at ${scriptPath}. Run 'sandstorm init' to auto-generate it for your ticket system (Jira or GitHub Issues), or create it manually: the script receives a ticket ID as $1 and must output the ticket body to stdout.`
    };
  }
  if (scriptStatus === "not_executable") {
    return {
      passed: false,
      reason: `fetch-ticket.sh exists but is not executable. Fix with: chmod +x ${scriptPath}`
    };
  }
  const ticketBody = await fetchTicketContext(ticketId, projectDir);
  if (!ticketBody) {
    return {
      passed: false,
      reason: `fetch-ticket.sh ran but returned no output for ticket "${ticketId}". Check the script's implementation and that the ticket ID is correct.`
    };
  }
  const gatePath = path.join(projectDir, ".sandstorm", "spec-quality-gate.md");
  const gate = getSpecQualityGate(projectDir);
  if (!gate) {
    return {
      error: `No quality gate configured at ${gatePath}. Run sandstorm init or create .sandstorm/spec-quality-gate.md.`
    };
  }
  const prompt = `You are a spec quality gate evaluator. Evaluate the ticket below against every criterion in the quality gate. Be strict — if you'd have to guess, it's a FAIL.

## Quality Gate Criteria

${gate}

## Ticket

${ticketBody}

## Instructions

### Phase 1: Assumption Resolution
Before evaluating pass/fail, identify every assumption in the ticket (explicit "Assumes..." statements AND implicit assumptions you would make if starting this task).

For each assumption, classify it:
- **Self-resolvable**: Can be validated by reading code, checking APIs, schemas, or running commands. For these, state what you would check and whether the assumption appears correct or incorrect based on the information available.
- **Requires human input**: Business logic context, domain knowledge, behavioral expectations, product direction, edge case decisions — things the codebase can't answer. For these, formulate a specific question that must be answered before the spec is complete.

### Phase 2: Enhanced Evaluation
For each criterion, determine PASS or FAIL. Apply these additional checks:

**Assumptions — Zero Unresolved**: FAIL if any assumptions remain unresolved (neither verified as fact nor answered by user). Listing assumptions is NOT sufficient — they must be resolved.

**End-to-End Data Flow Verification**: If the feature spans multiple system boundaries, FAIL if testability consists entirely of mocked/unit tests with no end-to-end verification item. Identify every integration boundary the data crosses.

**Dependency Contracts**: If the ticket references other tickets, modules, or external systems, FAIL if the data contract is not explicit (format, interface, timing). FAIL if read/write timing is incompatible (e.g., source writes at end-of-process but consumer reads mid-process).

**Automated Visual Verification**: If the ticket describes UI/visual changes, FAIL if there is no automated visual verification step against the real running application. Mocked component renders don't count.

**All Verification Automatable**: FAIL if ANY verification item requires manual human intervention ("manually verify", "visually confirm", "deploy and check") or includes optional checkboxes that can be skipped.

### Phase 3: Report

Respond in EXACTLY this format (no other text before or after):

## Spec Quality Gate: [PASS or FAIL]

### Assumption Resolution
| # | Assumption | Type | Resolution |
|---|-----------|------|------------|
| 1 | <assumption text> | Self-resolvable / Requires human input | <verified fact OR specific question> |
...

### Results
| Criterion | Result | Notes |
|-----------|--------|-------|
| <criterion name> | PASS/FAIL | <notes> |
...

### Gaps (if any)
- [ ] Specific gap 1 — what needs to be clarified and how to fix it
...

### Questions Requiring User Answers (if any)
1. <specific question from unresolvable assumptions or ambiguities>
...`;
  const result = await exports.agentBackend.runEphemeralAgent(prompt, projectDir);
  const passed = /## Spec Quality Gate:\s*PASS/i.test(result);
  return {
    passed,
    report: result
  };
}
async function handleSpecRefine(ticketId, projectDir, userAnswers) {
  const scriptPath = path.join(projectDir, ".sandstorm", "scripts", "fetch-ticket.sh");
  console.log(`[sandstorm] spec_refine: projectDir="${projectDir}", scriptPath="${scriptPath}"`);
  const scriptStatus = getScriptStatus(projectDir);
  if (scriptStatus === "missing") {
    return {
      passed: false,
      reason: `fetch-ticket.sh not found at ${scriptPath}. Run 'sandstorm init' to auto-generate it for your ticket system (Jira or GitHub Issues), or create it manually: the script receives a ticket ID as $1 and must output the ticket body to stdout.`
    };
  }
  if (scriptStatus === "not_executable") {
    return {
      passed: false,
      reason: `fetch-ticket.sh exists but is not executable. Fix with: chmod +x ${scriptPath}`
    };
  }
  const ticketBody = await fetchTicketContext(ticketId, projectDir);
  if (!ticketBody) {
    return {
      passed: false,
      reason: `fetch-ticket.sh ran but returned no output for ticket "${ticketId}". Check the script's implementation and that the ticket ID is correct.`
    };
  }
  const gatePath = path.join(projectDir, ".sandstorm", "spec-quality-gate.md");
  const gate = getSpecQualityGate(projectDir);
  if (!gate) {
    return {
      error: `No quality gate configured at ${gatePath}. Run sandstorm init or create .sandstorm/spec-quality-gate.md.`
    };
  }
  if (!userAnswers) {
    const prompt2 = `You are a spec quality gate evaluator. Evaluate the ticket below against every criterion in the quality gate. Be strict.

## Quality Gate Criteria

${gate}

## Ticket

${ticketBody}

## Instructions

### Phase 1: Assumption Resolution
Identify every assumption (explicit and implicit). For each:
- **Self-resolvable** (can check code/APIs/schemas): State what you'd verify and whether it appears correct or incorrect.
- **Requires human input** (business logic, domain knowledge, product direction): Formulate a specific blocking question.

### Phase 2: Enhanced Evaluation
Apply ALL criteria from the quality gate, including:
- **Zero Unresolved Assumptions**: FAIL if any assumptions remain unverified/unanswered.
- **End-to-End Data Flow**: FAIL if multi-boundary features have only mocked tests.
- **Dependency Contracts**: FAIL if cross-ticket/module dependencies lack explicit contracts (format, timing, verification).
- **Automated Visual Verification**: FAIL if UI tickets lack automated visual verification against the real app.
- **All Verification Automatable**: FAIL if any verification requires manual human steps.

### Phase 3: Report
For each criterion that FAILS, ask a specific, answerable question that would resolve the gap. Don't ask vague questions — ask exactly what you need to know. Group related gaps into a single question when possible.

Respond in EXACTLY this format:

## Spec Quality Gate: [PASS or FAIL]

### Assumption Resolution
| # | Assumption | Type | Resolution |
|---|-----------|------|------------|
| 1 | <assumption text> | Self-resolvable / Requires human input | <verified fact OR specific question> |
...

### Results
| Criterion | Result | Notes |
|-----------|--------|-------|
| <criterion name> | PASS/FAIL | <notes> |
...

### Questions to Resolve Gaps
1. <specific question>
2. <specific question>
...`;
    const result2 = await exports.agentBackend.runEphemeralAgent(prompt2, projectDir);
    const passed2 = /## Spec Quality Gate:\s*PASS/i.test(result2);
    return {
      passed: passed2,
      report: result2
    };
  }
  const prompt = `You are a spec quality gate evaluator performing a refinement step.

## Quality Gate Criteria

${gate}

## Current Ticket

${ticketBody}

## User's Answers to Gap Questions

${userAnswers}

## Instructions

1. Incorporate the user's answers into the ticket body. Preserve existing content — add clarifications inline or in new sections, don't delete anything. Replace resolved assumptions with verified facts (e.g., "Verified: function X returns Y (see src/path/file.ts:42)").
2. Re-evaluate the updated ticket against ALL quality gate criteria, including:
   - **Zero Unresolved Assumptions**: Any remaining assumptions must be resolved. Listing them is not enough.
   - **End-to-End Data Flow**: Multi-boundary features need e2e verification, not just mocked tests.
   - **Dependency Contracts**: Cross-ticket/module references need explicit contracts (format, timing, verification).
   - **Automated Visual Verification**: UI tickets need automated visual checks against the real app.
   - **All Verification Automatable**: No manual steps allowed.
3. If it still FAILs, ask new specific questions for the remaining gaps.

Respond in EXACTLY this format:

## Updated Ticket Body

<the full updated ticket body with answers incorporated>

## Spec Quality Gate: [PASS or FAIL]

### Assumption Resolution
| # | Assumption | Type | Resolution |
|---|-----------|------|------------|
| 1 | <assumption text> | Self-resolvable / Requires human input | <verified fact OR answered> |
...

### Results
| Criterion | Result | Notes |
|-----------|--------|-------|
| <criterion name> | PASS/FAIL | <notes> |
...

### Questions to Resolve Remaining Gaps (if any)
1. <specific question>
...`;
  const result = await exports.agentBackend.runEphemeralAgent(prompt, projectDir);
  const passed = /## Spec Quality Gate:\s*PASS/i.test(result);
  const bodyMatch = result.match(/## Updated Ticket Body\s*\n([\s\S]*?)(?=\n## Spec Quality Gate)/);
  const updatedBody = bodyMatch ? bodyMatch[1].trim() : null;
  return {
    passed,
    report: result,
    updatedBody
  };
}
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1e3;
function getClaudeBin() {
  return process.env.HOME ? path.join(process.env.HOME, ".local", "bin", "claude") : "claude";
}
function getClaudeEnv() {
  return {
    ...process.env,
    PATH: [
      `${process.env.HOME}/.local/bin`,
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/local/sbin",
      process.env.PATH
    ].join(":")
  };
}
class ClaudeBackend {
  name = "Claude";
  sessions = /* @__PURE__ */ new Map();
  bridgeServer = null;
  bridgePort = 0;
  bridgeToken;
  mcpConfigPath = null;
  mainWindow = null;
  logStream = null;
  timeoutMs;
  modelResolver;
  tokenUsageCallback;
  constructor(timeoutMs, modelResolver) {
    this.bridgeToken = crypto.randomUUID();
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.modelResolver = modelResolver;
    this.initLogger();
  }
  /** Register a callback to receive outer Claude token usage reports per project */
  setTokenUsageCallback(callback) {
    this.tokenUsageCallback = callback;
  }
  initLogger() {
    try {
      const logDir = typeof electron.app !== "undefined" && electron.app.getPath ? electron.app.getPath("userData") : os.tmpdir();
      const logPath = path.join(logDir, "sandstorm-desktop-claude.log");
      this.logStream = fs.createWriteStream(logPath, { flags: "a" });
      this.logStream.on("error", () => {
        this.logStream = null;
      });
    } catch {
      this.logStream = null;
    }
  }
  log(message) {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const line = `[${timestamp}] ${message}
`;
    this.logStream?.write(line);
  }
  setMainWindow(win) {
    this.mainWindow = win;
  }
  async initialize() {
    await this.startBridgeServer();
    this.writeMcpConfig();
  }
  startBridgeServer() {
    return new Promise((resolve) => {
      this.bridgeServer = http.createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== "/tool-call") {
          res.writeHead(404);
          res.end();
          return;
        }
        const authToken = req.headers["x-auth-token"];
        if (authToken !== this.bridgeToken) {
          res.writeHead(403);
          res.end();
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", async () => {
          try {
            const { name, input } = JSON.parse(body);
            const result = await handleToolCall(name, input);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ result }));
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
      });
      this.bridgeServer.listen(0, "127.0.0.1", () => {
        const addr = this.bridgeServer.address();
        this.bridgePort = addr.port;
        resolve();
      });
    });
  }
  writeMcpConfig() {
    const tmpDir = path.join(os.tmpdir(), `sandstorm-mcp-${process.pid}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const serverScriptPath = path.join(tmpDir, "mcp-server.mjs");
    const serverScript = `import http from 'http';
import { createInterface } from 'readline';

const BRIDGE_PORT = ${this.bridgePort};
const BRIDGE_TOKEN = '${this.bridgeToken}';
const TOOLS = ${JSON.stringify(tools)};

const rl = createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

async function callBridge(name, input) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ name, input });
    const req = http.request({
      hostname: '127.0.0.1',
      port: BRIDGE_PORT,
      path: '/tool-call',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': BRIDGE_TOKEN,
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 310_000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.error) reject(new Error(parsed.error));
          else resolve(parsed.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Bridge request timed out after 310s'));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

rl.on('line', async (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'sandstorm-tools', version: '1.0.0' },
      }});
    } else if (msg.method === 'notifications/initialized') {
      // No response needed
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      }});
    } else if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params;
      try {
        const result = await callBridge(name, args || {});
        send({ jsonrpc: '2.0', id: msg.id, result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        }});
      } catch (err) {
        send({ jsonrpc: '2.0', id: msg.id, result: {
          content: [{ type: 'text', text: 'Error: ' + err.message }],
          isError: true,
        }});
      }
    }
  } catch {
    // Ignore malformed input
  }
});
`;
    fs.writeFileSync(serverScriptPath, serverScript);
    this.mcpConfigPath = path.join(tmpDir, "mcp-config.json");
    const mcpConfig = {
      mcpServers: {
        "sandstorm-tools": {
          command: "node",
          args: [serverScriptPath]
        }
      }
    };
    fs.writeFileSync(this.mcpConfigPath, JSON.stringify(mcpConfig));
  }
  // --- Session management (AgentBackend interface) ---
  sendMessage(tabId, message, projectDir) {
    let session = this.sessions.get(tabId);
    if (!session) {
      session = {
        tabId,
        process: null,
        ready: false,
        pendingMessages: [],
        messages: [],
        processing: false,
        projectDir,
        watchdog: null,
        outputBuffer: "",
        fullResponse: "",
        stderrBuffer: ""
      };
      this.sessions.set(tabId, session);
    }
    if (projectDir) {
      session.projectDir = projectDir;
    }
    session.messages.push({ role: "user", content: message });
    session.processing = true;
    this.mainWindow?.webContents.send(`agent:user-message:${tabId}`, message);
    this.log(`Message received for tab=${tabId}`);
    if (session.process && session.fullResponse !== "") {
      session.pendingMessages.push(message);
      this.log(`Message queued for tab=${tabId} (queue size: ${session.pendingMessages.length})`);
      this.mainWindow?.webContents.send(`agent:queued:${tabId}`);
      return;
    }
    this.ensureProcess(tabId);
    this.writeMessage(tabId, message);
  }
  getHistory(tabId) {
    const session = this.sessions.get(tabId);
    if (!session) {
      return { messages: [], processing: false };
    }
    return { messages: [...session.messages], processing: session.processing };
  }
  cancelSession(tabId) {
    const session = this.sessions.get(tabId);
    if (!session) return;
    if (session.watchdog) clearTimeout(session.watchdog);
    session.watchdog = null;
    if (session.process) {
      session.process.kill();
      session.process = null;
    }
    session.ready = false;
    session.fullResponse = "";
    session.outputBuffer = "";
    session.stderrBuffer = "";
    session.pendingMessages = [];
  }
  resetSession(tabId) {
    this.cancelSession(tabId);
    this.sessions.delete(tabId);
  }
  // --- Ephemeral agent (one-shot Claude process) ---
  /**
   * Spawn a one-shot Claude process that evaluates a prompt and returns the text result.
   * Uses -p (pipe/print) mode — no session persistence, no MCP tools.
   * Used for spec quality gate evaluation to avoid inflating the outer session.
   */
  runEphemeralAgent(prompt, projectDir, timeoutMs = 3e5) {
    return new Promise((resolve, reject) => {
      const claudeBin = getClaudeBin();
      const args = [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
        "--verbose"
      ];
      const child = child_process.spawn(claudeBin, args, {
        cwd: projectDir,
        env: getClaudeEnv(),
        stdio: ["ignore", "pipe", "pipe"]
      });
      let outputBuffer = "";
      let fullText = "";
      let stderrBuffer = "";
      let settled = false;
      const settle = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null) {
              child.kill("SIGKILL");
            }
          }, 5e3);
          settle(() => reject(new Error(`Ephemeral agent timed out after ${timeoutMs}ms`)));
        }
      }, timeoutMs);
      child.stdout?.on("data", (data) => {
        outputBuffer += data.toString();
        const lines = outputBuffer.split("\n");
        outputBuffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            const text = this.extractText(parsed);
            if (text) fullText += text;
          } catch {
          }
        }
      });
      child.stderr?.on("data", (data) => {
        stderrBuffer += data.toString();
      });
      child.on("close", (code) => {
        if (outputBuffer.trim()) {
          try {
            const parsed = JSON.parse(outputBuffer);
            const text = this.extractText(parsed);
            if (text) fullText += text;
          } catch {
          }
        }
        settle(() => {
          if (code !== 0 && !fullText.trim()) {
            reject(new Error(
              `Ephemeral agent exited with code ${code}: ${stderrBuffer.trim() || "unknown error"}`
            ));
          } else {
            resolve(fullText);
          }
        });
      });
      child.on("error", (err) => {
        settle(() => reject(err));
      });
    });
  }
  // --- Auth (AgentBackend interface) ---
  async getAuthStatus() {
    const credsPath = path.join(process.env.HOME || "", ".claude", ".credentials.json");
    let expired = false;
    let expiresAt;
    try {
      const raw = fs.readFileSync(credsPath, "utf-8");
      const creds = JSON.parse(raw);
      const oauthData = creds.claudeAiOauth;
      if (oauthData?.expiresAt) {
        expiresAt = oauthData.expiresAt;
        expired = Date.now() > oauthData.expiresAt;
      }
    } catch {
      return { loggedIn: false, expired: false };
    }
    try {
      const result = await new Promise((resolve) => {
        const child = child_process.spawn(getClaudeBin(), ["auth", "status", "--output", "json"], {
          env: getClaudeEnv(),
          stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        child.stdout.on("data", (d) => {
          stdout += d.toString();
        });
        child.on("close", (code) => resolve({ stdout, exitCode: code ?? 1 }));
        child.on("error", () => resolve({ stdout: "", exitCode: 1 }));
      });
      if (result.exitCode === 0 && result.stdout.trim()) {
        const status = JSON.parse(result.stdout.trim());
        return {
          loggedIn: status.loggedIn ?? false,
          email: status.email,
          expired,
          expiresAt
        };
      }
    } catch {
    }
    return { loggedIn: true, expired, expiresAt };
  }
  async login(mainWindow2) {
    const win = mainWindow2 ?? this.mainWindow;
    return new Promise((resolve) => {
      const child = child_process.spawn(getClaudeBin(), ["auth", "login"], {
        env: getClaudeEnv(),
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let urlOpened = false;
      child.stdout.on("data", (data) => {
        stdout += data.toString();
        const urlMatch = stdout.match(/(https:\/\/[^\s]+)/);
        if (urlMatch && !urlOpened) {
          urlOpened = true;
          electron.shell.openExternal(urlMatch[1]);
          win?.webContents.send("auth:url-opened", urlMatch[1]);
        }
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      setTimeout(() => {
        try {
          child.stdin.write("\n");
        } catch {
        }
      }, 1e3);
      child.on("close", async (code) => {
        if (code === 0) {
          win?.webContents.send("auth:completed", true);
          resolve({ success: true });
        } else {
          win?.webContents.send("auth:completed", false);
          resolve({ success: false, error: stderr.trim() || "Auth login failed" });
        }
      });
      child.on("error", (err) => {
        resolve({ success: false, error: err.message });
      });
      setTimeout(() => {
        try {
          child.kill();
        } catch {
        }
        resolve({ success: false, error: "Auth login timed out" });
      }, 5 * 60 * 1e3);
    });
  }
  async syncCredentials(stacks) {
    const credsPath = path.join(process.env.HOME || "", ".claude", ".credentials.json");
    let creds;
    try {
      creds = fs.readFileSync(credsPath, "utf-8");
    } catch {
      return;
    }
    try {
      for (const stack of stacks) {
        if (stack.status !== "running" && stack.status !== "up") continue;
        const claudeService = stack.services?.find(
          (s) => s.name === "claude"
        );
        if (!claudeService?.containerId) continue;
        try {
          const child = child_process.spawn("docker", [
            "exec",
            "-i",
            "-u",
            "claude",
            claudeService.containerId,
            "bash",
            "-c",
            "mkdir -p ~/.claude && cat > ~/.claude/.credentials.json"
          ], { stdio: ["pipe", "ignore", "ignore"] });
          child.stdin.write(creds);
          child.stdin.end();
          await new Promise((resolve) => child.on("close", () => resolve()));
        } catch {
        }
      }
    } catch {
    }
  }
  // --- Private: persistent Claude process management ---
  /**
   * Write an NDJSON user message to the persistent process's stdin.
   */
  writeMessage(tabId, message) {
    const session = this.sessions.get(tabId);
    if (!session?.process?.stdin?.writable) return;
    session.fullResponse = "";
    const ndjson = JSON.stringify({
      type: "user",
      message: { role: "user", content: message }
    });
    session.process.stdin.write(ndjson + "\n");
    this.log(`Wrote message to stdin for tab=${tabId} (${message.length} chars)`);
    this.resetWatchdog(tabId);
  }
  resetWatchdog(tabId) {
    const session = this.sessions.get(tabId);
    if (!session) return;
    if (session.watchdog) clearTimeout(session.watchdog);
    session.watchdog = setTimeout(() => {
      this.log(`Watchdog timeout for tab=${tabId} after ${this.timeoutMs}ms — killing process`);
      if (session.process) {
        session.process.kill();
      }
    }, this.timeoutMs);
  }
  /**
   * Ensure a persistent Claude process is running for the given tab.
   * Spawns one if none exists. The process stays alive across messages.
   */
  ensureProcess(tabId) {
    const session = this.sessions.get(tabId);
    if (!session || session.process) return;
    const systemPromptFile = path.join(exports.cliDir, "SANDSTORM_OUTER.md");
    const claudeBin = getClaudeBin();
    const args = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions"
    ];
    if (fs.existsSync(systemPromptFile)) {
      args.push("--system-prompt-file", systemPromptFile);
    }
    if (this.mcpConfigPath) {
      args.push("--mcp-config", this.mcpConfigPath);
    }
    if (this.modelResolver && session.projectDir) {
      const outerModel = this.modelResolver(session.projectDir);
      args.push("--model", outerModel);
    }
    const cwd = session.projectDir || process.cwd();
    const child = child_process.spawn(claudeBin, args, {
      cwd,
      env: getClaudeEnv(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    session.process = child;
    session.ready = false;
    session.outputBuffer = "";
    session.fullResponse = "";
    session.stderrBuffer = "";
    this.log(`Persistent Claude process spawned for tab=${tabId} pid=${child.pid}`);
    const send = (channel, ...data) => {
      this.mainWindow?.webContents.send(channel, ...data);
    };
    child.stdout?.on("data", (data) => {
      const text = data.toString();
      session.outputBuffer += text;
      const lines = session.outputBuffer.split("\n");
      session.outputBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "system" && parsed.subtype === "init" && !session.ready) {
            session.ready = true;
            this.log(`Claude process ready for tab=${tabId}`);
            continue;
          }
          if (parsed.type === "result") {
            if (session.watchdog) clearTimeout(session.watchdog);
            session.watchdog = null;
            if (parsed.usage && session.projectDir && this.tokenUsageCallback) {
              const inTokens = parsed.usage.input_tokens ?? 0;
              const outTokens = parsed.usage.output_tokens ?? 0;
              if (inTokens > 0 || outTokens > 0) {
                this.tokenUsageCallback(session.projectDir, inTokens, outTokens);
              }
            }
            if (session.fullResponse) {
              session.messages.push({ role: "assistant", content: session.fullResponse });
            }
            send(`agent:done:${tabId}`);
            if (session.pendingMessages.length > 0) {
              const next = session.pendingMessages.shift();
              this.log(`Dequeuing message after result for tab=${tabId} (remaining: ${session.pendingMessages.length})`);
              this.writeMessage(tabId, next);
            } else {
              session.processing = false;
              session.fullResponse = "";
            }
            continue;
          }
          if (parsed.type === "error") {
            const errorMsg = parsed.error?.message || "Unknown error";
            this.log(`Claude error for tab=${tabId}: ${errorMsg}`);
            continue;
          }
          const extracted = this.extractText(parsed);
          if (extracted) {
            session.fullResponse += extracted;
            send(`agent:output:${tabId}`, extracted);
          }
        } catch {
        }
      }
    });
    child.stderr?.on("data", (data) => {
      const text = data.toString();
      session.stderrBuffer += text;
      this.log(`stderr [tab=${tabId}]: ${text.trimEnd()}`);
    });
    child.on("close", (code) => {
      if (session.watchdog) clearTimeout(session.watchdog);
      session.watchdog = null;
      session.process = null;
      session.ready = false;
      this.log(`Persistent Claude process exited for tab=${tabId} code=${code}`);
      if (session.processing) {
        const errorMsg = session.stderrBuffer.trim() || `Claude process exited unexpectedly (code ${code})`;
        send(`agent:error:${tabId}`, errorMsg);
        session.processing = false;
        session.pendingMessages = [];
      }
      session.outputBuffer = "";
      session.fullResponse = "";
      session.stderrBuffer = "";
    });
    child.on("error", (err) => {
      if (session.watchdog) clearTimeout(session.watchdog);
      session.watchdog = null;
      session.process = null;
      session.ready = false;
      session.processing = false;
      session.pendingMessages = [];
      this.log(`Spawn error for tab=${tabId}: ${err.message}`);
      send(`agent:error:${tabId}`, err.message);
    });
  }
  extractText(parsed) {
    if (parsed.type === "assistant") {
      const msg = parsed.message;
      if (msg?.content && Array.isArray(msg.content)) {
        const texts = [];
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            texts.push(block.text);
          }
        }
        if (texts.length > 0) return texts.join("");
      }
    }
    if (parsed.type === "content_block_delta") {
      const delta = parsed.delta;
      if (delta?.text) return delta.text;
    }
    return null;
  }
  destroy() {
    for (const session of this.sessions.values()) {
      if (session.process) {
        session.process.kill();
      }
    }
    this.sessions.clear();
    this.bridgeServer?.close();
    this.logStream?.end();
    this.logStream = null;
    if (this.mcpConfigPath) {
      const tmpDir = path.dirname(this.mcpConfigPath);
      try {
        fs.rmSync(tmpDir, { recursive: true });
      } catch {
      }
    }
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function execAsync(cmd, timeoutMs = 2e4) {
  return new Promise((resolve, reject) => {
    child_process.exec(cmd, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b[()][0-9A-Za-z]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}
let claudeChecked = false;
let claudeAvailable = false;
async function checkClaudeInstalled() {
  if (claudeChecked) return claudeAvailable;
  try {
    await execAsync("which claude");
    claudeAvailable = true;
  } catch {
    claudeAvailable = false;
  }
  claudeChecked = true;
  return claudeAvailable;
}
function parseUsageBlock(pane, label) {
  const re = new RegExp(
    label + "[^\\n]*\\n[^\\n]*?\\s(\\d+)%\\s*used[^\\n]*\\n[^\\n]*Resets ([^\\n]+)"
  );
  const m = pane.match(re);
  if (!m) return null;
  const resetsAt = m[2].replace(/[\s│╯╰╮╭─]+$/u, "");
  return { percent: Number(m[1]), resetsAt };
}
function isRateLimited(pane) {
  const lower = pane.toLowerCase();
  return lower.includes("rate") && lower.includes("limit") || lower.includes("frequently") || lower.includes("try again") || lower.includes("too many");
}
function isAuthExpired(pane) {
  const lower = pane.toLowerCase();
  return lower.includes("auth") || lower.includes("login") || lower.includes("sign in") || lower.includes("authenticate") || lower.includes("expired");
}
function parseUsageOutput(pane) {
  const session = parseUsageBlock(pane, "Current session");
  const weekAll = parseUsageBlock(pane, "Current week \\(all models\\)");
  const weekSonnet = parseUsageBlock(pane, "Current week \\(Sonnet only\\)");
  const extraUsageEnabled = !/Extra usage not enabled/.test(pane);
  const capturedAt = (/* @__PURE__ */ new Date()).toISOString();
  if (session) {
    const status = session.percent >= 95 ? "at_limit" : "ok";
    return {
      session,
      weekAll,
      weekSonnet,
      extraUsage: { enabled: extraUsageEnabled },
      capturedAt,
      status
    };
  }
  if (isRateLimited(pane)) {
    return {
      session: null,
      weekAll: null,
      weekSonnet: null,
      extraUsage: { enabled: false },
      capturedAt,
      status: "rate_limited"
    };
  }
  if (isAuthExpired(pane)) {
    return {
      session: null,
      weekAll: null,
      weekSonnet: null,
      extraUsage: { enabled: false },
      capturedAt,
      status: "auth_expired"
    };
  }
  return {
    session: null,
    weekAll: null,
    weekSonnet: null,
    extraUsage: { enabled: false },
    capturedAt,
    status: "parse_error"
  };
}
function waitForOutput(ptyProcess, markers, timeoutMs, existingBuffer) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      disposable.dispose();
      resolve(false);
    }, timeoutMs);
    const disposable = ptyProcess.onData(() => {
      const clean2 = stripAnsi(existingBuffer.value);
      for (const marker of markers) {
        if (clean2.includes(marker)) {
          clearTimeout(timer);
          disposable.dispose();
          resolve(true);
          return;
        }
      }
    });
    const clean = stripAnsi(existingBuffer.value);
    for (const marker of markers) {
      if (clean.includes(marker)) {
        clearTimeout(timer);
        disposable.dispose();
        resolve(true);
        return;
      }
    }
  });
}
async function fetchAccountUsage() {
  if (!await checkClaudeInstalled()) {
    return null;
  }
  const claudeArgs = [
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources",
    "user"
  ];
  let proc = null;
  const buffer = { value: "" };
  try {
    proc = nodePty__namespace.spawn("claude", claudeArgs, {
      name: "xterm-256color",
      cols: 220,
      rows: 60,
      env: {
        ...process.env,
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1"
      }
    });
    proc.onData((data) => {
      buffer.value += data;
    });
    const ready = await waitForOutput(proc, ["for shortcuts"], 15e3, buffer);
    if (!ready) {
      return {
        session: null,
        weekAll: null,
        weekSonnet: null,
        extraUsage: { enabled: false },
        capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
        status: "parse_error"
      };
    }
    await sleep(500);
    proc.write("/usage\r");
    const usageReady = await waitForOutput(
      proc,
      ["Current session", "Extra usage"],
      1e4,
      buffer
    );
    if (usageReady) {
      await sleep(1e3);
    }
    const cleanOutput = stripAnsi(buffer.value);
    try {
      proc.write("\x1B");
      await sleep(300);
      proc.write("/exit\r");
    } catch {
    }
    return parseUsageOutput(cleanOutput);
  } catch {
    return null;
  } finally {
    if (proc) {
      try {
        proc.kill();
      } catch {
      }
    }
  }
}
const CONTEXT_DIR = ".sandstorm/context";
const SKILLS_DIR = "skills";
const INSTRUCTIONS_FILE = "instructions.md";
const SETTINGS_FILE = "settings.json";
function contextDir(projectDir) {
  return path.join(projectDir, CONTEXT_DIR);
}
function ensureContextDir(projectDir) {
  const dir = contextDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function ensureSkillsDir(projectDir) {
  const dir = path.join(contextDir(projectDir), SKILLS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function ensureGitignored(projectDir) {
  const sandstormDir = path.join(projectDir, ".sandstorm");
  if (!fs.existsSync(sandstormDir)) return;
  const gitignorePath = path.join(sandstormDir, ".gitignore");
  const entry = "context/";
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (content.split("\n").some((line) => line.trim() === entry)) return;
    fs.appendFileSync(gitignorePath, `
${entry}
`);
  } else {
    fs.writeFileSync(gitignorePath, `# Sandstorm local files (not committed)
${entry}
`);
  }
}
function getCustomContext(projectDir) {
  return {
    instructions: getInstructions(projectDir),
    skills: listCustomSkills(projectDir),
    settings: getCustomSettings(projectDir)
  };
}
function getInstructions(projectDir) {
  const filePath = path.join(contextDir(projectDir), INSTRUCTIONS_FILE);
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf-8");
}
function saveCustomInstructions(projectDir, content) {
  ensureContextDir(projectDir);
  ensureGitignored(projectDir);
  const filePath = path.join(contextDir(projectDir), INSTRUCTIONS_FILE);
  fs.writeFileSync(filePath, content, "utf-8");
}
function listCustomSkills(projectDir) {
  const dir = path.join(contextDir(projectDir), SKILLS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
}
function getCustomSkill(projectDir, name) {
  const filePath = path.join(contextDir(projectDir), SKILLS_DIR, `${name}.md`);
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf-8");
}
function saveCustomSkill(projectDir, name, content) {
  ensureSkillsDir(projectDir);
  ensureGitignored(projectDir);
  const filePath = path.join(contextDir(projectDir), SKILLS_DIR, `${name}.md`);
  fs.writeFileSync(filePath, content, "utf-8");
}
function deleteCustomSkill(projectDir, name) {
  const filePath = path.join(contextDir(projectDir), SKILLS_DIR, `${name}.md`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}
function getCustomSettings(projectDir) {
  const filePath = path.join(contextDir(projectDir), SETTINGS_FILE);
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf-8");
}
function saveCustomSettings(projectDir, content) {
  ensureContextDir(projectDir);
  ensureGitignored(projectDir);
  const filePath = path.join(contextDir(projectDir), SETTINGS_FILE);
  fs.writeFileSync(filePath, content, "utf-8");
}
function parseNamedNetworks(composeContent) {
  const results = [];
  const networksMatch = composeContent.match(/^networks:\s*\n((?:[ \t]+.*\n?)*)/m);
  if (!networksMatch) return results;
  const networksBlock = networksMatch[1];
  const keyRegex = /^  (\w[\w-]*):\s*\n((?:    .*\n?)*)/gm;
  let keyMatch;
  while ((keyMatch = keyRegex.exec(networksBlock)) !== null) {
    const key = keyMatch[1];
    const body = keyMatch[2];
    const nameMatch = body.match(/^\s+name:\s*(.+)/m);
    if (nameMatch) {
      const name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
      results.push({ key, name });
    }
  }
  return results;
}
function findMissingNetworkOverrides(sandstormComposeContent, namedNetworks) {
  return namedNetworks.filter(({ key }) => {
    const pattern = new RegExp(
      `name:\\s*\\$\\{SANDSTORM_PROJECT\\}-${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`
    );
    return !pattern.test(sandstormComposeContent);
  });
}
function migrateNetworkOverrides(directory) {
  const projectComposePath = path.join(directory, "docker-compose.yml");
  if (!fs.existsSync(projectComposePath)) return false;
  const sandstormComposePath = path.join(directory, ".sandstorm", "docker-compose.yml");
  if (!fs.existsSync(sandstormComposePath)) return false;
  const projectCompose = fs.readFileSync(projectComposePath, "utf-8");
  const namedNetworks = parseNamedNetworks(projectCompose);
  if (namedNetworks.length === 0) return false;
  const sandstormCompose = fs.readFileSync(sandstormComposePath, "utf-8");
  const missing = findMissingNetworkOverrides(sandstormCompose, namedNetworks);
  if (missing.length === 0) return false;
  const hasExistingNetworks = /^networks:\s*$/m.test(sandstormCompose);
  if (hasExistingNetworks) {
    const additions = missing.map((n) => `  ${n.key}:
    name: \${SANDSTORM_PROJECT}-${n.key}`).join("\n");
    const updatedCompose = sandstormCompose.replace(
      /^(networks:\s*\n)/m,
      `$1${additions}
`
    );
    fs.writeFileSync(sandstormComposePath, updatedCompose);
  } else {
    const networkBlock = "\nnetworks:\n" + missing.map((n) => `  ${n.key}:
    name: \${SANDSTORM_PROJECT}-${n.key}`).join("\n") + "\n";
    const updatedCompose = sandstormCompose.trimEnd() + "\n" + networkBlock;
    fs.writeFileSync(sandstormComposePath, updatedCompose);
  }
  return true;
}
function findProjectComposeFile(projectDir, configComposeFile) {
  if (configComposeFile) {
    const resolved = path.isAbsolute(configComposeFile) ? configComposeFile : path.join(projectDir, configComposeFile);
    return fs.existsSync(resolved) ? configComposeFile : null;
  }
  const candidates = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(projectDir, candidate))) {
      return candidate;
    }
  }
  return null;
}
function readComposeFileFromConfig(projectDir) {
  const configPath = path.join(projectDir, ".sandstorm", "config");
  if (!fs.existsSync(configPath)) return void 0;
  const content = fs.readFileSync(configPath, "utf-8");
  const match = content.match(/^COMPOSE_FILE=(.*)$/m);
  if (match) {
    return match[1].trim() || void 0;
  }
  return void 0;
}
function parseProjectCompose(projectDir, composeFile) {
  const fullPath = path.isAbsolute(composeFile) ? composeFile : path.join(projectDir, composeFile);
  const content = fs.readFileSync(fullPath, "utf-8");
  const projectName = path.basename(projectDir).toLowerCase().replace(/[^a-z0-9]/g, "-");
  const services = parseServices(content);
  const namedNetworks = parseNetworks(content);
  return {
    services,
    namedNetworks,
    projectName,
    composeFile
  };
}
function parseServices(content) {
  const services = [];
  const servicesMatch = content.match(/^services:\s*\n((?:[ \t]+.*\n?)*)/m);
  if (!servicesMatch) return services;
  const servicesBlock = servicesMatch[1];
  const serviceChunks = servicesBlock.split(/^  (?=\w)/m).filter(Boolean);
  for (const chunk of serviceChunks) {
    const nameMatch = chunk.match(/^([\w][\w-]*):\s*$/m) || chunk.match(/^([\w][\w-]*):\s*\n/m);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const ports = parsePorts(chunk);
    const image = parseImage(chunk);
    const hasBuilt = /^\s+build:/m.test(chunk);
    const description = autoDescribeService(name, image);
    services.push({ name, ports, image, hasBuilt, description });
  }
  return services;
}
function parsePorts(serviceBlock) {
  const ports = [];
  const portsMatch = serviceBlock.match(/^\s+ports:\s*\n((?:\s+-\s+.*\n?)*)/m);
  if (!portsMatch) return ports;
  const portsBlock = portsMatch[1];
  const portLines = portsBlock.match(/^\s+-\s+["']?(\d+):(\d+)["']?\s*$/gm);
  if (!portLines) return ports;
  for (const line of portLines) {
    const match = line.match(/(\d+):(\d+)/);
    if (match) {
      ports.push({ host: match[1], container: match[2] });
    }
  }
  return ports;
}
function parseImage(serviceBlock) {
  const match = serviceBlock.match(/^\s+image:\s*(.+)$/m);
  return match ? match[1].trim() : "";
}
function parseNetworks(content) {
  const results = [];
  const networksMatch = content.match(/^networks:\s*\n((?:[ \t]+.*\n?)*)/m);
  if (!networksMatch) return results;
  const networksBlock = networksMatch[1];
  const keyRegex = /^ {2}(\w[\w-]*):\s*\n((?:\s{4}.*\n?)*)/gm;
  let keyMatch;
  while ((keyMatch = keyRegex.exec(networksBlock)) !== null) {
    const key = keyMatch[1];
    const body = keyMatch[2];
    const nameMatch = body.match(/^\s+name:\s*(.+)/m);
    if (nameMatch) {
      const name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
      results.push({ key, name });
    }
  }
  return results;
}
function autoDescribeService(name, image) {
  if (image.includes("postgres")) return "PostgreSQL database";
  if (image.includes("mysql")) return "MySQL database";
  if (image.includes("redis")) return "Redis cache/store";
  if (image.includes("mongo")) return "MongoDB database";
  if (image.includes("nginx")) return "Nginx web server";
  if (image.includes("rabbitmq")) return "RabbitMQ message broker";
  if (image.includes("elasticsearch") || image.includes("opensearch")) return "Search engine";
  if (!image) return "Application service";
  return `Service (${image})`;
}
function buildPortMap(services) {
  const entries = [];
  for (const svc of services) {
    svc.ports.forEach((port, idx) => {
      entries.push(`${svc.name}:${port.host}:${port.container}:${idx}`);
    });
  }
  return entries.join(",");
}
function generateComposeYaml(analysis) {
  const lines = [
    "# Sandstorm stack override — adds Claude workspace + remaps ports.",
    "#",
    "# All project services run untouched from the project's docker-compose.yml.",
    "# Bind mounts resolve to the workspace clone (not the host project).",
    "# Port mappings are offset by stack ID to avoid conflicts.",
    "#",
    "# Image names are pinned to sandstorm-<project>-<service> so all stacks",
    "# share the same images. Rebuild once, all stacks inherit the update.",
    "#",
    "# Do not run standalone. Sandstorm chains it automatically.",
    "",
    "services:"
  ];
  for (const svc of analysis.services) {
    lines.push(`  ${svc.name}:`);
    if (svc.hasBuilt) {
      lines.push(`    image: sandstorm-${analysis.projectName}-${svc.name}`);
    }
    if (svc.ports.length > 0) {
      lines.push("    ports: !override");
      svc.ports.forEach((port, idx) => {
        lines.push(`      - "\${SANDSTORM_PORT_${svc.name}_${idx}}:${port.container}"`);
      });
    }
    const safeDesc = svc.description.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    lines.push("    labels:");
    lines.push(`      sandstorm.description: "${safeDesc}"`);
  }
  lines.push(`  claude:`);
  lines.push(`    image: sandstorm-${analysis.projectName}-claude`);
  lines.push("    build:");
  lines.push("      context: ${SANDSTORM_DIR}");
  lines.push("      dockerfile: docker/Dockerfile");
  lines.push("      args:");
  lines.push("        SANDSTORM_APP_VERSION: ${SANDSTORM_APP_VERSION:-unknown}");
  lines.push("    environment:");
  lines.push("      - GIT_USER_NAME");
  lines.push("      - GIT_USER_EMAIL");
  lines.push("      - SANDSTORM_PROJECT");
  lines.push("      - SANDSTORM_STACK_ID");
  lines.push("    volumes:");
  lines.push("      - ${SANDSTORM_WORKSPACE}:/app");
  lines.push("      - ${SANDSTORM_CONTEXT}:/sandstorm-context:ro");
  lines.push("      - /var/run/docker.sock:/var/run/docker.sock");
  lines.push("    healthcheck:");
  lines.push('      test: ["CMD", "test", "-f", "/app/.sandstorm-ready"]');
  lines.push("      interval: 3s");
  lines.push("      timeout: 2s");
  lines.push("      retries: 60");
  lines.push("    tty: true");
  lines.push("    stdin_open: true");
  if (analysis.namedNetworks.length > 0) {
    lines.push("");
    lines.push("networks:");
    for (const net2 of analysis.namedNetworks) {
      lines.push(`  ${net2.key}:`);
      lines.push(`    name: \${SANDSTORM_PROJECT}-${net2.key}`);
    }
  }
  return lines.join("\n") + "\n";
}
function generateConfig(analysis) {
  const portMap = buildPortMap(analysis.services);
  return [
    "# Sandstorm project configuration",
    `# Generated from: ${analysis.composeFile}`,
    "",
    `# Project name (used in stack naming: sandstorm-<project>-<id>)`,
    `PROJECT_NAME=${analysis.projectName}`,
    "",
    `# Project's docker-compose file`,
    `COMPOSE_FILE=${analysis.composeFile}`,
    "",
    "# Port mappings — service:host_port:container_port:index (comma-separated)",
    "# Host ports are remapped by adding (stack_id * PORT_OFFSET) at runtime",
    `PORT_MAP=${portMap}`,
    "",
    "# Port offset multiplier per stack (default: 10)",
    "# Stack 1 gets +10, stack 2 gets +20, etc.",
    "PORT_OFFSET=10",
    "",
    "# Optional: ticket prefix for branch safety checks (e.g., PROJ)",
    "# TICKET_PREFIX=",
    ""
  ].join("\n");
}
function generateSandstormCompose(projectDir, composeFile) {
  const analysis = parseProjectCompose(projectDir, composeFile);
  const yaml = generateComposeYaml(analysis);
  const config = generateConfig(analysis);
  return { yaml, config, analysis };
}
function checkInitState(projectDir) {
  const sandstormDir = path.join(projectDir, ".sandstorm");
  const configPath = path.join(sandstormDir, "config");
  const composePath = path.join(sandstormDir, "docker-compose.yml");
  if (!fs.existsSync(configPath)) {
    return "uninitialized";
  }
  if (!fs.existsSync(composePath)) {
    return "partial";
  }
  return "full";
}
function saveComposeSetup(projectDir, composeYaml, updateConfig, composeFile) {
  try {
    const sandstormDir = path.join(projectDir, ".sandstorm");
    fs.mkdirSync(path.join(sandstormDir, "stacks"), { recursive: true });
    const composePath = path.join(sandstormDir, "docker-compose.yml");
    fs.writeFileSync(composePath, composeYaml);
    if (updateConfig && composeFile) {
      const configPath = path.join(sandstormDir, "config");
      if (fs.existsSync(configPath)) {
        let configContent = fs.readFileSync(configPath, "utf-8");
        if (/^COMPOSE_FILE=/m.test(configContent)) {
          configContent = configContent.replace(/^COMPOSE_FILE=.*$/m, `COMPOSE_FILE=${composeFile}`);
        } else {
          configContent += `
COMPOSE_FILE=${composeFile}
`;
        }
        fs.writeFileSync(configPath, configContent);
      }
    }
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}
function validateComposeYaml(yaml) {
  if (!yaml.trim()) {
    return { valid: false, error: "YAML content is empty" };
  }
  if (/^\t/m.test(yaml)) {
    return { valid: false, error: "YAML must not use tabs for indentation" };
  }
  if (!/^services:\s*$/m.test(yaml)) {
    return { valid: false, error: 'Missing required "services:" key' };
  }
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;
    const singleQuotes = (line.match(/'/g) || []).length;
    const doubleQuotes = (line.match(/"/g) || []).length;
    if (singleQuotes % 2 !== 0) {
      return { valid: false, error: `Unbalanced single quotes on line ${i + 1}` };
    }
    if (doubleQuotes % 2 !== 0) {
      return { valid: false, error: `Unbalanced double quotes on line ${i + 1}` };
    }
  }
  return { valid: true };
}
function syncSkillsToProject(projectDir, sandstormCliDir) {
  try {
    const skillsSrc = path.join(sandstormCliDir, "skills");
    const skillsDest = path.join(projectDir, ".claude", "skills");
    if (!fs.existsSync(skillsSrc)) return;
    const srcFiles = fs.readdirSync(skillsSrc).filter((f) => f.startsWith("sandstorm-") && f.endsWith(".md"));
    if (srcFiles.length === 0) return;
    let needsSync = false;
    for (const file of srcFiles) {
      const destFile = path.join(skillsDest, file);
      if (!fs.existsSync(destFile)) {
        needsSync = true;
        break;
      }
      const srcStat = fs.statSync(path.join(skillsSrc, file));
      const destStat = fs.statSync(destFile);
      if (srcStat.mtimeMs > destStat.mtimeMs) {
        needsSync = true;
        break;
      }
    }
    if (!needsSync) return;
    fs.mkdirSync(skillsDest, { recursive: true });
    for (const file of srcFiles) {
      fs.copyFileSync(path.join(skillsSrc, file), path.join(skillsDest, file));
    }
  } catch {
  }
}
function autoDetectVerifyLines(directory) {
  const lines = [
    "#!/bin/bash",
    "#",
    "# Sandstorm verify script — commands run during the verification step.",
    "# Each command runs in sequence. If any fails, verification fails.",
    "#",
    "# Use 'sandstorm-exec <service> <command>' to run on service containers.",
    "# Edit this file to match your project's test/lint/build commands.",
    "#",
    "set -e",
    ""
  ];
  const pkgJsonPath = path.join(directory, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      const scripts = pkg.scripts || {};
      if (scripts.test) lines.push("npm test");
      if (scripts.typecheck) {
        lines.push("npm run typecheck");
      } else if (fs.existsSync(path.join(directory, "tsconfig.json"))) {
        lines.push("npx tsc --noEmit");
      }
      if (scripts.build) lines.push("npm run build");
    } catch {
    }
  }
  if (fs.existsSync(path.join(directory, "Gemfile"))) {
    if (fs.existsSync(path.join(directory, "bin", "rails"))) {
      lines.push("# sandstorm-exec api bash -c 'cd /rails && bin/rails test'");
    }
  }
  if (fs.existsSync(path.join(directory, "requirements.txt")) || fs.existsSync(path.join(directory, "pyproject.toml"))) {
    lines.push("# sandstorm-exec app pytest");
  }
  if (fs.existsSync(path.join(directory, "go.mod"))) {
    lines.push("# sandstorm-exec app go test ./...");
  }
  return lines;
}
function registerIpcHandlers(mainWindow2) {
  exports.stackManager.setOnStackUpdate(() => {
    mainWindow2?.webContents.send("stacks:updated");
  });
  electron.ipcMain.handle(
    "agent:send",
    (_event, tabId, message, projectDir) => {
      exports.agentBackend.sendMessage(tabId, message, projectDir);
    }
  );
  electron.ipcMain.handle("agent:cancel", (_event, tabId) => {
    exports.agentBackend.cancelSession(tabId);
  });
  electron.ipcMain.handle("agent:reset", (_event, tabId) => {
    exports.agentBackend.resetSession(tabId);
  });
  electron.ipcMain.handle("agent:history", (_event, tabId) => {
    return exports.agentBackend.getHistory(tabId);
  });
  electron.ipcMain.handle("projects:list", async () => {
    return exports.registry.listProjects();
  });
  electron.ipcMain.handle("projects:add", async (_event, directory) => {
    return exports.registry.addProject(directory);
  });
  electron.ipcMain.handle("projects:remove", async (_event, id) => {
    exports.registry.removeProject(id);
  });
  electron.ipcMain.handle("projects:browse", async (event) => {
    const win = electron.BrowserWindow.fromWebContents(event.sender);
    const result = await electron.dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      title: "Open Project Directory",
      defaultPath: electron.app.getPath("home")
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  electron.ipcMain.handle("projects:checkInit", async (_event, directory) => {
    try {
      const state = checkInitState(directory);
      if (state !== "uninitialized") {
        syncSkillsToProject(directory, exports.cliDir);
      }
      return { state };
    } catch {
      return { state: "uninitialized" };
    }
  });
  electron.ipcMain.handle("projects:initialize", async (_event, directory) => {
    const cliBin = path.join(exports.cliDir, "bin", "sandstorm");
    let cliError = "";
    try {
      const { exitCode, stderr, stdout } = await new Promise((resolve, reject) => {
        const errChunks = [];
        const outChunks = [];
        const env = { ...process.env };
        const extraPaths = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"];
        const currentPath = env.PATH || "";
        env.PATH = [...extraPaths, currentPath].join(":");
        env.SANDSTORM_APP_VERSION = StackManager.resolveAppVersion();
        const child = child_process.spawn("bash", [cliBin, "init", "-y"], {
          cwd: directory,
          env,
          stdio: ["ignore", "pipe", "pipe"]
        });
        child.stdout?.on("data", (chunk) => outChunks.push(chunk));
        child.stderr?.on("data", (chunk) => errChunks.push(chunk));
        child.on(
          "close",
          (code) => resolve({
            exitCode: code ?? 1,
            stderr: Buffer.concat(errChunks).toString(),
            stdout: Buffer.concat(outChunks).toString()
          })
        );
        child.on("error", reject);
      });
      if (exitCode === 0) return { success: true };
      cliError = stderr || stdout || `CLI init exited with code ${exitCode}`;
      console.error(`[init] CLI init failed (exit ${exitCode}): ${cliError}`);
    } catch (err) {
      cliError = err instanceof Error ? err.message : String(err);
      console.error("[init] CLI init error:", err);
    }
    const hasCompose = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].some((f) => fs.existsSync(path.join(directory, f)));
    if (hasCompose) {
      return {
        success: false,
        error: cliError || "CLI init failed for unknown reason. Is Docker running?"
      };
    }
    try {
      const sandstormDir = path.join(directory, ".sandstorm");
      fs.mkdirSync(path.join(sandstormDir, "stacks"), { recursive: true });
      const projectName = path.basename(directory).toLowerCase().replace(/[^a-z0-9]/g, "-");
      const configPath = path.join(sandstormDir, "config");
      fs.writeFileSync(
        configPath,
        [
          "# Sandstorm project configuration",
          `# Generated by Sandstorm Desktop (no project compose file found)`,
          "",
          `PROJECT_NAME=${projectName}`,
          "",
          "# No project compose file — Claude-only stacks",
          "COMPOSE_FILE=",
          "",
          "# No port mappings for project services",
          "PORT_MAP=",
          "",
          "PORT_OFFSET=10",
          ""
        ].join("\n")
      );
      const composePath = path.join(sandstormDir, "docker-compose.yml");
      fs.writeFileSync(
        composePath,
        [
          "# Sandstorm stack override — Claude workspace only.",
          "# This project has no docker-compose services of its own.",
          "#",
          "# Do not run standalone. Sandstorm chains it automatically.",
          "",
          "services:",
          "  claude:",
          `    image: sandstorm-${projectName}-claude`,
          "    build:",
          "      context: ${SANDSTORM_DIR}",
          "      dockerfile: docker/Dockerfile",
          "      args:",
          "        SANDSTORM_APP_VERSION: ${SANDSTORM_APP_VERSION:-unknown}",
          "    environment:",
          "      - GIT_USER_NAME",
          "      - GIT_USER_EMAIL",
          "      - SANDSTORM_PROJECT",
          "      - SANDSTORM_STACK_ID",
          "    volumes:",
          "      - ${SANDSTORM_WORKSPACE}:/app",
          "      - /var/run/docker.sock:/var/run/docker.sock",
          "    healthcheck:",
          '      test: ["CMD", "test", "-f", "/app/.sandstorm-ready"]',
          "      interval: 3s",
          "      timeout: 2s",
          "      retries: 60",
          "    tty: true",
          "    stdin_open: true",
          ""
        ].join("\n")
      );
      const verifyLines = autoDetectVerifyLines(directory);
      const verifyPath = path.join(sandstormDir, "verify.sh");
      fs.writeFileSync(verifyPath, verifyLines.join("\n") + "\n", { mode: 493 });
      saveSpecQualityGate(directory, getDefaultSpecQualityGate());
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to create .sandstorm config: ${msg}` };
    }
  });
  electron.ipcMain.handle("projects:checkMigration", async (_event, directory) => {
    try {
      const sandstormDir = path.join(directory, ".sandstorm");
      if (!fs.existsSync(path.join(sandstormDir, "config"))) {
        return { needsMigration: false };
      }
      const hasVerifyScript = fs.existsSync(path.join(sandstormDir, "verify.sh"));
      let hasServiceLabels = false;
      const composePath = path.join(sandstormDir, "docker-compose.yml");
      if (fs.existsSync(composePath)) {
        const content = fs.readFileSync(composePath, "utf-8");
        hasServiceLabels = content.includes("sandstorm.description");
      }
      let networksMigrated = false;
      try {
        networksMigrated = migrateNetworkOverrides(directory);
      } catch {
      }
      const missingSpecQualityGate = isSpecQualityGateMissing(directory);
      return {
        needsMigration: !hasVerifyScript || !hasServiceLabels || missingSpecQualityGate,
        missingVerifyScript: !hasVerifyScript,
        missingServiceLabels: !hasServiceLabels,
        missingSpecQualityGate,
        networksMigrated
      };
    } catch {
      return { needsMigration: false };
    }
  });
  electron.ipcMain.handle("projects:autoDetectVerify", async (_event, directory) => {
    try {
      const lines = autoDetectVerifyLines(directory);
      const serviceDescriptions = {};
      const composePath = path.join(directory, ".sandstorm", "docker-compose.yml");
      if (fs.existsSync(composePath)) {
        const content = fs.readFileSync(composePath, "utf-8");
        const serviceRegex = /^  (\w[\w-]*):\s*$/gm;
        let match;
        while ((match = serviceRegex.exec(content)) !== null) {
          const svcName = match[1];
          if (svcName !== "claude") {
            serviceDescriptions[svcName] = "Application service";
          }
        }
      }
      return {
        verifyScript: lines.join("\n") + "\n",
        serviceDescriptions
      };
    } catch (err) {
      return { verifyScript: "#!/bin/bash\nset -e\n", serviceDescriptions: {} };
    }
  });
  electron.ipcMain.handle(
    "projects:saveMigration",
    async (_event, directory, verifyScript, serviceDescriptions) => {
      try {
        const sandstormDir = path.join(directory, ".sandstorm");
        const verifyPath = path.join(sandstormDir, "verify.sh");
        fs.writeFileSync(verifyPath, verifyScript, { mode: 493 });
        ensureSpecQualityGate(directory);
        const composePath = path.join(sandstormDir, "docker-compose.yml");
        if (fs.existsSync(composePath) && Object.keys(serviceDescriptions).length > 0) {
          let content = fs.readFileSync(composePath, "utf-8");
          if (!content.includes("sandstorm.description")) {
            for (const [svcName, desc] of Object.entries(serviceDescriptions)) {
              const svcPattern = new RegExp(`(  ${svcName}:\\s*\\n)`, "g");
              if (svcPattern.test(content)) {
                const safeDesc = desc.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
                content = content.replace(
                  new RegExp(`(  ${svcName}:\\s*\\n)`),
                  `$1    labels:
      sandstorm.description: "${safeDesc}"
`
                );
              }
            }
            fs.writeFileSync(composePath, content);
          }
        }
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    }
  );
  electron.ipcMain.handle("projects:generateCompose", async (_event, directory) => {
    try {
      const configComposeFile = readComposeFileFromConfig(directory);
      const composeFile = findProjectComposeFile(directory, configComposeFile);
      if (!composeFile) {
        return {
          success: false,
          error: "This project requires a docker-compose.yml file. Sandstorm cannot manage stacks without one.",
          noProjectCompose: true
        };
      }
      const result = generateSandstormCompose(directory, composeFile);
      return {
        success: true,
        yaml: result.yaml,
        config: result.config,
        composeFile: result.analysis.composeFile,
        services: result.analysis.services.map((s) => ({
          name: s.name,
          description: s.description,
          ports: s.ports
        }))
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  });
  electron.ipcMain.handle(
    "projects:saveComposeSetup",
    async (_event, directory, composeYaml, composeFile) => {
      const validation = validateComposeYaml(composeYaml);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
      return saveComposeSetup(directory, composeYaml, true, composeFile);
    }
  );
  electron.ipcMain.handle("stacks:list", async () => {
    return exports.stackManager.listStacksWithServices();
  });
  electron.ipcMain.handle("stacks:get", async (_event, stackId) => {
    return exports.stackManager.getStackWithServices(stackId);
  });
  electron.ipcMain.handle("stacks:create", (_event, opts) => {
    return exports.stackManager.createStack(opts);
  });
  electron.ipcMain.handle("stacks:teardown", async (_event, stackId) => {
    await exports.stackManager.teardownStack(stackId);
  });
  electron.ipcMain.handle("stacks:stop", (_event, stackId) => {
    exports.stackManager.stopStack(stackId);
  });
  electron.ipcMain.handle("stacks:start", (_event, stackId) => {
    exports.stackManager.startStack(stackId);
  });
  electron.ipcMain.handle("stacks:history", async () => {
    return exports.stackManager.listStackHistory();
  });
  electron.ipcMain.handle(
    "tasks:dispatch",
    async (_event, stackId, prompt, model, opts) => {
      return exports.stackManager.dispatchTask(stackId, prompt, model, opts);
    }
  );
  electron.ipcMain.handle("tasks:list", async (_event, stackId) => {
    return exports.stackManager.getTasksForStack(stackId);
  });
  electron.ipcMain.handle("tasks:tokenSteps", async (_event, taskId) => {
    return exports.registry.getTaskTokenSteps(taskId);
  });
  electron.ipcMain.handle("tasks:workflowProgress", async (_event, stackId) => {
    return exports.stackManager.getWorkflowProgress(stackId);
  });
  electron.ipcMain.handle("diff:get", async (_event, stackId) => {
    return exports.stackManager.getDiff(stackId);
  });
  electron.ipcMain.handle(
    "push:execute",
    async (_event, stackId, message) => {
      await exports.stackManager.push(stackId, message);
    }
  );
  electron.ipcMain.handle(
    "stacks:setPr",
    (_event, stackId, prUrl, prNumber) => {
      exports.stackManager.setPullRequest(stackId, prUrl, prNumber);
    }
  );
  electron.ipcMain.handle("ports:get", async (_event, stackId) => {
    return exports.registry.getPorts(stackId);
  });
  electron.ipcMain.handle(
    "logs:stream",
    async (_event, containerId, runtime) => {
      const rt = runtime === "podman" ? exports.podmanRuntime : exports.dockerRuntime;
      const lines = [];
      for await (const line of rt.logs(containerId, { tail: 200 })) {
        lines.push(line);
      }
      return lines.join("");
    }
  );
  electron.ipcMain.handle("stats:stack-memory", async (_event, stackId) => {
    return exports.stackManager.getStackMemoryUsage(stackId);
  });
  electron.ipcMain.handle("stats:stack-detailed", async (_event, stackId) => {
    return exports.stackManager.getStackDetailedStats(stackId);
  });
  electron.ipcMain.handle("stats:task-metrics", async (_event, stackId) => {
    return exports.stackManager.getStackTaskMetrics(stackId);
  });
  electron.ipcMain.handle("stats:token-usage", async (_event, stackId) => {
    return exports.stackManager.getStackTokenUsage(stackId);
  });
  electron.ipcMain.handle("stats:global-token-usage", async () => {
    return exports.stackManager.getGlobalTokenUsage();
  });
  electron.ipcMain.handle("stats:rate-limit", async () => {
    return exports.stackManager.getRateLimitState();
  });
  electron.ipcMain.handle("stats:account-usage", async () => {
    return fetchAccountUsage();
  });
  electron.ipcMain.handle("stats:outer-claude-tokens", async () => {
    return exports.registry.listProjectTokenUsage();
  });
  electron.ipcMain.handle("context:get", async (_event, projectDir) => {
    return getCustomContext(projectDir);
  });
  electron.ipcMain.handle(
    "context:saveInstructions",
    async (_event, projectDir, content) => {
      saveCustomInstructions(projectDir, content);
    }
  );
  electron.ipcMain.handle("context:listSkills", async (_event, projectDir) => {
    return listCustomSkills(projectDir);
  });
  electron.ipcMain.handle(
    "context:getSkill",
    async (_event, projectDir, name) => {
      return getCustomSkill(projectDir, name);
    }
  );
  electron.ipcMain.handle(
    "context:saveSkill",
    async (_event, projectDir, name, content) => {
      saveCustomSkill(projectDir, name, content);
    }
  );
  electron.ipcMain.handle(
    "context:deleteSkill",
    async (_event, projectDir, name) => {
      deleteCustomSkill(projectDir, name);
    }
  );
  electron.ipcMain.handle("context:getSettings", async (_event, projectDir) => {
    return getCustomSettings(projectDir);
  });
  electron.ipcMain.handle(
    "context:saveSettings",
    async (_event, projectDir, content) => {
      saveCustomSettings(projectDir, content);
    }
  );
  electron.ipcMain.handle("specGate:get", async (_event, projectDir) => {
    return getSpecQualityGate(projectDir);
  });
  electron.ipcMain.handle(
    "specGate:save",
    async (_event, projectDir, content) => {
      saveSpecQualityGate(projectDir, content);
    }
  );
  electron.ipcMain.handle("specGate:getDefault", async () => {
    return getDefaultSpecQualityGate();
  });
  electron.ipcMain.handle("specGate:ensure", async (_event, projectDir) => {
    return ensureSpecQualityGate(projectDir);
  });
  electron.ipcMain.handle("stacks:detectStale", async () => {
    return exports.stackManager.detectStaleWorkspaces();
  });
  electron.ipcMain.handle("stacks:cleanupStale", async (_event, workspacePaths) => {
    return exports.stackManager.cleanupStaleWorkspaces(workspacePaths);
  });
  electron.ipcMain.handle("runtime:available", async () => {
    const [dockerAvail, podmanAvail] = await Promise.all([
      exports.dockerRuntime.isAvailable(),
      exports.podmanRuntime.isAvailable()
    ]);
    return { docker: dockerAvail, podman: podmanAvail };
  });
  electron.ipcMain.handle("modelSettings:getGlobal", () => {
    return exports.registry.getGlobalModelSettings();
  });
  electron.ipcMain.handle("modelSettings:setGlobal", (_event, settings) => {
    exports.registry.setGlobalModelSettings(settings);
  });
  electron.ipcMain.handle("modelSettings:getProject", (_event, projectDir) => {
    return exports.registry.getProjectModelSettings(projectDir);
  });
  electron.ipcMain.handle("modelSettings:setProject", (_event, projectDir, settings) => {
    exports.registry.setProjectModelSettings(projectDir, settings);
  });
  electron.ipcMain.handle("modelSettings:removeProject", (_event, projectDir) => {
    exports.registry.removeProjectModelSettings(projectDir);
  });
  electron.ipcMain.handle("modelSettings:getEffective", (_event, projectDir) => {
    return exports.registry.getEffectiveModels(projectDir);
  });
  electron.ipcMain.handle("session:getState", () => {
    return exports.sessionMonitor.getState();
  });
  electron.ipcMain.handle("session:getSettings", () => {
    return exports.registry.getSessionMonitorSettings();
  });
  electron.ipcMain.handle("session:updateSettings", (_event, settings) => {
    exports.registry.setSessionMonitorSettings(settings);
    exports.sessionMonitor.updateSettings(exports.registry.getSessionMonitorSettings());
  });
  electron.ipcMain.handle("session:acknowledgeCritical", () => {
    exports.sessionMonitor.acknowledgeCritical();
  });
  electron.ipcMain.handle("session:haltAll", () => {
    return exports.stackManager.sessionPauseAllStacks();
  });
  electron.ipcMain.handle("session:resumeAll", () => {
    exports.sessionMonitor.markResumed();
    return exports.stackManager.sessionResumeAllStacks();
  });
  electron.ipcMain.handle("session:resumeStack", (_event, stackId) => {
    exports.stackManager.sessionResumeStack(stackId);
  });
  electron.ipcMain.handle("session:forcePoll", async () => {
    return exports.sessionMonitor.forcePoll();
  });
  electron.ipcMain.on("session:activity", () => {
    exports.sessionMonitor.reportActivity();
  });
  electron.ipcMain.handle("docker:status", () => {
    return {
      connected: exports.dockerConnectionManager?.isConnected ?? false
    };
  });
  electron.ipcMain.handle("auth:status", async () => {
    return exports.agentBackend.getAuthStatus();
  });
  electron.ipcMain.handle("auth:login", async () => {
    const result = await exports.agentBackend.login(mainWindow2 ?? void 0);
    if (result.success) {
      const stacks = await exports.stackManager.listStacksWithServices();
      await exports.agentBackend.syncCredentials(stacks);
    }
    return result;
  });
}
let tray = null;
function createTray(mainWindow2) {
  const iconPath = path.join(__dirname, "../../resources/icon.png");
  let icon;
  try {
    icon = electron.nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    icon = electron.nativeImage.createEmpty();
  }
  tray = new electron.Tray(icon);
  tray.setToolTip("Sandstorm Desktop");
  const updateMenu = () => {
    const stacks = exports.registry.listStacks();
    const needsAttention = stacks.filter(
      (s) => s.status === "completed" || s.status === "failed"
    );
    const stackItems = stacks.map((s) => {
      const statusEmoji = s.status === "running" ? "🔵" : s.status === "completed" ? "🟢" : s.status === "failed" ? "🔴" : s.status === "up" || s.status === "idle" ? "🟡" : "⚫";
      return {
        label: `${statusEmoji} ${s.id} — ${s.status.toUpperCase()}`,
        click: () => {
          mainWindow2.show();
          mainWindow2.focus();
          mainWindow2.webContents.send("navigate:stack", s.id);
        }
      };
    });
    const menu = electron.Menu.buildFromTemplate([
      {
        label: `Sandstorm Desktop${needsAttention.length > 0 ? ` (${needsAttention.length} need review)` : ""}`,
        enabled: false
      },
      { type: "separator" },
      ...stackItems.length > 0 ? stackItems : [{ label: "No stacks running", enabled: false }],
      { type: "separator" },
      {
        label: "Show Dashboard",
        click: () => {
          mainWindow2.show();
          mainWindow2.focus();
        }
      },
      {
        label: "Quit",
        click: () => electron.app.quit()
      }
    ]);
    tray.setContextMenu(menu);
    if (needsAttention.length > 0) {
      tray.setToolTip(
        `Sandstorm Desktop — ${needsAttention.length} stack(s) need review`
      );
    } else {
      tray.setToolTip("Sandstorm Desktop");
    }
  };
  updateMenu();
  setInterval(updateMenu, 5e3);
  tray.on("click", () => {
    mainWindow2.show();
    mainWindow2.focus();
  });
}
const DEFAULT_SESSION_MONITOR_SETTINGS = {
  warningThreshold: 80,
  criticalThreshold: 90,
  autoHaltThreshold: 95,
  autoHaltEnabled: true,
  autoResumeAfterReset: false,
  pollIntervalMs: 12e4,
  idleTimeoutMs: 3e5,
  pollingDisabled: false
};
class SessionMonitor extends events.EventEmitter {
  settings;
  state;
  pollTimer = null;
  idleCheckTimer = null;
  previousLevel = "normal";
  previousPercent = 0;
  firedThresholds = /* @__PURE__ */ new Set();
  criticalAcknowledged = false;
  lastActivityAt = Date.now();
  started = false;
  /** Rate-limit backoff state (Mode C) */
  rateLimitBackoffStep = 0;
  static RATE_LIMIT_BACKOFFS = [5 * 6e4, 10 * 6e4, 20 * 6e4, 40 * 6e4];
  /** Generic error backoff state */
  errorBackoffStep = 0;
  static ERROR_BACKOFFS = [3e4, 6e4, 12e4, 3e5];
  /** Max consecutive failures before marking data as stale */
  static MAX_FAILURES_BEFORE_STALE = 3;
  /** Jitter range in ms (±10 seconds) */
  static JITTER_MS = 1e4;
  constructor(settings) {
    super();
    this.settings = { ...DEFAULT_SESSION_MONITOR_SETTINGS, ...settings };
    this.state = {
      usage: null,
      level: "normal",
      stale: false,
      halted: false,
      lastPollAt: null,
      consecutiveFailures: 0,
      pollMode: "normal",
      nextPollAt: null,
      idle: false,
      claudeAvailable: null
    };
  }
  getState() {
    return { ...this.state };
  }
  getSettings() {
    return { ...this.settings };
  }
  updateSettings(partial) {
    this.settings = { ...this.settings, ...partial };
    if (this.started) {
      this.scheduleNextPoll();
    }
  }
  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  start() {
    if (this.started) return;
    this.started = true;
    if (this.settings.pollingDisabled) return;
    this.idleCheckTimer = setInterval(() => this.checkIdleTransition(), 3e4);
    this.poll();
  }
  stop() {
    this.started = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }
  destroy() {
    this.stop();
    this.removeAllListeners();
  }
  // -------------------------------------------------------------------------
  // Activity tracking & idle gating
  // -------------------------------------------------------------------------
  /**
   * Report user activity from the renderer (mouse, keyboard, focus, etc.).
   * Resets the idle timer. If currently idle, triggers an immediate refresh.
   */
  reportActivity() {
    this.lastActivityAt = Date.now();
    if (this.state.idle) {
      this.state.idle = false;
      if (this.state.pollMode === "rate_limited") return;
      if (this.state.pollMode === "at_limit") return;
      this.emitStateChanged();
      this.poll();
    }
  }
  checkIdleTransition() {
    if (this.state.idle) return;
    if (this.settings.pollingDisabled) return;
    const elapsed = Date.now() - this.lastActivityAt;
    if (elapsed < this.settings.idleTimeoutMs) return;
    const lastPercent = this.state.usage?.session?.percent ?? 0;
    if (lastPercent >= this.settings.warningThreshold) return;
    this.state.idle = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.state.nextPollAt = null;
    this.emitStateChanged();
  }
  // -------------------------------------------------------------------------
  // Polling state machine
  // -------------------------------------------------------------------------
  async forcePoll() {
    if (this.state.pollMode === "rate_limited") {
      return this.getState();
    }
    await this.poll();
    return this.getState();
  }
  async poll() {
    if (this.settings.pollingDisabled) return;
    let snapshot = null;
    try {
      snapshot = await fetchAccountUsage();
    } catch {
    }
    if (!snapshot) {
      this.handlePollFailure("error");
      return;
    }
    if (this.state.claudeAvailable === null) {
      const available = await checkClaudeInstalled();
      this.state.claudeAvailable = available;
      if (!available) {
        this.emit("claude:missing");
      }
    }
    switch (snapshot.status) {
      case "rate_limited":
        this.handlePollFailure("rate_limited");
        return;
      case "auth_expired":
        this.handlePollFailure("error");
        return;
      case "parse_error":
        this.handlePollFailure("error");
        return;
      case "ok":
      case "at_limit":
        this.handlePollSuccess(snapshot);
        return;
    }
  }
  handlePollSuccess(snapshot) {
    this.rateLimitBackoffStep = 0;
    this.errorBackoffStep = 0;
    this.state.consecutiveFailures = 0;
    this.state.lastPollAt = (/* @__PURE__ */ new Date()).toISOString();
    const wasStale = this.state.stale;
    this.state.stale = false;
    this.state.usage = snapshot;
    const percent = snapshot.session?.percent ?? 0;
    if (this.previousPercent > 50 && percent < 10) {
      this.state.halted = false;
      this.firedThresholds.clear();
      this.criticalAcknowledged = false;
      this.emit("session:reset");
    }
    const level = this.computeLevel(percent);
    this.state.level = level;
    if (level !== this.previousLevel || wasStale) {
      if (level === "warning" && !this.firedThresholds.has("warning")) {
        this.firedThresholds.add("warning");
        this.emit("threshold:warning", snapshot);
      } else if (level === "critical" && !this.firedThresholds.has("critical")) {
        this.firedThresholds.add("critical");
        this.criticalAcknowledged = false;
        this.emit("threshold:critical", snapshot);
      } else if ((level === "limit" || level === "over_limit") && !this.firedThresholds.has("limit")) {
        this.firedThresholds.add("limit");
        if (this.settings.autoHaltEnabled && !this.state.halted) {
          this.state.halted = true;
          this.emit("halt:triggered");
        }
        this.emit("threshold:limit", snapshot);
      } else if (level === "normal" && this.previousLevel !== "normal") {
        this.firedThresholds.clear();
        this.criticalAcknowledged = false;
        this.emit("threshold:cleared");
      }
    }
    this.previousLevel = level;
    this.previousPercent = percent;
    if (percent >= this.settings.autoHaltThreshold) {
      this.state.pollMode = "at_limit";
    } else {
      this.state.pollMode = "normal";
    }
    this.emitStateChanged();
    this.scheduleNextPoll();
  }
  handlePollFailure(type) {
    this.state.consecutiveFailures++;
    if (this.state.consecutiveFailures >= SessionMonitor.MAX_FAILURES_BEFORE_STALE && !this.state.stale) {
      this.state.stale = true;
      this.emit("stale");
    }
    if (type === "rate_limited") {
      this.state.pollMode = "rate_limited";
    } else {
      this.state.pollMode = "error";
    }
    this.emitStateChanged();
    this.scheduleNextPoll();
  }
  scheduleNextPoll() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (!this.started || this.settings.pollingDisabled || this.state.idle) {
      this.state.nextPollAt = null;
      return;
    }
    const delay = this.computeNextDelay();
    if (delay === null) {
      this.state.nextPollAt = null;
      return;
    }
    this.state.nextPollAt = new Date(Date.now() + delay).toISOString();
    this.pollTimer = setTimeout(() => this.poll(), delay);
  }
  computeNextDelay() {
    switch (this.state.pollMode) {
      case "normal": {
        const jitter = Math.floor(Math.random() * SessionMonitor.JITTER_MS * 2) - SessionMonitor.JITTER_MS;
        return Math.max(1e3, this.settings.pollIntervalMs + jitter);
      }
      case "at_limit": {
        const resetsAt = this.state.usage?.session?.resetsAt;
        if (resetsAt) {
          const resetMs = this.parseResetTime(resetsAt);
          if (resetMs !== null) {
            const delay = resetMs - Date.now() + 3e4;
            return delay > 0 ? delay : 6e4;
          }
        }
        return 5 * 6e4;
      }
      case "rate_limited": {
        const step = Math.min(this.rateLimitBackoffStep, SessionMonitor.RATE_LIMIT_BACKOFFS.length - 1);
        this.rateLimitBackoffStep++;
        return SessionMonitor.RATE_LIMIT_BACKOFFS[step];
      }
      case "error": {
        const step = Math.min(this.errorBackoffStep, SessionMonitor.ERROR_BACKOFFS.length - 1);
        this.errorBackoffStep++;
        return SessionMonitor.ERROR_BACKOFFS[step];
      }
    }
  }
  /**
   * Parse the human-readable reset time string from Claude's /usage output.
   * Format examples: "6pm (America/New_York)", "Apr 10, 10am (America/New_York)"
   *
   * Returns epoch ms or null if unparseable.
   */
  parseResetTime(resetsAt) {
    try {
      const tzMatch = resetsAt.match(/\(([^)]+)\)/);
      if (!tzMatch) return null;
      const timeStr = resetsAt.replace(/\([^)]+\)/, "").trim();
      const simpleTime = timeStr.match(/^(\d{1,2})(am|pm)$/i);
      if (simpleTime) {
        let hour = parseInt(simpleTime[1], 10);
        const isPm = simpleTime[2].toLowerCase() === "pm";
        if (isPm && hour < 12) hour += 12;
        if (!isPm && hour === 12) hour = 0;
        const now = /* @__PURE__ */ new Date();
        const target = new Date(now);
        target.setHours(hour, 0, 0, 0);
        if (target.getTime() <= now.getTime()) {
          target.setDate(target.getDate() + 1);
        }
        return target.getTime();
      }
      const dateTime = timeStr.match(/^(\w+ \d+),?\s+(\d{1,2})(am|pm)$/i);
      if (dateTime) {
        const year = (/* @__PURE__ */ new Date()).getFullYear();
        let hour = parseInt(dateTime[2], 10);
        const isPm = dateTime[3].toLowerCase() === "pm";
        if (isPm && hour < 12) hour += 12;
        if (!isPm && hour === 12) hour = 0;
        const parsed = /* @__PURE__ */ new Date(`${dateTime[1]} ${year} ${hour}:00:00`);
        if (!isNaN(parsed.getTime())) return parsed.getTime();
      }
      return null;
    } catch {
      return null;
    }
  }
  // -------------------------------------------------------------------------
  // Threshold logic
  // -------------------------------------------------------------------------
  computeLevel(percent) {
    if (percent >= this.settings.autoHaltThreshold && percent > 100) return "over_limit";
    if (percent >= this.settings.autoHaltThreshold) return "limit";
    if (percent >= this.settings.criticalThreshold) return "critical";
    if (percent >= this.settings.warningThreshold) return "warning";
    return "normal";
  }
  acknowledgeCritical() {
    this.criticalAcknowledged = true;
  }
  markResumed() {
    this.state.halted = false;
    this.emitStateChanged();
  }
  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------
  emitStateChanged() {
    this.emit("state:changed", this.getState());
  }
}
if (process.env.REMOTE_DEBUGGING_PORT) {
  electron.app.commandLine.appendSwitch("remote-debugging-port", process.env.REMOTE_DEBUGGING_PORT);
}
let mainWindow = null;
exports.registry = void 0;
exports.stackManager = void 0;
exports.portAllocator = void 0;
exports.taskWatcher = void 0;
exports.dockerRuntime = void 0;
exports.podmanRuntime = void 0;
exports.cliDir = void 0;
exports.agentBackend = void 0;
exports.dockerConnectionManager = null;
exports.sessionMonitor = void 0;
function createWindow() {
  electron.nativeTheme.themeSource = "dark";
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";
  const win = new electron.BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: "Sandstorm Desktop",
    backgroundColor: "#0d1017",
    ...isMac ? { titleBarStyle: "hiddenInset" } : isWin ? { titleBarStyle: "hidden", titleBarOverlay: { color: "#151921", symbolColor: "#6b7394", height: 36 } } : {},
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.once("ready-to-show", () => {
    win.show();
  });
  if (process.env.NODE_ENV === "development") {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  win.on("closed", () => {
    mainWindow = null;
  });
  return win;
}
function resolveCliDir() {
  if (electron.app.isPackaged) {
    return path.join(process.resourcesPath, "sandstorm-cli");
  }
  return path.join(electron.app.getAppPath(), "sandstorm-cli");
}
async function initializeApp() {
  exports.dockerRuntime = new DockerRuntime();
  exports.podmanRuntime = new PodmanRuntime();
  exports.cliDir = resolveCliDir();
  exports.registry = await Registry.create();
  exports.registry.purgeOldHistory(14);
  for (const project of exports.registry.listProjects()) {
    exports.registry.cleanupLegacyStackJsonFiles(project.directory);
  }
  exports.portAllocator = new PortAllocator(exports.registry);
  exports.taskWatcher = new TaskWatcher(exports.registry, exports.dockerRuntime, exports.podmanRuntime);
  exports.stackManager = new StackManager(
    exports.registry,
    exports.portAllocator,
    exports.taskWatcher,
    exports.dockerRuntime,
    exports.podmanRuntime,
    exports.cliDir
  );
  if (exports.dockerRuntime instanceof DockerRuntime) {
    exports.dockerConnectionManager = exports.dockerRuntime.getConnectionManager();
  }
  exports.agentBackend = new ClaudeBackend(
    void 0,
    (projectDir) => exports.registry.getEffectiveModels(projectDir).outer_model
  );
  exports.agentBackend.setTokenUsageCallback?.((projectDir, inputTokens, outputTokens) => {
    exports.registry.addProjectTokenUsage(projectDir, inputTokens, outputTokens);
  });
  await exports.agentBackend.initialize();
  const monitorSettings = exports.registry.getSessionMonitorSettings();
  exports.sessionMonitor = new SessionMonitor(monitorSettings);
  exports.sessionMonitor.on("threshold:warning", (usage) => {
    mainWindow?.webContents.send("session:threshold", { level: "warning", usage });
  });
  exports.sessionMonitor.on("threshold:critical", (usage) => {
    mainWindow?.webContents.send("session:threshold", { level: "critical", usage });
  });
  exports.sessionMonitor.on("threshold:limit", (usage) => {
    mainWindow?.webContents.send("session:threshold", { level: "limit", usage });
  });
  exports.sessionMonitor.on("threshold:cleared", () => {
    mainWindow?.webContents.send("session:threshold", { level: "normal", usage: null });
  });
  exports.sessionMonitor.on("halt:triggered", () => {
    const paused = exports.stackManager.sessionPauseAllStacks();
    mainWindow?.webContents.send("session:halted", { pausedStacks: paused });
  });
  exports.sessionMonitor.on("session:reset", () => {
    const currentSettings = exports.registry.getSessionMonitorSettings();
    if (currentSettings.autoResumeAfterReset) {
      exports.stackManager.sessionResumeAllStacks();
    }
    mainWindow?.webContents.send("session:reset");
  });
  exports.sessionMonitor.on("state:changed", (state) => {
    mainWindow?.webContents.send("session:state", state);
  });
  exports.sessionMonitor.start();
  exports.taskWatcher.on("task:completed", ({ stackId, task }) => {
    mainWindow?.webContents.send("task:completed", { stackId, task });
    mainWindow?.webContents.send("stacks:updated");
  });
  exports.taskWatcher.on("task:failed", ({ stackId, task }) => {
    mainWindow?.webContents.send("task:failed", { stackId, task });
    mainWindow?.webContents.send("stacks:updated");
  });
  exports.taskWatcher.on("task:output", ({ stackId, data }) => {
    mainWindow?.webContents.send("task:output", { stackId, data });
  });
  exports.taskWatcher.on("task:workflow-progress", (progress) => {
    mainWindow?.webContents.send("task:workflow-progress", progress);
  });
  if (exports.dockerConnectionManager) {
    exports.dockerConnectionManager.on("connected", () => {
      mainWindow?.webContents.send("docker:connected");
    });
    exports.dockerConnectionManager.on("disconnected", () => {
      mainWindow?.webContents.send("docker:disconnected");
    });
  }
}
electron.app.whenReady().then(async () => {
  await initializeApp();
  mainWindow = createWindow();
  exports.agentBackend.setMainWindow(mainWindow);
  registerIpcHandlers(mainWindow);
  createTray(mainWindow);
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
electron.app.on("before-quit", () => {
  exports.sessionMonitor?.destroy();
  exports.agentBackend?.destroy();
  exports.stackManager?.destroy();
  exports.taskWatcher?.unwatchAll();
  if (exports.dockerRuntime instanceof DockerRuntime) {
    exports.dockerRuntime.destroy();
  }
  exports.registry?.close();
});
