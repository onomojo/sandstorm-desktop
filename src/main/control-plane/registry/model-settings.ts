import Database from 'better-sqlite3';
import path from 'path';
import type { ModelSettings } from '../registry';

export class ModelSettingsModule {
  constructor(private db: Database.Database) {}

  getGlobalModelSettings(): ModelSettings {
    const row = this.db.prepare(
      "SELECT inner_model, outer_model FROM model_settings WHERE key = 'global'"
    ).get() as ModelSettings | undefined;
    return row ?? { inner_model: 'sonnet', outer_model: 'opus' };
  }

  setGlobalModelSettings(settings: Partial<ModelSettings>): void {
    const current = this.getGlobalModelSettings();
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
}
