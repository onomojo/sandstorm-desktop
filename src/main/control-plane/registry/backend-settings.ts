import Database from 'better-sqlite3';
import path from 'path';
import { resolveEffectiveBackend } from '../backend-resolution';
import type { GlobalBackendInput, ProjectBackendInput, EffectiveBackend, BackendType } from '../backend-resolution';
import type { BackendSettings } from '../registry';

export class BackendSettingsModule {
  constructor(private db: Database.Database) {}

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
}
