import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
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

export interface Project {
  id: number;
  name: string;
  directory: string;
  added_at: string;
}

export class Registry {
  private db: SqlJsDatabase;
  private dbPath: string;

  private constructor(db: SqlJsDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async create(dbPath?: string): Promise<Registry> {
    const resolvedPath =
      dbPath ?? path.join(app.getPath('userData'), 'sandstorm.db');

    const SQL = await initSqlJs();

    let db: SqlJsDatabase;
    if (fs.existsSync(resolvedPath)) {
      const fileBuffer = fs.readFileSync(resolvedPath);
      db = new SQL.Database(fileBuffer);
    } else {
      db = new SQL.Database();
    }

    db.exec('PRAGMA foreign_keys = ON;');

    const registry = new Registry(db, resolvedPath);
    registry.migrate();
    return registry;
  }

  private save(): void {
    const data = this.db.export();
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.dbPath, Buffer.from(data));
    // db.export() resets pragmas — re-enable foreign keys
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        directory   TEXT NOT NULL UNIQUE,
        added_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    this.db.run(`
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
    `);
    this.db.run(`
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
    // Add error column if missing (migration for existing databases)
    try {
      this.db.run('ALTER TABLE stacks ADD COLUMN error TEXT');
    } catch {
      // Column already exists
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS ports (
        stack_id       TEXT NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
        service        TEXT NOT NULL,
        host_port      INTEGER NOT NULL UNIQUE,
        container_port INTEGER NOT NULL,
        PRIMARY KEY (stack_id, service)
      );
    `);
    this.save();
  }

  /** Run a query and return all result rows as objects */
  private queryAll<T>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as (string | number | null | Uint8Array)[]);
    const rows: T[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return rows;
  }

  /** Run a query and return the first result row as an object, or undefined */
  private queryOne<T>(sql: string, params: unknown[] = []): T | undefined {
    const rows = this.queryAll<T>(sql, params);
    return rows.length > 0 ? rows[0] : undefined;
  }

  /** Execute a write statement (INSERT/UPDATE/DELETE) and save */
  private execute(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params as (string | number | null | Uint8Array)[]);
    this.save();
  }

  /** Execute a write statement and return last insert rowid */
  private executeInsert(sql: string, params: unknown[] = []): number {
    this.db.run(sql, params as (string | number | null | Uint8Array)[]);
    const result = this.queryOne<{ id: number }>('SELECT last_insert_rowid() as id');
    this.save();
    return result!.id;
  }

  // --- Projects ---

  addProject(directory: string, name?: string): Project {
    const projectName = name ?? path.basename(directory);
    const id = this.executeInsert(
      'INSERT INTO projects (name, directory) VALUES (?, ?)',
      [projectName, directory]
    );
    return this.queryOne<Project>('SELECT * FROM projects WHERE id = ?', [id])!;
  }

  listProjects(): Project[] {
    return this.queryAll<Project>('SELECT * FROM projects ORDER BY added_at ASC');
  }

  removeProject(id: number): void {
    this.execute('DELETE FROM projects WHERE id = ?', [id]);
  }

  getProject(id: number): Project | undefined {
    return this.queryOne<Project>('SELECT * FROM projects WHERE id = ?', [id]);
  }

  // --- Stacks ---

  createStack(stack: Omit<Stack, 'created_at' | 'updated_at' | 'error'>): Stack {
    this.execute(
      `INSERT INTO stacks (id, project, project_dir, ticket, branch, description, status, runtime)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [stack.id, stack.project, stack.project_dir, stack.ticket, stack.branch, stack.description, stack.status, stack.runtime]
    );
    return this.getStack(stack.id)!;
  }

  getStack(id: string): Stack | undefined {
    return this.queryOne<Stack>('SELECT * FROM stacks WHERE id = ?', [id]);
  }

  listStacks(): Stack[] {
    return this.queryAll<Stack>('SELECT * FROM stacks ORDER BY created_at DESC');
  }

  updateStackStatus(id: string, status: StackStatus, error?: string): void {
    if (error !== undefined) {
      this.execute(
        "UPDATE stacks SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?",
        [status, error, id]
      );
    } else {
      this.execute(
        "UPDATE stacks SET status = ?, updated_at = datetime('now') WHERE id = ?",
        [status, id]
      );
    }
  }

  deleteStack(id: string): void {
    this.execute('DELETE FROM stacks WHERE id = ?', [id]);
  }

  // --- Tasks ---

  createTask(stackId: string, prompt: string): Task {
    const id = this.executeInsert(
      "INSERT INTO tasks (stack_id, prompt, status) VALUES (?, ?, 'running')",
      [stackId, prompt]
    );
    this.updateStackStatus(stackId, 'running');
    return this.queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id])!;
  }

  completeTask(taskId: number, exitCode: number): void {
    const status = exitCode === 0 ? 'completed' : 'failed';
    this.execute(
      "UPDATE tasks SET status = ?, exit_code = ?, finished_at = datetime('now') WHERE id = ?",
      [status, exitCode, taskId]
    );

    const task = this.queryOne<{ stack_id: string }>(
      'SELECT stack_id FROM tasks WHERE id = ?',
      [taskId]
    );
    if (task) {
      this.updateStackStatus(
        task.stack_id,
        exitCode === 0 ? 'completed' : 'failed'
      );
    }
  }

  getTasksForStack(stackId: string): Task[] {
    return this.queryAll<Task>(
      'SELECT * FROM tasks WHERE stack_id = ? ORDER BY started_at DESC',
      [stackId]
    );
  }

  getRunningTask(stackId: string): Task | undefined {
    return this.queryOne<Task>(
      "SELECT * FROM tasks WHERE stack_id = ? AND status = 'running' LIMIT 1",
      [stackId]
    );
  }

  // --- Ports ---

  setPorts(stackId: string, ports: Omit<PortMapping, 'stack_id'>[]): void {
    this.db.run('BEGIN TRANSACTION');
    try {
      for (const p of ports) {
        this.db.run(
          'INSERT INTO ports (stack_id, service, host_port, container_port) VALUES (?, ?, ?, ?)',
          [stackId, p.service, p.host_port, p.container_port]
        );
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    this.save();
  }

  getPorts(stackId: string): PortMapping[] {
    return this.queryAll<PortMapping>(
      'SELECT * FROM ports WHERE stack_id = ? ORDER BY host_port ASC',
      [stackId]
    );
  }

  getAllAllocatedPorts(): number[] {
    return this.queryAll<{ host_port: number }>(
      'SELECT host_port FROM ports'
    ).map((r) => r.host_port);
  }

  releasePorts(stackId: string): void {
    this.execute('DELETE FROM ports WHERE stack_id = ?', [stackId]);
  }

  // --- Cleanup ---

  close(): void {
    try {
      this.save();
      this.db.close();
    } catch {
      // Already closed or error saving — ignore
    }
  }
}
