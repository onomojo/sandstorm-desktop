/**
 * Tests for dispatchTask reference resolution (ticket #641).
 * Verifies that external links cited in a prompt are resolved and appended
 * to the prompt delivered to the inner agent, and that the no-link case
 * leaves the prompt unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { StackManager } from '../../../../src/main/control-plane/stack-manager';
import { Registry } from '../../../../src/main/control-plane/registry';
import { PortAllocator } from '../../../../src/main/control-plane/port-allocator';
import { TaskWatcher } from '../../../../src/main/control-plane/task-watcher';
import type { ContainerRuntime } from '../../../../src/main/runtime/types';

// ---------------------------------------------------------------------------
// Mock ticket-references so we don't hit the network or gh CLI.
// ---------------------------------------------------------------------------
const { mockResolveTicketReferences, mockRenderResolvedReferences } = vi.hoisted(() => ({
  mockResolveTicketReferences: vi.fn(),
  mockRenderResolvedReferences: vi.fn(),
}));

vi.mock('../../../../src/main/control-plane/ticket-references', () => ({
  resolveTicketReferences: mockResolveTicketReferences,
  renderResolvedReferences: mockRenderResolvedReferences,
}));

// Also mock ticket-config so fetchTicketWithConfig is controllable.
vi.mock('../../../../src/main/control-plane/ticket-config', async () => {
  const actual = await vi.importActual('../../../../src/main/control-plane/ticket-config');
  return { ...actual, fetchTicketWithConfig: vi.fn().mockResolvedValue(null) };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeTempDb(): string {
  return path.join(
    os.tmpdir(),
    `sm-dispatch-refs-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

function createMockRuntime(): ContainerRuntime {
  return {
    name: 'mock',
    composeUp: vi.fn().mockResolvedValue(undefined),
    composeDown: vi.fn().mockResolvedValue(undefined),
    listContainers: vi.fn().mockResolvedValue([
      {
        id: 'claude-cid',
        name: 'sandstorm-proj-mystack-claude-1',
        image: 'sandstorm-claude',
        status: 'running' as const,
        state: 'running',
        ports: [],
        labels: {},
        created: new Date().toISOString(),
      },
    ]),
    inspect: vi.fn().mockResolvedValue({}),
    logs: vi.fn().mockReturnValue((async function* () {})()),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('Mock 1.0'),
  };
}

function makeStack(id: string) {
  return {
    id,
    project: 'proj',
    project_dir: '/proj',
    ticket: null,
    branch: null,
    description: null,
    status: 'up' as const,
    runtime: 'docker' as const,
  };
}

const REFS_SECTION = '## Resolved References\n\n### https://gist.github.com/user/abc\n\n```\nmockup content\n```\n';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('dispatchTask — reference resolution', () => {
  let registry: Registry;
  let portAllocator: PortAllocator;
  let taskWatcher: TaskWatcher;
  let runtime: ContainerRuntime;
  let manager: StackManager;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    runtime = createMockRuntime();
    portAllocator = new PortAllocator(registry, [40000, 40099]);
    taskWatcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 100 });
    manager = new StackManager(registry, portAllocator, taskWatcher, runtime, runtime, '/fake/cli');

    // Default: no references resolved
    mockResolveTicketReferences.mockResolvedValue([]);
    mockRenderResolvedReferences.mockReturnValue('');
  });

  afterEach(() => {
    taskWatcher.unwatchAll();
    registry.close();
    cleanupDb(dbPath);
  });

  it('appends resolved references block to the prompt delivered to runCli', async () => {
    registry.createStack(makeStack('ref-stack'));
    const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
      stdout: 'ok', stderr: '', exitCode: 0,
    });

    // Simulate a gist reference being resolved
    mockResolveTicketReferences.mockResolvedValue([
      { url: 'https://gist.github.com/user/abc', kind: 'gist', content: 'mockup content' },
    ]);
    mockRenderResolvedReferences.mockReturnValue(REFS_SECTION);

    const prompt = 'Implement the mockup at https://gist.github.com/user/abc';
    await manager.dispatchTask('ref-stack', prompt, undefined, { forceBypass: true });

    // Prompt is delivered via --file (temp file) to avoid argv E2BIG; read file for content verification.
    const cliArgs: string[] = runCliSpy.mock.calls[0][1] as string[];
    expect(cliArgs).toContain('--file');
    const filePath = cliArgs[cliArgs.indexOf('--file') + 1];
    const deliveredPrompt = fs.readFileSync(filePath, 'utf-8');

    expect(deliveredPrompt).toContain('## Resolved References');
    expect(deliveredPrompt).toContain('mockup content');
    expect(deliveredPrompt).toContain(prompt);
  });

  it('leaves prompt unchanged when the body has no external links (no-op)', async () => {
    registry.createStack(makeStack('noref-stack'));
    const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
      stdout: 'ok', stderr: '', exitCode: 0,
    });

    // No references
    mockResolveTicketReferences.mockResolvedValue([]);
    mockRenderResolvedReferences.mockReturnValue('');

    const prompt = 'Fix the bug in the auth module';
    await manager.dispatchTask('noref-stack', prompt, undefined, { forceBypass: true });

    // Prompt is delivered via --file (temp file); read file for content verification.
    const cliArgs: string[] = runCliSpy.mock.calls[0][1] as string[];
    expect(cliArgs).toContain('--file');
    const filePath = cliArgs[cliArgs.indexOf('--file') + 1];
    const deliveredPrompt = fs.readFileSync(filePath, 'utf-8');

    expect(deliveredPrompt).toBe(prompt);
    expect(deliveredPrompt).not.toContain('## Resolved References');
  });

  it('calls resolveTicketReferences with the full prompt text', async () => {
    registry.createStack(makeStack('args-stack'));
    vi.spyOn(manager, 'runCli').mockResolvedValue({
      stdout: 'ok', stderr: '', exitCode: 0,
    });

    const prompt = 'Implement feature at https://example.com/spec';
    await manager.dispatchTask('args-stack', prompt, undefined, { forceBypass: true });

    expect(mockResolveTicketReferences).toHaveBeenCalledWith(
      expect.stringContaining('https://example.com/spec')
    );
  });

  it('appended section is separated by a horizontal rule', async () => {
    registry.createStack(makeStack('sep-stack'));
    const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
      stdout: 'ok', stderr: '', exitCode: 0,
    });

    mockResolveTicketReferences.mockResolvedValue([
      { url: 'https://example.com/doc', kind: 'other', content: 'design doc' },
    ]);
    mockRenderResolvedReferences.mockReturnValue('## Resolved References\n\n### https://example.com/doc\n\ndesign doc\n');

    await manager.dispatchTask('sep-stack', 'Build per spec at https://example.com/doc', undefined, { forceBypass: true });

    // Prompt is delivered via --file (temp file); read file for content verification.
    const cliArgs: string[] = runCliSpy.mock.calls[0][1] as string[];
    expect(cliArgs).toContain('--file');
    const filePath = cliArgs[cliArgs.indexOf('--file') + 1];
    const deliveredPrompt = fs.readFileSync(filePath, 'utf-8');

    expect(deliveredPrompt).toContain('\n\n---\n\n');
    expect(deliveredPrompt).toContain('## Resolved References');
  });
});
