import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';

export interface Stack {
  id: string;
  project: string;
  project_dir: string;
  ticket: string | null;
  branch: string | null;
  description: string | null;
  status: StackStatus;
  runtime: 'docker' | 'podman';
  created_at: string;
  updated_at: string;
}

export type StackStatus =
  | 'building'
  | 'up'
  | 'running'
  | 'completed'
  | 'failed'
  | 'idle'
  | 'stopped';

export interface Task {
  id: number;
  stack_id: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed';
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
}

export interface PortMapping {
  stack_id: string;
  service: string;
  host_port: number;
  container_port: number;
}

export class Registry {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath =
      dbPath ?? path.join(app.getPath('userData'), 'sandstorm.db');
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stacks (
        id          TEXT PRIMARY KEY,
        project     TEXT NOT NULL,
        project_dir TEXT NOT NULL,
        ticket      TEXT,
        branch      TEXT,
        description TEXT,
        status      TEXT NOT NULL DEFAULT 'building',
        runtime     TEXT NOT NULL DEFAULT 'docker',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        stack_id    TEXT NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
        prompt      TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'running',
        exit_code   INTEGER,
        started_at  TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS ports (
        stack_id       TEXT NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
        service        TEXT NOT NULL,
        host_port      INTEGER NOT NULL UNIQUE,
        container_port INTEGER NOT NULL,
        PRIMARY KEY (stack_id, service)
      );
    `);
  }

  // --- Stacks ---

  createStack(stack: Omit<Stack, 'created_at' | 'updated_at'>): Stack {
    const stmt = this.db.prepare(`
      INSERT INTO stacks (id, project, project_dir, ticket, branch, description, status, runtime)
      VALUES (@id, @project, @project_dir, @ticket, @branch, @description, @status, @runtime)
    `);
    stmt.run(stack);
    return this.getStack(stack.id)!;
  }

  getStack(id: string): Stack | undefined {
    return this.db
      .prepare('SELECT * FROM stacks WHERE id = ?')
      .get(id) as Stack | undefined;
  }

  listStacks(): Stack[] {
    return this.db
      .prepare('SELECT * FROM stacks ORDER BY created_at DESC')
      .all() as Stack[];
  }

  updateStackStatus(id: string, status: StackStatus): void {
    this.db
      .prepare(
        "UPDATE stacks SET status = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(status, id);
  }

  deleteStack(id: string): void {
    this.db.prepare('DELETE FROM stacks WHERE id = ?').run(id);
  }

  // --- Tasks ---

  createTask(stackId: string, prompt: string): Task {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (stack_id, prompt, status) VALUES (?, ?, 'running')
    `);
    const result = stmt.run(stackId, prompt);
    this.updateStackStatus(stackId, 'running');
    return this.db
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(result.lastInsertRowid) as Task;
  }

  completeTask(taskId: number, exitCode: number): void {
    const status = exitCode === 0 ? 'completed' : 'failed';
    this.db
      .prepare(
        "UPDATE tasks SET status = ?, exit_code = ?, finished_at = datetime('now') WHERE id = ?"
      )
      .run(status, exitCode, taskId);

    const task = this.db
      .prepare('SELECT stack_id FROM tasks WHERE id = ?')
      .get(taskId) as { stack_id: string } | undefined;
    if (task) {
      this.updateStackStatus(
        task.stack_id,
        exitCode === 0 ? 'completed' : 'failed'
      );
    }
  }

  getTasksForStack(stackId: string): Task[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE stack_id = ? ORDER BY started_at DESC')
      .all(stackId) as Task[];
  }

  getRunningTask(stackId: string): Task | undefined {
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE stack_id = ? AND status = 'running' LIMIT 1"
      )
      .get(stackId) as Task | undefined;
  }

  // --- Ports ---

  setPorts(stackId: string, ports: Omit<PortMapping, 'stack_id'>[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO ports (stack_id, service, host_port, container_port)
      VALUES (?, ?, ?, ?)
    `);
    const insertMany = this.db.transaction(
      (items: Omit<PortMapping, 'stack_id'>[]) => {
        for (const p of items) {
          stmt.run(stackId, p.service, p.host_port, p.container_port);
        }
      }
    );
    insertMany(ports);
  }

  getPorts(stackId: string): PortMapping[] {
    return this.db
      .prepare('SELECT * FROM ports WHERE stack_id = ? ORDER BY host_port ASC')
      .all(stackId) as PortMapping[];
  }

  getAllAllocatedPorts(): number[] {
    return (
      this.db.prepare('SELECT host_port FROM ports').all() as {
        host_port: number;
      }[]
    ).map((r) => r.host_port);
  }

  releasePorts(stackId: string): void {
    this.db.prepare('DELETE FROM ports WHERE stack_id = ?').run(stackId);
  }

  // --- Cleanup ---

  close(): void {
    this.db.close();
  }
}
