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
    getEffectiveTouchpointDescriptor: vi.fn().mockImplementation((_projectDir: string, touchpoint: string) => {
      if (touchpoint === 'execution') {
        return { backend: 'opencode', provider: 'anthropic', model: 'claude-sonnet-4-6', credentials: { apiKey: 'sk-test-key' } };
      }
      // review and meta_review default to claude
      return { backend: 'claude', provider: 'anthropic', model: 'opus', credentials: null };
    }),
  },
  cliDir: '/fake/cli',
}));

// Mock opencode-config so we don't need the full runtime
vi.mock('../../../src/main/opencode-config', () => ({
  generateOpencodeConfig: vi.fn().mockReturnValue({
    model: 'anthropic/claude-sonnet-4-6',
    provider: { anthropic: { apiKey: 'sk-test-key' } },
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
      { status: 'running', project_dir: '/proj', services: [{ name: 'app', status: 'running', containerId: 'cid1' }] },
    ];
    await backend.syncCredentials(stacks);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('calls docker exec to clean auth.json for running stacks', async () => {
    const { spawn } = await import('child_process');
    const stacks: StackInfo[] = [
      { status: 'running', project_dir: '/proj', services: [{ name: 'claude', status: 'running', containerId: 'abc123' }] },
    ];
    await backend.syncCredentials(stacks);

    const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
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

  it('writes generated config to /tmp/sandstorm-opencode-<provider>.json', async () => {
    const { spawn } = await import('child_process');
    const stacks: StackInfo[] = [
      { status: 'up', project_dir: '/proj', services: [{ name: 'claude', status: 'running', containerId: 'def456' }] },
    ];
    await backend.syncCredentials(stacks);

    const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
    // A docker exec should write the provider-specific config file
    const configWriteCall = calls.find(([, args]: [string, string[]]) =>
      args.some((a: string) => a.includes('sandstorm-opencode-anthropic.json')),
    );
    expect(configWriteCall).toBeDefined();
    const [, args] = configWriteCall;
    expect(args).toContain('exec');
    expect(args).toContain('def456');
  });

  it('skips writing config when stack has no project_dir', async () => {
    const { spawn } = await import('child_process');
    const stacks: StackInfo[] = [
      { status: 'running', services: [{ name: 'claude', status: 'running', containerId: 'ghi789' }] },
    ];
    // Should not throw, and no provider config should be written (no project_dir to look up routing)
    await expect(backend.syncCredentials(stacks)).resolves.toBeUndefined();
    const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
    const configWriteCall = calls.find(([, args]: [string, string[]]) =>
      args.some((a: string) => a.includes('sandstorm-opencode-')),
    );
    expect(configWriteCall).toBeUndefined();
  });

  it('skips provider config when credentials are null (signals needs_key to task runner)', async () => {
    const { registry } = await import('../../../src/main/index');
    // All phases return null credentials
    (registry.getEffectiveTouchpointDescriptor as ReturnType<typeof vi.fn>).mockReturnValue({
      backend: 'opencode', provider: 'amazon-bedrock', model: null, credentials: null,
    });

    const { generateOpencodeConfig } = await import('../../../src/main/opencode-config');
    const stacks: StackInfo[] = [
      { status: 'running', project_dir: '/proj', services: [{ name: 'claude', status: 'running', containerId: 'jkl012' }] },
    ];
    await backend.syncCredentials(stacks);

    // generateOpencodeConfig should NOT be called (no credentials → no config file)
    expect(generateOpencodeConfig).not.toHaveBeenCalled();
  });

  it('writes one config per distinct provider across phases', async () => {
    const { registry } = await import('../../../src/main/index');
    // execution + review both use amazon-bedrock; meta_review uses a different provider
    (registry.getEffectiveTouchpointDescriptor as ReturnType<typeof vi.fn>).mockImplementation((_: string, tp: string) => {
      if (tp === 'meta_review') {
        return { backend: 'opencode', provider: 'openrouter', model: 'llama', credentials: { apiKey: 'or-key' } };
      }
      return { backend: 'opencode', provider: 'amazon-bedrock', model: 'claude-sonnet', credentials: { region: 'us-east-1' } };
    });

    const { spawn } = await import('child_process');
    const stacks: StackInfo[] = [
      { status: 'running', project_dir: '/proj', services: [{ name: 'claude', status: 'running', containerId: 'mno345' }] },
    ];
    await backend.syncCredentials(stacks);

    const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls;
    const bedrockCall = calls.find(([, args]: [string, string[]]) =>
      args.some((a: string) => a.includes('sandstorm-opencode-amazon-bedrock.json')),
    );
    const orCall = calls.find(([, args]: [string, string[]]) =>
      args.some((a: string) => a.includes('sandstorm-opencode-openrouter.json')),
    );
    expect(bedrockCall).toBeDefined();
    expect(orCall).toBeDefined();
  });

  it('selects non-Anthropic active credential when provider is bedrock', async () => {
    const { registry } = await import('../../../src/main/index');
    (registry.getEffectiveTouchpointDescriptor as ReturnType<typeof vi.fn>).mockReturnValue({
      backend: 'opencode',
      provider: 'amazon-bedrock',
      model: 'claude-sonnet-3-5',
      credentials: { region: 'us-east-1', bearerToken: 'bt-bedrock-active' },
    });

    const { generateOpencodeConfig } = await import('../../../src/main/opencode-config');
    const stacks: StackInfo[] = [
      { status: 'running', project_dir: '/proj', services: [{ name: 'claude', status: 'running', containerId: 'jkl012' }] },
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
