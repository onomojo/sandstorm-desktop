import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Registry } from '../../src/main/control-plane/registry';
import { BackendRouter } from '../../src/main/agent/backend-router';
import type { AgentBackend } from '../../src/main/agent/types';

// ── Grep-absent: legacy symbols must not appear in src/ ──────────────────────

function grepSrc(pattern: string): string[] {
  const srcDir = path.join(__dirname, '../../src');
  const hits: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        if (fs.readFileSync(full, 'utf-8').includes(pattern)) {
          hits.push(path.relative(srcDir, full));
        }
      }
    }
  }
  walk(srcDir);
  return hits;
}

describe('legacy symbols absent from src/', () => {
  it('ModelSettingsModal is not referenced anywhere in src/', () => {
    expect(grepSrc('ModelSettingsModal')).toEqual([]);
  });

  it('BackendSelector is not referenced anywhere in src/', () => {
    expect(grepSrc('BackendSelector')).toEqual([]);
  });
});

// ── Grep-absent: split-brain collapse ────────────────────────────────────────

describe('split-brain collapse — source assertions', () => {
  const indexTs = fs.readFileSync(
    path.join(__dirname, '../../src/main/index.ts'),
    'utf-8',
  );
  const opencodeTs = fs.readFileSync(
    path.join(__dirname, '../../src/main/agent/opencode-backend.ts'),
    'utf-8',
  );

  it('index.ts outer selector does not call getEffectiveBackend', () => {
    expect(indexTs).not.toContain("getEffectiveBackend(projectDir, 'outer')");
  });

  it('index.ts outer selector calls getEffectiveRoutingFor', () => {
    expect(indexTs).toContain("getEffectiveRoutingFor(projectDir, 'outer')");
  });

  it('opencode-backend.ts does not call getEffectiveBackend with outer', () => {
    expect(opencodeTs).not.toContain("getEffectiveBackend(projectDir, 'outer')");
  });

  it('opencode-backend.ts calls getEffectiveRoutingFor for outer model resolution', () => {
    const outerCallCount = (opencodeTs.match(/getEffectiveRoutingFor\(projectDir, 'outer'\)/g) ?? []).length;
    expect(outerCallCount).toBeGreaterThanOrEqual(3);
  });

  it('opencode-backend.ts RegistryRef interface declares getEffectiveRoutingFor not getEffectiveBackend', () => {
    expect(opencodeTs).toContain('getEffectiveRoutingFor(projectDir: string, touchpoint: string)');
    expect(opencodeTs).not.toContain('getEffectiveBackend(projectDir: string, surface:');
  });
});

// ── Registry integration: outer touchpoint routes to OpenCode ────────────────

