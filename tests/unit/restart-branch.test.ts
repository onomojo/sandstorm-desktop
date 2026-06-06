import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Registry } from '../../src/main/control-plane/registry';
import { StackManager } from '../../src/main/control-plane/stack-manager';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import { PortAllocator } from '../../src/main/control-plane/port-allocator';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

function makeStackManager(registry: Registry): StackManager {
  const runtime = {
    name: 'mock',
    composeUp: vi.fn().mockResolvedValue(undefined),
    composeDown: vi.fn().mockResolvedValue(undefined),
    listContainers: vi.fn().mockResolvedValue([]),
    inspect: vi.fn(),
    logs: vi.fn().mockReturnValue((async function* () {})()),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('mock'),
    containerStats: vi.fn(),
  };
  const portAllocator = new PortAllocator(registry, [50000, 50099]);
  const taskWatcher = new TaskWatcher(registry, runtime as never, runtime as never, { pollInterval: 999999 });
  return new StackManager(registry, portAllocator, taskWatcher, runtime as never, runtime as never, '/fake/cli');
}

describe('nextRestartBranch', () => {
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

  it('returns -r2 when no prior restarts exist (original branch counts as r1)', () => {
    // Create original stack
    registry.createStack({
      id: 'feat/123-fix-auth-bug',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix-auth-bug',
      description: null,
      status: 'failed',
      runtime: 'docker',
    });

    const sm = makeStackManager(registry);
    const branch = sm.nextRestartBranch('123', 'feat/123-fix-auth-bug');
    expect(branch).toBe('feat/123-fix-auth-bug-r2');
  });

  it('returns -r3 when -r2 already exists in active stacks', () => {
    registry.createStack({
      id: 'feat/123-fix-auth-bug',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix-auth-bug',
      description: null,
      status: 'failed',
      runtime: 'docker',
    });
    registry.createStack({
      id: 'feat/123-fix-auth-bug-r2',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix-auth-bug-r2',
      description: null,
      status: 'failed',
      runtime: 'docker',
    });

    const sm = makeStackManager(registry);
    const branch = sm.nextRestartBranch('123', 'feat/123-fix-auth-bug');
    expect(branch).toBe('feat/123-fix-auth-bug-r3');
  });

  it('returns -r3 when -r2 exists in stack_history', () => {
    registry.createStack({
      id: 'feat/123-fix-auth-bug',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix-auth-bug',
      description: null,
      status: 'failed',
      runtime: 'docker',
    });
    // Archive r2
    registry.createStack({
      id: 'feat/123-fix-auth-bug-r2',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix-auth-bug-r2',
      description: null,
      status: 'failed',
      runtime: 'docker',
    });
    registry.archiveStack('feat/123-fix-auth-bug-r2', 'failed');

    const sm = makeStackManager(registry);
    const branch = sm.nextRestartBranch('123', 'feat/123-fix-auth-bug');
    expect(branch).toBe('feat/123-fix-auth-bug-r3');
  });

  it('skips over non-rN suffixes correctly', () => {
    registry.createStack({
      id: 'feat/123-fix-auth-bug',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix-auth-bug',
      description: null,
      status: 'failed',
      runtime: 'docker',
    });
    // A branch that doesn't end in -rN should not affect numbering
    registry.createStack({
      id: 'feat/123-fix-something-else',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix-something-else',
      description: null,
      status: 'failed',
      runtime: 'docker',
    });

    const sm = makeStackManager(registry);
    const branch = sm.nextRestartBranch('123', 'feat/123-fix-auth-bug');
    expect(branch).toBe('feat/123-fix-auth-bug-r2');
  });
});
