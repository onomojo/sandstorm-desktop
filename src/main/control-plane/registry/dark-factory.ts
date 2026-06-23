import Database from 'better-sqlite3';
import path from 'path';

export class DarkFactoryModule {
  constructor(private db: Database.Database) {}

  getDarkFactoryEnabled(projectDir: string): boolean {
    const key = `project:${path.resolve(projectDir)}`;
    const row = this.db.prepare('SELECT level FROM project_dark_factory WHERE key = ?').get(key) as { level: string } | undefined;
    return row ? row.level === 'dark_factory' : false;
  }

  setDarkFactoryEnabled(projectDir: string, enabled: boolean): void {
    const key = `project:${path.resolve(projectDir)}`;
    if (enabled) {
      this.db.prepare(
        `INSERT INTO project_dark_factory (key, enabled, level, merge_strategy) VALUES (?, 1, 'dark_factory', 'squash')
         ON CONFLICT(key) DO UPDATE SET enabled = 1, level = 'dark_factory'`
      ).run(key);
    } else {
      const current = this.db.prepare('SELECT level FROM project_dark_factory WHERE key = ?').get(key) as { level: string } | undefined;
      if (!current) {
        this.db.prepare(
          `INSERT INTO project_dark_factory (key, enabled, level, merge_strategy) VALUES (?, 0, 'manual', 'squash')`
        ).run(key);
      } else if (current.level === 'dark_factory') {
        this.db.prepare(`UPDATE project_dark_factory SET enabled = 0, level = 'manual' WHERE key = ?`).run(key);
      }
    }
  }

  getDarkFactoryConfig(projectDir: string): { level: string; merge_strategy: string } {
    const key = `project:${path.resolve(projectDir)}`;
    const row = this.db.prepare('SELECT level, merge_strategy FROM project_dark_factory WHERE key = ?').get(key) as { level: string; merge_strategy: string } | undefined;
    return row ? { level: row.level, merge_strategy: row.merge_strategy } : { level: 'manual', merge_strategy: 'squash' };
  }

  setDarkFactoryConfig(projectDir: string, config: { level: string; merge_strategy: string }): void {
    const key = `project:${path.resolve(projectDir)}`;
    const enabled = config.level === 'dark_factory' ? 1 : 0;
    this.db.prepare(
      `INSERT INTO project_dark_factory (key, enabled, level, merge_strategy) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, level = excluded.level, merge_strategy = excluded.merge_strategy`
    ).run(key, enabled, config.level, config.merge_strategy);
  }
}
