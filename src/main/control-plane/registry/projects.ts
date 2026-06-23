import Database from 'better-sqlite3';
import path from 'path';
import type { Project } from '../registry';

export class ProjectsModule {
  constructor(private db: Database.Database) {}

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
}
