import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry } from '../../src/main/control-plane/registry';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-model-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

describe('Model Settings', () => {
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

  describe('global defaults', () => {
    it('returns hardcoded defaults on fresh database', () => {
      const settings = registry.getGlobalModelSettings();
      expect(settings.inner_model).toBe('sonnet');
      expect(settings.outer_model).toBe('opus');
    });

    it('updates inner model', () => {
      registry.setGlobalModelSettings({ inner_model: 'opus' });
      const settings = registry.getGlobalModelSettings();
      expect(settings.inner_model).toBe('opus');
      expect(settings.outer_model).toBe('opus'); // unchanged
    });

    it('updates outer model', () => {
      registry.setGlobalModelSettings({ outer_model: 'sonnet' });
      const settings = registry.getGlobalModelSettings();
      expect(settings.inner_model).toBe('sonnet'); // unchanged
      expect(settings.outer_model).toBe('sonnet');
    });

    it('updates both models at once', () => {
      registry.setGlobalModelSettings({ inner_model: 'auto', outer_model: 'sonnet' });
      const settings = registry.getGlobalModelSettings();
      expect(settings.inner_model).toBe('auto');
      expect(settings.outer_model).toBe('sonnet');
    });
  });

  describe('per-project overrides', () => {
    it('returns null when no project override is set', () => {
      const settings = registry.getProjectModelSettings('/proj/a');
      expect(settings).toBeNull();
    });

    it('sets and retrieves project-specific settings', () => {
      registry.setProjectModelSettings('/proj/a', { inner_model: 'opus', outer_model: 'sonnet' });
      const settings = registry.getProjectModelSettings('/proj/a');
      expect(settings).not.toBeNull();
      expect(settings!.inner_model).toBe('opus');
      expect(settings!.outer_model).toBe('sonnet');
    });

    it('uses "global" as default when partially setting project models', () => {
      registry.setProjectModelSettings('/proj/b', { inner_model: 'opus' });
      const settings = registry.getProjectModelSettings('/proj/b');
      expect(settings!.inner_model).toBe('opus');
      expect(settings!.outer_model).toBe('global');
    });

    it('removes project settings', () => {
      registry.setProjectModelSettings('/proj/a', { inner_model: 'opus', outer_model: 'sonnet' });
      registry.removeProjectModelSettings('/proj/a');
      expect(registry.getProjectModelSettings('/proj/a')).toBeNull();
    });

    it('different projects have independent settings', () => {
      registry.setProjectModelSettings('/proj/a', { inner_model: 'opus', outer_model: 'global' });
      registry.setProjectModelSettings('/proj/b', { inner_model: 'auto', outer_model: 'sonnet' });

      const a = registry.getProjectModelSettings('/proj/a');
      const b = registry.getProjectModelSettings('/proj/b');
      expect(a!.inner_model).toBe('opus');
      expect(b!.inner_model).toBe('auto');
    });
  });

  describe('effective model resolution', () => {
    it('falls back to global defaults when no project override', () => {
      const effective = registry.getEffectiveModels('/proj/a');
      expect(effective.inner_model).toBe('sonnet');
      expect(effective.outer_model).toBe('opus');
    });

    it('uses project override when set', () => {
      registry.setProjectModelSettings('/proj/a', { inner_model: 'opus', outer_model: 'sonnet' });
      const effective = registry.getEffectiveModels('/proj/a');
      expect(effective.inner_model).toBe('opus');
      expect(effective.outer_model).toBe('sonnet');
    });

    it('resolves "global" to the current global default', () => {
      registry.setGlobalModelSettings({ inner_model: 'auto', outer_model: 'sonnet' });
      registry.setProjectModelSettings('/proj/a', { inner_model: 'global', outer_model: 'global' });

      const effective = registry.getEffectiveModels('/proj/a');
      expect(effective.inner_model).toBe('auto');
      expect(effective.outer_model).toBe('sonnet');
    });

    it('mixes project and global settings', () => {
      registry.setGlobalModelSettings({ inner_model: 'sonnet', outer_model: 'opus' });
      registry.setProjectModelSettings('/proj/a', { inner_model: 'opus', outer_model: 'global' });

      const effective = registry.getEffectiveModels('/proj/a');
      expect(effective.inner_model).toBe('opus');
      expect(effective.outer_model).toBe('opus'); // falls through to global
    });

    it('reflects global changes when project uses "global"', () => {
      registry.setProjectModelSettings('/proj/a', { inner_model: 'global', outer_model: 'global' });

      // Change global settings after project is set
      registry.setGlobalModelSettings({ inner_model: 'opus', outer_model: 'sonnet' });

      const effective = registry.getEffectiveModels('/proj/a');
      expect(effective.inner_model).toBe('opus');
      expect(effective.outer_model).toBe('sonnet');
    });
  });
});
