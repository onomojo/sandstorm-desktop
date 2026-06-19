import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry } from '../../src/main/control-plane/registry';
import { TOUCHPOINTS, PRESETS, CLAUDE_MODELS, OPENCODE_MODELS, getAvailableModels } from '../../src/main/control-plane/routing';
import type { TouchpointId, PresetId } from '../../src/main/control-plane/routing';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-routing-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

describe('Model Routing', () => {
  let registry: Registry;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
  });

  // ==========================================================================
  // Contract: all touchpoints resolve for an unconfigured project
  // ==========================================================================
  describe('contract: unconfigured project resolves all touchpoints', () => {
    it('resolves all 7 touchpoints to {backend, model} for a fresh database', () => {
      expect(TOUCHPOINTS).toHaveLength(7);
      for (const t of TOUCHPOINTS) {
        const result = registry.getEffectiveRoutingFor('/proj/unconfigured', t);
        expect(result).toHaveProperty('backend');
        expect(result).toHaveProperty('model');
        expect(typeof result.backend).toBe('string');
        expect(typeof result.model).toBe('string');
        expect(result.backend.length).toBeGreaterThan(0);
        expect(result.model.length).toBeGreaterThan(0);
      }
    });

    it('getEffectiveRouting returns a map covering all touchpoints', () => {
      const map = registry.getEffectiveRouting('/proj/unconfigured');
      for (const t of TOUCHPOINTS) {
        expect(map[t]).toBeDefined();
        expect(map[t]).toHaveProperty('backend');
        expect(map[t]).toHaveProperty('model');
      }
    });
  });

  // ==========================================================================
  // Legacy equivalence: getEffectiveModels wraps new resolver
  // ==========================================================================
  describe('legacy equivalence', () => {
    it('getEffectiveModels matches legacy behavior on model_settings-only project', () => {
      const effective = registry.getEffectiveModels('/proj/legacy');
      expect(effective.inner_model).toBe('sonnet');
      expect(effective.outer_model).toBe('opus');
    });

    it('getEffectiveModels reflects model_settings project override', () => {
      registry.setProjectModelSettings('/proj/a', { inner_model: 'opus', outer_model: 'haiku' });
      const effective = registry.getEffectiveModels('/proj/a');
      expect(effective.inner_model).toBe('opus');
      expect(effective.outer_model).toBe('haiku');
    });

    it('getEffectiveModels resolves "global" sentinel via model_settings', () => {
      registry.setGlobalModelSettings({ inner_model: 'auto', outer_model: 'sonnet' });
      registry.setProjectModelSettings('/proj/a', { inner_model: 'global', outer_model: 'global' });
      const effective = registry.getEffectiveModels('/proj/a');
      expect(effective.inner_model).toBe('auto');
      expect(effective.outer_model).toBe('sonnet');
    });

    it('auto passthrough: auto model round-trips unchanged through getEffectiveModels', () => {
      registry.setGlobalModelSettings({ inner_model: 'auto', outer_model: 'auto' });
      const effective = registry.getEffectiveModels('/proj/auto');
      expect(effective.inner_model).toBe('auto');
      expect(effective.outer_model).toBe('auto');
    });
  });

  // ==========================================================================
  // Resolver precedence
  // ==========================================================================
  describe('resolver precedence', () => {
    it('layer 1: explicit project assignment wins over all else', () => {
      registry.setProjectRouting('/proj/a', {
        assignments: { execution: { backend: 'claude', model: 'haiku' } },
      });
      registry.setGlobalRouting({
        assignments: { execution: { backend: 'claude', model: 'sonnet' } },
      });
      const result = registry.getEffectiveRoutingFor('/proj/a', 'execution');
      expect(result.model).toBe('haiku');
    });

    it('layer 2: project preset applies when no explicit project assignment', () => {
      registry.setProjectRouting('/proj/a', { preset: 'budget' });
      const result = registry.getEffectiveRoutingFor('/proj/a', 'execution');
      expect(result).toEqual(PRESETS.budget.execution);
    });

    it('layer 3: global explicit assignment applies when no project routing', () => {
      registry.setGlobalRouting({
        assignments: { review: { backend: 'claude', model: 'sonnet' } },
      });
      const result = registry.getEffectiveRoutingFor('/proj/no-project', 'review');
      expect(result.model).toBe('sonnet');
    });

    it('layer 4: global preset applies when no project routing and no global explicit assignment', () => {
      registry.setGlobalRouting({ preset: 'max_quality' });
      const result = registry.getEffectiveRoutingFor('/proj/no-project', 'review');
      expect(result).toEqual(PRESETS.max_quality.review);
    });

    it('layer 5: legacy fallback from model_settings for outer touchpoints', () => {
      registry.setGlobalModelSettings({ outer_model: 'haiku' });
      const result = registry.getEffectiveRoutingFor('/proj/no-routing', 'outer');
      expect(result).toEqual({ backend: 'claude', provider: 'anthropic', model: 'haiku' });
    });

    it('layer 5: legacy fallback from model_settings for inner touchpoints', () => {
      registry.setGlobalModelSettings({ inner_model: 'opus' });
      const result = registry.getEffectiveRoutingFor('/proj/no-routing', 'execution');
      expect(result).toEqual({ backend: 'claude', provider: 'anthropic', model: 'opus' });
    });

    it('partial project assignment: unassigned touchpoints fall through to global', () => {
      registry.setProjectRouting('/proj/a', {
        assignments: { execution: { backend: 'claude', model: 'haiku' } },
      });
      registry.setGlobalRouting({ preset: 'max_quality' });
      expect(registry.getEffectiveRoutingFor('/proj/a', 'execution').model).toBe('haiku');
      expect(registry.getEffectiveRoutingFor('/proj/a', 'review')).toEqual(PRESETS.max_quality.review);
    });
  });

  // ==========================================================================
  // Presets
  // ==========================================================================
  describe('presets', () => {
    const presetIds: PresetId[] = ['max_quality', 'balanced', 'budget'];

    for (const presetId of presetIds) {
      it(`PRESETS.${presetId} covers all 7 touchpoints with valid assignments`, () => {
        const preset = PRESETS[presetId];
        for (const t of TOUCHPOINTS) {
          expect(preset[t]).toBeDefined();
          expect(preset[t].backend).toBeTruthy();
          expect(preset[t].model).toBeTruthy();
        }
      });

      it(`applyPreset('${presetId}') → getEffectiveRouting returns exact preset map`, () => {
        registry.applyPreset('/proj/a', presetId);
        const effective = registry.getEffectiveRouting('/proj/a');
        for (const t of TOUCHPOINTS) {
          expect(effective[t]).toEqual(PRESETS[presetId][t]);
        }
      });
    }

    it('applyPreset clears prior explicit assignments', () => {
      registry.setProjectRouting('/proj/a', {
        assignments: { execution: { backend: 'claude', model: 'haiku' } },
      });
      registry.applyPreset('/proj/a', 'max_quality');
      expect(registry.getEffectiveRoutingFor('/proj/a', 'execution')).toEqual(PRESETS.max_quality.execution);
    });
  });

  // ==========================================================================
  // Storage CRUD
  // ==========================================================================
  describe('storage CRUD', () => {
    it('getGlobalRouting returns empty config on fresh database', () => {
      const config = registry.getGlobalRouting();
      expect(config.assignments).toEqual({});
      expect(config.preset).toBeNull();
    });

    it('setGlobalRouting persists assignments and preset', () => {
      registry.setGlobalRouting({
        assignments: { outer: { backend: 'claude', model: 'opus' } },
        preset: 'balanced',
      });
      const config = registry.getGlobalRouting();
      expect(config.assignments.outer).toEqual({ backend: 'claude', model: 'opus' });
      expect(config.preset).toBe('balanced');
    });

    it('setGlobalRouting merges partial updates', () => {
      registry.setGlobalRouting({ preset: 'budget' });
      registry.setGlobalRouting({ assignments: { outer: { backend: 'claude', model: 'sonnet' } } });
      const config = registry.getGlobalRouting();
      expect(config.preset).toBe('budget');
      expect(config.assignments.outer?.model).toBe('sonnet');
    });

    it('getProjectRouting returns null when no row exists', () => {
      expect(registry.getProjectRouting('/proj/missing')).toBeNull();
    });

    it('setProjectRouting and getProjectRouting round-trip', () => {
      registry.setProjectRouting('/proj/a', {
        assignments: { execution: { backend: 'claude', model: 'haiku' } },
        preset: 'balanced',
      });
      const config = registry.getProjectRouting('/proj/a');
      expect(config).not.toBeNull();
      expect(config!.assignments.execution).toEqual({ backend: 'claude', model: 'haiku' });
      expect(config!.preset).toBe('balanced');
    });

    it('removeProjectRouting deletes the row', () => {
      registry.setProjectRouting('/proj/a', { preset: 'budget' });
      registry.removeProjectRouting('/proj/a');
      expect(registry.getProjectRouting('/proj/a')).toBeNull();
    });

    it('getStoredProviderKeys returns providers stored under a scope', () => {
      registry.setProviderSecretBundle('global', 'openai', { api_key: 'sk-test' });
      expect(registry.getStoredProviderKeys('global')).toEqual(['openai']);
    });

    it('different projects have independent routing', () => {
      registry.setProjectRouting('/proj/a', { preset: 'budget' });
      registry.setProjectRouting('/proj/b', { preset: 'max_quality' });
      expect(registry.getProjectRouting('/proj/a')!.preset).toBe('budget');
      expect(registry.getProjectRouting('/proj/b')!.preset).toBe('max_quality');
    });
  });

  // ==========================================================================
  // Malformed JSON resilience
  // ==========================================================================
  describe('malformed JSON resilience', () => {
    it('corrupted assignments JSON falls through the chain without throwing', () => {
      registry.setProjectRouting('/proj/a', { preset: 'balanced' });
      // Directly corrupt the row
      const db = registry.getDb();
      db.prepare("UPDATE model_routing SET assignments = 'NOT_JSON' WHERE key = 'project:/proj/a'").run();

      // Should not throw — falls back to preset since preset is still valid
      expect(() => registry.getEffectiveRoutingFor('/proj/a', 'execution')).not.toThrow();
      const result = registry.getEffectiveRoutingFor('/proj/a', 'execution');
      expect(result).toEqual(PRESETS.balanced.execution);
    });

    it('corrupted global assignments JSON falls through to legacy without throwing', () => {
      registry.setGlobalRouting({ assignments: { outer: { backend: 'claude', model: 'opus' } } });
      const db = registry.getDb();
      db.prepare("UPDATE model_routing SET assignments = '{bad}' WHERE key = 'global'").run();

      expect(() => registry.getEffectiveRoutingFor('/proj/x', 'outer')).not.toThrow();
    });
  });

  // ==========================================================================
  // auto passthrough
  // ==========================================================================
  describe('auto model passthrough', () => {
    it('auto model passes through getEffectiveRoutingFor unchanged', () => {
      registry.setProjectRouting('/proj/a', {
        assignments: { execution: { backend: 'claude', model: 'auto' } },
      });
      const result = registry.getEffectiveRoutingFor('/proj/a', 'execution');
      expect(result.model).toBe('auto');
    });

    it('auto in model_settings passes through legacy fallback', () => {
      registry.setGlobalModelSettings({ inner_model: 'auto' });
      const result = registry.getEffectiveRoutingFor('/proj/x', 'execution');
      expect(result.model).toBe('auto');
    });
  });

  // ==========================================================================
  // getContainerPhaseModels
  // ==========================================================================
  describe('getContainerPhaseModels', () => {
    it('returns assignments for execution, review, meta_review', () => {
      const result = registry.getContainerPhaseModels('/proj/a');
      expect(result).toHaveProperty('execution');
      expect(result).toHaveProperty('review');
      expect(result).toHaveProperty('meta_review');
    });

    it('reflects preset when applied', () => {
      registry.applyPreset('/proj/a', 'max_quality');
      const result = registry.getContainerPhaseModels('/proj/a');
      expect(result.execution).toEqual(PRESETS.max_quality.execution);
      expect(result.review).toEqual(PRESETS.max_quality.review);
      expect(result.meta_review).toEqual(PRESETS.max_quality.meta_review);
    });
  });

  // ==========================================================================
  // Unknown preset rejection
  // ==========================================================================
  describe('unknown preset rejection', () => {
    it('applyPreset throws on unknown preset id', () => {
      expect(() => registry.applyPreset('/proj/a', 'unknown_preset' as PresetId)).toThrow();
    });
  });

  // ==========================================================================
  // Legacy touchpoint mapping
  // ==========================================================================
  describe('legacy touchpoint mapping', () => {
    it('outer, refine, pr_description map to outer_model', () => {
      registry.setGlobalModelSettings({ inner_model: 'haiku', outer_model: 'opus' });
      const outerTouchpoints: TouchpointId[] = ['outer', 'refine', 'pr_description'];
      for (const t of outerTouchpoints) {
        const result = registry.getEffectiveRoutingFor('/proj/x', t);
        expect(result.model).toBe('opus');
      }
    });

    it('execution, review, meta_review, merge_conflict map to inner_model', () => {
      registry.setGlobalModelSettings({ inner_model: 'haiku', outer_model: 'opus' });
      const innerTouchpoints: TouchpointId[] = ['execution', 'review', 'meta_review', 'merge_conflict'];
      for (const t of innerTouchpoints) {
        const result = registry.getEffectiveRoutingFor('/proj/x', t);
        expect(result.model).toBe('haiku');
      }
    });
  });

  // ==========================================================================
  // OPENCODE_MODELS catalog
  // ==========================================================================
  describe('OPENCODE_MODELS catalog', () => {
    it('has exactly 2 entries', () => {
      expect(OPENCODE_MODELS).toHaveLength(2);
    });

    it('all entries have backend:opencode', () => {
      for (const m of OPENCODE_MODELS) {
        expect(m.backend).toBe('opencode');
      }
    });

    it('includes anthropic and amazon-bedrock providers (no ollama)', () => {
      const providers = OPENCODE_MODELS.map((m) => m.provider);
      expect(providers).toContain('anthropic');
      expect(providers).toContain('amazon-bedrock');
      expect(providers).not.toContain('ollama');
    });

    it('all entries have needsKey:true', () => {
      for (const m of OPENCODE_MODELS) {
        expect(m.needsKey).toBe(true);
      }
    });

    it('model and version use provider-prefixed format', () => {
      const anthropic = OPENCODE_MODELS.find((m) => m.provider === 'anthropic');
      expect(anthropic?.model).toBe('anthropic/claude-sonnet-4-6');
      expect(anthropic?.version).toBe('anthropic/claude-sonnet-4-6');

      const bedrock = OPENCODE_MODELS.find((m) => m.provider === 'amazon-bedrock');
      expect(bedrock?.model).toBe('amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0');
      expect(bedrock?.version).toBe('amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0');
    });
  });

  // ==========================================================================
  // getAvailableModels availability logic
  // ==========================================================================
  describe('getAvailableModels', () => {
    it('returns models from both backends', () => {
      const models = getAvailableModels('/proj/test', () => false);
      const backends = new Set(models.map((m) => m.backend));
      expect(backends.has('claude')).toBe(true);
      expect(backends.has('opencode')).toBe(true);
    });

    it('Claude entries are exactly 4 and all available:true', () => {
      const models = getAvailableModels('/proj/test', () => false);
      const cc = models.filter((m) => m.backend === 'claude');
      expect(cc).toHaveLength(CLAUDE_MODELS.length);
      expect(cc).toHaveLength(4);
      for (const m of cc) {
        expect(m.available).toBe(true);
      }
    });

    it('OpenCode entries are exactly 2 with no ollama', () => {
      const models = getAvailableModels('/proj/test', () => false);
      const oc = models.filter((m) => m.backend === 'opencode');
      expect(oc).toHaveLength(2);
      expect(oc.map((m) => m.provider)).not.toContain('ollama');
    });

    it('OpenCode models unavailable when no secrets configured', () => {
      const models = getAvailableModels('/proj/test', () => false);
      const oc = models.filter((m) => m.backend === 'opencode');
      for (const m of oc) {
        expect(m.available).toBe(false);
      }
    });

    it('OpenCode anthropic model available when project has anthropic provider secret', () => {
      const projectKey = `project:${path.resolve('/proj/test')}`;
      const models = getAvailableModels('/proj/test', (key, provider) => {
        return key === projectKey && provider === 'anthropic';
      });
      const oc = models.filter((m) => m.backend === 'opencode');
      const anthropicModel = oc.find((m) => m.provider === 'anthropic');
      const bedrockModel = oc.find((m) => m.provider === 'amazon-bedrock');
      expect(anthropicModel?.available).toBe(true);
      expect(bedrockModel?.available).toBe(false);
    });

    it('OpenCode amazon-bedrock model available when project has amazon-bedrock provider secret', () => {
      const projectKey = `project:${path.resolve('/proj/test')}`;
      const models = getAvailableModels('/proj/test', (key, provider) => {
        return key === projectKey && provider === 'amazon-bedrock';
      });
      const oc = models.filter((m) => m.backend === 'opencode');
      const anthropicModel = oc.find((m) => m.provider === 'anthropic');
      const bedrockModel = oc.find((m) => m.provider === 'amazon-bedrock');
      expect(anthropicModel?.available).toBe(false);
      expect(bedrockModel?.available).toBe(true);
    });

    it('OpenCode models available when global provider secret configured', () => {
      const models = getAvailableModels('/proj/test', (key, provider) => {
        return key === 'global' && provider === 'anthropic';
      });
      const oc = models.filter((m) => m.backend === 'opencode');
      const anthropicModel = oc.find((m) => m.provider === 'anthropic');
      expect(anthropicModel?.available).toBe(true);
    });

    it('all OpenCode models available when all provider secrets configured', () => {
      const models = getAvailableModels('/proj/test', () => true);
      const oc = models.filter((m) => m.backend === 'opencode');
      for (const m of oc) {
        expect(m.available).toBe(true);
      }
    });

    it('uses path.resolve for the project key', () => {
      const seenKeys: string[] = [];
      getAvailableModels('/proj/test', (key) => {
        seenKeys.push(key);
        return false;
      });
      const projectKeys = seenKeys.filter((k) => k.startsWith('project:'));
      expect(projectKeys.length).toBeGreaterThan(0);
      for (const k of projectKeys) {
        expect(k).toBe(`project:${path.resolve('/proj/test')}`);
      }
    });

    it('does not mutate OPENCODE_MODELS constant', () => {
      const originalAvailable = OPENCODE_MODELS.map((m) => m.available);
      getAvailableModels('/proj/test', () => true);
      OPENCODE_MODELS.forEach((m, i) => {
        expect(m.available).toBe(originalAvailable[i]);
      });
    });
  });

  // ==========================================================================
  // getEffectiveTouchpointDescriptor
  // ==========================================================================
  describe('getEffectiveTouchpointDescriptor', () => {
    it('returns backend, provider, model, and credentials for a claude touchpoint', () => {
      const desc = registry.getEffectiveTouchpointDescriptor('/proj/test', 'execution');
      expect(desc.backend).toBe('claude');
      expect(desc.provider).toBe('anthropic');
      expect(typeof desc.model).toBe('string');
      expect(desc.credentials).toBeNull(); // no secrets stored yet
    });

    it('returns credentials:null when no provider secret stored', () => {
      const desc = registry.getEffectiveTouchpointDescriptor('/proj/test', 'outer');
      expect(desc.credentials).toBeNull();
    });

    it('returns project-level credentials when stored', () => {
      const projectKey = `project:${path.resolve('/proj/creds')}`;
      registry.setProviderSecretBundle(projectKey, 'anthropic', { api_key: 'proj-sk-123' });
      const desc = registry.getEffectiveTouchpointDescriptor('/proj/creds', 'execution');
      expect(desc.credentials).toEqual({ api_key: 'proj-sk-123' });
    });

    it('falls back to global credentials when no project-level secret', () => {
      registry.setProviderSecretBundle('global', 'anthropic', { api_key: 'global-sk-456' });
      const desc = registry.getEffectiveTouchpointDescriptor('/proj/no-creds', 'execution');
      expect(desc.credentials).toEqual({ api_key: 'global-sk-456' });
    });

    it('project credentials take precedence over global', () => {
      const projectKey = `project:${path.resolve('/proj/precedence')}`;
      registry.setProviderSecretBundle('global', 'anthropic', { api_key: 'global-sk' });
      registry.setProviderSecretBundle(projectKey, 'anthropic', { api_key: 'project-sk' });
      const desc = registry.getEffectiveTouchpointDescriptor('/proj/precedence', 'execution');
      expect(desc.credentials).toEqual({ api_key: 'project-sk' });
    });

    it('all touchpoints resolve to a descriptor with required fields', () => {
      for (const touchpoint of TOUCHPOINTS) {
        const desc = registry.getEffectiveTouchpointDescriptor('/proj/all', touchpoint);
        expect(desc).toHaveProperty('backend');
        expect(desc).toHaveProperty('provider');
        expect(desc).toHaveProperty('model');
        expect(desc).toHaveProperty('credentials');
        expect(typeof desc.backend).toBe('string');
        expect(typeof desc.provider).toBe('string');
        expect(typeof desc.model).toBe('string');
      }
    });
  });
});
