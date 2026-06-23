import Database from 'better-sqlite3';
import path from 'path';
import {
  TOUCHPOINTS,
  PRESETS,
  type TouchpointId,
  type RoutingAssignment,
  type PresetId,
  type AgentBackendKind,
} from '../routing';
import type { ModelSettings, RoutingConfig } from '../registry';

export class RoutingConfigModule {
  constructor(
    private db: Database.Database,
    private modelSettings: { getGlobalModelSettings(): ModelSettings; getProjectModelSettings(dir: string): ModelSettings | null },
  ) {}

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

  getLegacyEffectiveModels(projectDir: string): ModelSettings {
    const global = this.modelSettings.getGlobalModelSettings();
    const project = this.modelSettings.getProjectModelSettings(projectDir);
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
      return { backend: 'claude', provider: 'anthropic', model: legacy.outer_model };
    }
    return { backend: 'claude', provider: 'anthropic', model: legacy.inner_model };
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

  getEffectiveModels(projectDir: string): ModelSettings {
    return {
      inner_model: this.getEffectiveRoutingFor(projectDir, 'execution').model,
      outer_model: this.getEffectiveRoutingFor(projectDir, 'outer').model,
    };
  }

  getEffectiveTouchpointDescriptor(
    projectDir: string,
    touchpoint: TouchpointId,
    getCredentials: (provider: string) => Record<string, string> | null,
  ): { backend: AgentBackendKind; provider: string; model: string; credentials: Record<string, string> | null } {
    const assignment = this.getEffectiveRoutingFor(projectDir, touchpoint);
    const credentials = getCredentials(assignment.provider);
    return {
      backend: assignment.backend,
      provider: assignment.provider,
      model: assignment.model,
      credentials,
    };
  }
}
