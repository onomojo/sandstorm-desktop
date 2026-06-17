import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenCodeBackend } from '../../../src/main/agent/opencode-backend';
import type { StackInfo } from '../../../src/main/agent/types';

// Mock child_process.spawn so we don't need Docker
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn().mockImplementation(() => {
      const proc = {
        stdin: { write: vi.fn(), end: vi.fn() },
        on: vi.fn().mockImplementation((event: string, cb: () => void) => {
          if (event === 'close' || event === 'error') cb();
          return proc;
        }),
      };
      return proc;
    }),
  };
});

// Mock the '../index' import to return a fake registry
vi.mock('../../../src/main/index', () => ({
  registry: {
    getGlobalBackendSettings: vi.fn().mockReturnValue({
      inner_backend: 'opencode',
      inner_provider: 'anthropic',
      inner_model: null,
      outer_backend: 'claude',
      outer_provider: null,
      outer_model: null,
    }),
    getBackendSecretBundle: vi.fn().mockReturnValue({ apiKey: 'sk-test-bedrock' }),
  },
  cliDir: '/fake/cli',
}));

// Mock opencode-config so we don't need the full runtime
vi.mock('../../../src/main/opencode-config', () => ({
  generateOpencodeConfig: vi.fn().mockReturnValue({
    model: 'anthropic/claude-sonnet-4-6',
    provider: { anthropic: { apiKey: 'sk-test-bedrock' } },
    permission: 'allow',
    instructions: ['/home/claude/.claude/CLAUDE.md'],
    mcp: {},
  }),
}));

describe('OpenCodeBackend.syncCredentials', () => {
  let backend: OpenCodeBackend;

  beforeEach(() => {
    backend = new OpenCodeBackend();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('skips stacks that are not running or up', async () => {
    const { spawn } = await import('child_process');
    const stacks: StackInfo[] = [
      { status: 'building', services: [{ name: 'claude', status: 'starting', containerId: 'cid1' }] },
      { status: 'stopped', services: [{ name: 'claude', status: 'exited', containerId: 'cid2' }] },
    ];
    await backend.syncCredentials(stacks);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('skips stacks with no claude service', async () => {
    const { spawn } = await import('child_process');
    const stacks: StackInfo[] = [
      { status: 'running', services: [{ name: 'app', status: 'running', containerId: 'cid1' }] },
    ];
    await backend.syncCredentials(stacks);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('calls docker exec to clean auth.json for running stacks', async () => {
    const { spawn } = await import('child_process');
    const stacks: StackInfo[] = [
      { status: 'running', services: [{ name: 'claude', status: 'running', containerId: 'abc123' }] },
    ];
    await backend.syncCredentials(stacks);

    const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
    // Should have been called at least once for auth.json cleanup
    expect(calls.length).toBeGreaterThanOrEqual(1);

    // First call should be the auth.json cleanup
    const [cmd, args] = calls[0];
    expect(cmd).toBe('docker');
    expect(args).toContain('exec');
    expect(args).toContain('abc123');
    const scriptArg = args.find((a: string) => a.includes('auth.json'));
    expect(scriptArg).toBeDefined();
    expect(scriptArg).toContain('rm -f');
  });

  it('writes generated config to /tmp/sandstorm-opencode.json', async () => {
    const { spawn } = await import('child_process');
    const stacks: StackInfo[] = [
      { status: 'up', services: [{ name: 'claude', status: 'running', containerId: 'def456' }] },
    ];
    await backend.syncCredentials(stacks);

    const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
    // Second docker exec should write the config file
    const configWriteCall = calls.find(([, args]: [string, string[]]) =>
      args.some((a: string) => a.includes('sandstorm-opencode.json')),
    );
    expect(configWriteCall).toBeDefined();
    const [, args] = configWriteCall;
    expect(args).toContain('exec');
    expect(args).toContain('def456');
  });

  it('proceeds with empty bundle when no credentials are stored', async () => {
    const { registry } = await import('../../../src/main/index');
    (registry.getBackendSecretBundle as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

    const stacks: StackInfo[] = [
      { status: 'running', services: [{ name: 'claude', status: 'running', containerId: 'ghi789' }] },
    ];
    // Should not throw
    await expect(backend.syncCredentials(stacks)).resolves.toBeUndefined();
  });

  it('selects non-Anthropic active credential when provider is bedrock', async () => {
    const { registry } = await import('../../../src/main/index');
    (registry.getGlobalBackendSettings as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      inner_backend: 'opencode',
      inner_provider: 'amazon-bedrock',
      inner_model: null,
    });
    (registry.getBackendSecretBundle as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      region: 'us-east-1',
      bearerToken: 'bt-bedrock-active',
    });

    const { generateOpencodeConfig } = await import('../../../src/main/opencode-config');
    const stacks: StackInfo[] = [
      { status: 'running', services: [{ name: 'claude', status: 'running', containerId: 'jkl012' }] },
    ];
    await backend.syncCredentials(stacks);

    // Asserts that the active non-Anthropic credential was used in config generation
    expect(generateOpencodeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'amazon-bedrock',
        bundle: expect.objectContaining({ bearerToken: 'bt-bedrock-active' }),
      }),
    );
  });
});