function makeTempDb(): string {
  return path.join(
    os.tmpdir(),
    `sandstorm-modal-redesign-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

describe('Registry.getEffectiveRoutingFor — outer backend', () => {
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

  it('returns claude backend by default for outer touchpoint', () => {
    const result = registry.getEffectiveRoutingFor('/proj/a', 'outer');
    expect(result.backend).toBe('claude');
  });

  it('returns opencode backend for outer when project routing is set to opencode', () => {
    registry.setProjectRouting('/proj/a', {
      assignments: { outer: { backend: 'opencode', provider: 'anthropic', model: 'claude-sonnet-4-5' } },
    });
    const result = registry.getEffectiveRoutingFor('/proj/a', 'outer');
    expect(result.backend).toBe('opencode');
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-5');
  });

  it('outer routing is independent of legacy inner_backend/outer_backend columns', () => {
    registry.setGlobalBackendSettings({ inner_backend: 'opencode', outer_backend: 'claude' });
    registry.setProjectRouting('/proj/b', {
      assignments: { outer: { backend: 'opencode', provider: 'anthropic', model: 'claude-opus-4-8' } },
    });
    const result = registry.getEffectiveRoutingFor('/proj/b', 'outer');
    expect(result.backend).toBe('opencode');
  });
});

// ── BackendRouter: opencode-routed outer selects OpenCodeBackend ─────────────

describe('BackendRouter — outer selector picks OpenCodeBackend when routing says opencode', () => {
  it('selects opencode backend when selector returns opencode', async () => {
    let selectedBackend: string | null = null;

    const mockClaudeBackend: AgentBackend = {
      name: 'Claude',
      initialize: async () => {},
      sendMessage: async () => {},
      resetSession: async () => {},
      cancelMessage: async () => {},
      runEphemeralAgent: async () => '',
      getAuthStatus: async () => ({ loggedIn: false, expired: false }),
      login: async () => ({ success: false }),
      setMainWindow: () => {},
    };

    const mockOpenCodeBackend: AgentBackend = {
      name: 'OpenCode',
      initialize: async () => {},
      sendMessage: async () => { selectedBackend = 'opencode'; },
      resetSession: async () => {},
      cancelMessage: async () => {},
      runEphemeralAgent: async () => '',
      getAuthStatus: async () => ({ loggedIn: false, expired: false }),
      login: async () => ({ success: false }),
      setMainWindow: () => {},
    };

    const router = new BackendRouter(
      {
        claude: () => mockClaudeBackend,
        opencode: () => mockOpenCodeBackend,
      },
      (_projectDir) => 'opencode',
    );
    await router.initialize();

    await router.sendMessage('tab1', '/proj/a', 'hello', {});
    expect(selectedBackend).toBe('opencode');
  });

  it('selects claude backend when selector returns claude', async () => {
    let selectedBackend: string | null = null;

    const mockClaudeBackend: AgentBackend = {
      name: 'Claude',
      initialize: async () => {},
      sendMessage: async () => { selectedBackend = 'claude'; },
      resetSession: async () => {},
      cancelMessage: async () => {},
      runEphemeralAgent: async () => '',
      getAuthStatus: async () => ({ loggedIn: false, expired: false }),
      login: async () => ({ success: false }),
      setMainWindow: () => {},
    };

    const mockOpenCodeBackend: AgentBackend = {
      name: 'OpenCode',
      initialize: async () => {},
      sendMessage: async () => {},
      resetSession: async () => {},
      cancelMessage: async () => {},
      runEphemeralAgent: async () => '',
      getAuthStatus: async () => ({ loggedIn: false, expired: false }),
      login: async () => ({ success: false }),
      setMainWindow: () => {},
    };

    const router = new BackendRouter(
      {
        claude: () => mockClaudeBackend,
        opencode: () => mockOpenCodeBackend,
      },
      (_projectDir) => 'claude',
    );
    await router.initialize();

    await router.sendMessage('tab1', '/proj/a', 'hello', {});
    expect(selectedBackend).toBe('claude');
  });
});

// ── Credential continuity — backend secrets readable after ModelSettings removal

describe('credential continuity — backend secrets survive ModelSettings deletion', () => {
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

  it('setBackendSecretBundle round-trips through getBackendSecretBundle', () => {
    registry.setBackendSecretBundle('global', 'outer', {
      ANTHROPIC_API_KEY: 'sk-ant-test-key',
    });
    const bundle = registry.getBackendSecretBundle('global', 'outer');
    expect(bundle).not.toBeNull();
    expect(bundle?.ANTHROPIC_API_KEY).toBe('sk-ant-test-key');
  });

  it('single-field setBackendSecret is readable via getBackendSecretBundle (legacy path)', () => {
    registry.setBackendSecret('global', 'outer', 'ANTHROPIC_API_KEY', 'sk-ant-legacy');
    const bundle = registry.getBackendSecretBundle('global', 'outer');
    expect(bundle).not.toBeNull();
    expect(bundle?.ANTHROPIC_API_KEY).toBe('sk-ant-legacy');
  });

  it('returns null when no secrets have been set', () => {
    const bundle = registry.getBackendSecretBundle('global', 'outer');
    expect(bundle).toBeNull();
  });
});
