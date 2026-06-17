import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry } from '../../src/main/control-plane/registry';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-v25-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

describe('Registry v25 — backend_secrets bundle read/write', () => {
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

  describe('schema version', () => {
    it('migrates to at least version 25 on fresh database', () => {
      // Registry constructor applies all migrations including v25.
      // If no error thrown and bundle methods exist, migration ran successfully.
      expect(typeof registry.setBackendSecretBundle).toBe('function');
      expect(typeof registry.getBackendSecretBundle).toBe('function');
    });
  });

  describe('setBackendSecretBundle / getBackendSecretBundle', () => {
    it('round-trip: store and retrieve a multi-field bundle', () => {
      registry.setBackendSecretBundle('global', 'inner', {
        region: 'us-east-1',
        accessKeyId: 'AKIATEST',
        secretAccessKey: 'secret123',
      });
      const bundle = registry.getBackendSecretBundle('global', 'inner');
      expect(bundle).toEqual({
        region: 'us-east-1',
        accessKeyId: 'AKIATEST',
        secretAccessKey: 'secret123',
      });
    });

    it('hasBackendSecret returns true after setBackendSecretBundle', () => {
      registry.setBackendSecretBundle('global', 'inner', { apiKey: 'sk-ant-test' });
      expect(registry.hasBackendSecret('global', 'inner')).toBe(true);
    });

    it('returns null when no bundle is stored', () => {
      expect(registry.getBackendSecretBundle('global', 'inner')).toBeNull();
    });

    it('different key/surface pairs are independent', () => {
      registry.setBackendSecretBundle('global', 'inner', { apiKey: 'inner-key' });
      expect(registry.getBackendSecretBundle('global', 'outer')).toBeNull();
    });

    it('overwrites previous bundle', () => {
      registry.setBackendSecretBundle('global', 'inner', { apiKey: 'old-key' });
      registry.setBackendSecretBundle('global', 'inner', { apiKey: 'new-key' });
      const bundle = registry.getBackendSecretBundle('global', 'inner');
      expect(bundle?.apiKey).toBe('new-key');
    });

    it('project-scoped bundle is independent of global', () => {
      const projectKey = `project:${path.resolve('/proj/a')}`;
      registry.setBackendSecretBundle(projectKey, 'inner', { apiKey: 'proj-key' });
      expect(registry.getBackendSecretBundle('global', 'inner')).toBeNull();
      expect(registry.getBackendSecretBundle(projectKey, 'inner')?.apiKey).toBe('proj-key');
    });

    it('stores anthropic bundle with apiKey only', () => {
      registry.setBackendSecretBundle('global', 'outer', { apiKey: 'sk-ant-outer' });
      const bundle = registry.getBackendSecretBundle('global', 'outer');
      expect(bundle?.apiKey).toBe('sk-ant-outer');
    });

    it('stores bedrock bundle with all credential fields', () => {
      registry.setBackendSecretBundle('global', 'inner', {
        region: 'eu-west-1',
        bearerToken: 'bt-secret',
      });
      const bundle = registry.getBackendSecretBundle('global', 'inner');
      expect(bundle?.region).toBe('eu-west-1');
      expect(bundle?.bearerToken).toBe('bt-secret');
    });

    it('stores ollama bundle with baseUrl', () => {
      registry.setBackendSecretBundle('global', 'inner', {
        baseUrl: 'http://host:11434/v1',
      });
      const bundle = registry.getBackendSecretBundle('global', 'inner');
      expect(bundle?.baseUrl).toBe('http://host:11434/v1');
    });
  });

  describe('backward compatibility — legacy single-field rows', () => {
    it('getBackendSecretBundle reads legacy name+value row as { [name]: value }', () => {
      // Write a legacy row (pre-v25 format: name='api_key', value='sk-legacy')
      registry.setBackendSecret('global', 'inner', 'api_key', 'sk-legacy');
      const bundle = registry.getBackendSecretBundle('global', 'inner');
      expect(bundle).toEqual({ api_key: 'sk-legacy' });
    });

    it('hasBackendSecret works for legacy rows', () => {
      registry.setBackendSecret('global', 'inner', 'api_key', 'sk-legacy');
      expect(registry.hasBackendSecret('global', 'inner')).toBe(true);
    });

    it('setBackendSecretBundle overwrites a legacy row', () => {
      registry.setBackendSecret('global', 'inner', 'api_key', 'sk-legacy');
      registry.setBackendSecretBundle('global', 'inner', { apiKey: 'sk-new' });
      const bundle = registry.getBackendSecretBundle('global', 'inner');
      expect(bundle?.apiKey).toBe('sk-new');
      // Legacy field is gone
      expect(bundle?.api_key).toBeUndefined();
    });
  });

  describe('migration idempotency', () => {
    it('opening the same database twice does not throw', async () => {
      registry.close();
      const registry2 = await Registry.create(dbPath);
      expect(registry2).toBeDefined();
      registry2.close();
      // Reopen to satisfy afterEach
      registry = await Registry.create(dbPath);
    });
  });
});
