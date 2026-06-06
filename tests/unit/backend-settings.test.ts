import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry } from '../../src/main/control-plane/registry';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-backend-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

describe('Backend Settings', () => {
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

  describe('v21 migration', () => {
    it('inner_backend and outer_backend columns exist on model_settings with default "claude"', () => {
      const settings = registry.getGlobalBackendSettings();
      expect(settings.inner_backend).toBe('claude');
      expect(settings.outer_backend).toBe('claude');
    });

    it('opencode_settings table exists and is initially empty', () => {
      const settings = registry.getGlobalBackendSettings();
      expect(settings.inner_provider).toBeNull();
      expect(settings.inner_model).toBeNull();
      expect(settings.outer_provider).toBeNull();
      expect(settings.outer_model).toBeNull();
    });

    it('backend_secrets table exists and hasBackendSecret returns false initially', () => {
      expect(registry.hasBackendSecret('global', 'inner')).toBe(false);
      expect(registry.hasBackendSecret('global', 'outer')).toBe(false);
    });
  });

  describe('global backend settings', () => {
    it('returns defaults on fresh database', () => {
      const settings = registry.getGlobalBackendSettings();
      expect(settings.inner_backend).toBe('claude');
      expect(settings.outer_backend).toBe('claude');
      expect(settings.inner_provider).toBeNull();
      expect(settings.inner_model).toBeNull();
      expect(settings.outer_provider).toBeNull();
      expect(settings.outer_model).toBeNull();
    });

    it('updates inner backend', () => {
      registry.setGlobalBackendSettings({ inner_backend: 'opencode' });
      const settings = registry.getGlobalBackendSettings();
      expect(settings.inner_backend).toBe('opencode');
      expect(settings.outer_backend).toBe('claude');
    });

    it('updates outer backend', () => {
      registry.setGlobalBackendSettings({ outer_backend: 'opencode' });
      const settings = registry.getGlobalBackendSettings();
      expect(settings.inner_backend).toBe('claude');
      expect(settings.outer_backend).toBe('opencode');
    });

    it('sets provider and model for inner surface', () => {
      registry.setGlobalBackendSettings({
        inner_backend: 'opencode',
        inner_provider: 'anthropic',
        inner_model: 'claude-3-5-sonnet',
      });
      const settings = registry.getGlobalBackendSettings();
      expect(settings.inner_provider).toBe('anthropic');
      expect(settings.inner_model).toBe('claude-3-5-sonnet');
      expect(settings.outer_provider).toBeNull();
    });

    it('partial update preserves other fields', () => {
      registry.setGlobalBackendSettings({
        inner_backend: 'opencode',
        inner_provider: 'anthropic',
        inner_model: 'claude-3-5-sonnet',
        outer_backend: 'opencode',
        outer_provider: 'openai',
        outer_model: 'gpt-4o',
      });
      registry.setGlobalBackendSettings({ inner_backend: 'claude' });
      const settings = registry.getGlobalBackendSettings();
      expect(settings.inner_backend).toBe('claude');
      expect(settings.outer_backend).toBe('opencode');
      expect(settings.outer_provider).toBe('openai');
      expect(settings.outer_model).toBe('gpt-4o');
    });

    it('does not disturb existing model settings (inner_model/outer_model)', () => {
      registry.setGlobalModelSettings({ inner_model: 'opus', outer_model: 'sonnet' });
      registry.setGlobalBackendSettings({ inner_backend: 'opencode' });
      const models = registry.getGlobalModelSettings();
      expect(models.inner_model).toBe('opus');
      expect(models.outer_model).toBe('sonnet');
    });
  });

  describe('project backend settings', () => {
    it('returns null when no project override is set', () => {
      expect(registry.getProjectBackendSettings('/proj/a')).toBeNull();
    });

    it('sets and retrieves project-specific backend', () => {
      registry.setProjectBackendSettings('/proj/a', { inner_backend: 'opencode', outer_backend: 'claude' });
      const settings = registry.getProjectBackendSettings('/proj/a');
      expect(settings).not.toBeNull();
      expect(settings!.inner_backend).toBe('opencode');
      expect(settings!.outer_backend).toBe('claude');
    });

    it('uses "global" as default when partially setting project backends', () => {
      registry.setProjectBackendSettings('/proj/b', { inner_backend: 'opencode' });
      const settings = registry.getProjectBackendSettings('/proj/b');
      expect(settings!.inner_backend).toBe('opencode');
      expect(settings!.outer_backend).toBe('global');
    });

    it('sets and retrieves provider/model for project', () => {
      registry.setProjectBackendSettings('/proj/a', {
        inner_backend: 'opencode',
        inner_provider: 'openai',
        inner_model: 'gpt-4o',
      });
      const settings = registry.getProjectBackendSettings('/proj/a');
      expect(settings!.inner_provider).toBe('openai');
      expect(settings!.inner_model).toBe('gpt-4o');
    });

    it('different projects have independent settings', () => {
      registry.setProjectBackendSettings('/proj/a', { inner_backend: 'opencode' });
      registry.setProjectBackendSettings('/proj/b', { outer_backend: 'opencode' });
      expect(registry.getProjectBackendSettings('/proj/a')!.inner_backend).toBe('opencode');
      expect(registry.getProjectBackendSettings('/proj/b')!.outer_backend).toBe('opencode');
    });

    it('does not clobber model settings when setting backend settings', () => {
      registry.setProjectModelSettings('/proj/a', { inner_model: 'opus', outer_model: 'sonnet' });
      registry.setProjectBackendSettings('/proj/a', { inner_backend: 'opencode' });
      const models = registry.getProjectModelSettings('/proj/a');
      expect(models!.inner_model).toBe('opus');
      expect(models!.outer_model).toBe('sonnet');
    });

    it('does not clobber backend settings when setting model settings', () => {
      registry.setProjectBackendSettings('/proj/a', { inner_backend: 'opencode' });
      registry.setProjectModelSettings('/proj/a', { inner_model: 'opus' });
      const backend = registry.getProjectBackendSettings('/proj/a');
      expect(backend!.inner_backend).toBe('opencode');
    });
  });

  describe('getEffectiveBackend inheritance', () => {
    it('falls back to global when no project override', () => {
      registry.setGlobalBackendSettings({ inner_backend: 'opencode', inner_provider: 'anthropic', inner_model: 'claude-3-5-sonnet' });
      const effective = registry.getEffectiveBackend('/proj/a', 'inner');
      expect(effective.backend).toBe('opencode');
      expect(effective.provider).toBe('anthropic');
      expect(effective.model).toBe('claude-3-5-sonnet');
    });

    it('uses project override when set to concrete backend', () => {
      registry.setGlobalBackendSettings({ inner_backend: 'claude' });
      registry.setProjectBackendSettings('/proj/a', { inner_backend: 'opencode' });
      const effective = registry.getEffectiveBackend('/proj/a', 'inner');
      expect(effective.backend).toBe('opencode');
    });

    it('resolves "global" backend sentinel to global value', () => {
      registry.setGlobalBackendSettings({ outer_backend: 'opencode' });
      registry.setProjectBackendSettings('/proj/a', { outer_backend: 'global' });
      const effective = registry.getEffectiveBackend('/proj/a', 'outer');
      expect(effective.backend).toBe('opencode');
    });

    it('resolves null project provider to global provider', () => {
      registry.setGlobalBackendSettings({ inner_provider: 'anthropic', inner_model: 'sonnet' });
      registry.setProjectBackendSettings('/proj/a', { inner_backend: 'opencode' });
      const effective = registry.getEffectiveBackend('/proj/a', 'inner');
      expect(effective.provider).toBe('anthropic');
      expect(effective.model).toBe('sonnet');
    });

    it('returns correct surface (outer vs inner are independent)', () => {
      registry.setGlobalBackendSettings({ inner_backend: 'opencode', outer_backend: 'claude' });
      expect(registry.getEffectiveBackend('/proj/a', 'inner').backend).toBe('opencode');
      expect(registry.getEffectiveBackend('/proj/a', 'outer').backend).toBe('claude');
    });
  });

  describe('backend secrets', () => {
    it('hasBackendSecret returns false before any secret is set', () => {
      expect(registry.hasBackendSecret('global', 'inner')).toBe(false);
    });

    it('round-trip: set secret, hasBackendSecret returns true, getBackendSecret returns value', () => {
      registry.setBackendSecret('global', 'inner', 'api_key', 'sk-test-123');
      expect(registry.hasBackendSecret('global', 'inner')).toBe(true);
      expect(registry.getBackendSecret('global', 'inner')).toBe('sk-test-123');
    });

    it('different key/surface pairs are independent', () => {
      registry.setBackendSecret('global', 'inner', 'api_key', 'inner-secret');
      expect(registry.hasBackendSecret('global', 'outer')).toBe(false);
      expect(registry.getBackendSecret('global', 'outer')).toBeNull();
    });

    it('overwrites existing secret', () => {
      registry.setBackendSecret('global', 'inner', 'api_key', 'old-key');
      registry.setBackendSecret('global', 'inner', 'api_key', 'new-key');
      expect(registry.getBackendSecret('global', 'inner')).toBe('new-key');
    });

    it('getBackendSecret returns null when secret does not exist', () => {
      expect(registry.getBackendSecret('global', 'inner')).toBeNull();
    });

    it('project key secrets are independent of global', () => {
      const projectKey = `project:${path.resolve('/proj/a')}`;
      registry.setBackendSecret(projectKey, 'inner', 'api_key', 'proj-secret');
      expect(registry.hasBackendSecret('global', 'inner')).toBe(false);
      expect(registry.getBackendSecret(projectKey, 'inner')).toBe('proj-secret');
    });
  });
});
