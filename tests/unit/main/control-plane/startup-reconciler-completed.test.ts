/**
 * Tests for the completed-stacks pass in runStartupReconciliation (ticket #557).
 * Verifies that recheckCompletedStack is called for each completed stack on startup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { runStartupReconciliation } from '../../../../src/main/control-plane/startup-reconciler';
import { Registry } from '../../../../src/main/control-plane/registry';
import { PortAllocator } from '../../../../src/main/control-plane/port-allocator';
import { TaskWatcher } from '../../../../src/main/control-plane/task-watcher';
import { StackManager } from '../../../../src/main/control-plane/stack-manager';
import type { ContainerRuntime } from '../../../../src/main/runtime/types';
import { makeFakeContainerRuntime } from '../../../helpers/fake-container-runtime';

function makeTempDb(): string {
  return path.join(
    os.tmpdir(),
    `sr-completed-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

function createMockRuntime(): ContainerRuntime {
  return makeFakeContainerRuntime();
}

describe('runStartupReconciliation — completed stacks pass', () => {
  let registry: Registry;
  let runtime: ContainerRuntime;
  let manager: StackManager;
  let taskWatcher: TaskWatcher;
  let dbPath: string;
  let notifyUpdate: ReturnType<typeof vi.fn>;
  let recheckSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    runtime = createMockRuntime();
    const portAllocator = new PortAllocator(registry, [40300, 40399]);
    taskWatcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 100 });
    manager = new StackManager(registry, portAllocator, taskWatcher, runtime, runtime, '/fake/cli');
    notifyUpdate = vi.fn();

    // Stub recheckCompletedStack so it doesn't need real Docker
    recheckSpy = vi.spyOn(manager, 'recheckCompletedStack').mockResolvedValue({ outcome: 'not_token_limited' });
  });

  afterEach(() => {
    taskWatcher.unwatchAll();
    registry.close();
    cleanupDb(dbPath);
    vi.restoreAllMocks();
  });

  it('calls recheckCompletedStack for each completed stack', async () => {
    registry.createStack({
      id: 'c1', project: 'p', project_dir: '/p', ticket: null,
      branch: null, description: null, status: 'completed', runtime: 'docker',
    });
    registry.createStack({
      id: 'c2', project: 'p', project_dir: '/p', ticket: null,
      branch: null, description: null, status: 'completed', runtime: 'docker',
    });

    await runStartupReconciliation(
      registry, manager, taskWatcher, runtime, runtime, notifyUpdate,
    );

    expect(recheckSpy).toHaveBeenCalledTimes(2);
    expect(recheckSpy).toHaveBeenCalledWith('c1');
    expect(recheckSpy).toHaveBeenCalledWith('c2');
  });

  it('does not call recheckCompletedStack for non-completed stacks', async () => {
    registry.createStack({
      id: 'r1', project: 'p', project_dir: '/p', ticket: null,
      branch: null, description: null, status: 'running', runtime: 'docker',
    });
    registry.createStack({
      id: 'f1', project: 'p', project_dir: '/p', ticket: null,
      branch: null, description: null, status: 'failed', runtime: 'docker',
    });

    await runStartupReconciliation(
      registry, manager, taskWatcher, runtime, runtime, notifyUpdate,
    );

    expect(recheckSpy).not.toHaveBeenCalled();
  });

  it('continues past a completed stack that throws during recheck', async () => {
    recheckSpy
      .mockRejectedValueOnce(new Error('transient error'))
      .mockResolvedValueOnce({ outcome: 'not_token_limited' });

    registry.createStack({
      id: 'e1', project: 'p', project_dir: '/p', ticket: null,
      branch: null, description: null, status: 'completed', runtime: 'docker',
    });
    registry.createStack({
      id: 'e2', project: 'p', project_dir: '/p', ticket: null,
      branch: null, description: null, status: 'completed', runtime: 'docker',
    });

    // Should not throw even though first recheck fails
    await expect(
      runStartupReconciliation(registry, manager, taskWatcher, runtime, runtime, notifyUpdate),
    ).resolves.not.toThrow();

    expect(recheckSpy).toHaveBeenCalledTimes(2);
  });

  it('returns container_gone for completed stacks with no running container', async () => {
    recheckSpy.mockResolvedValue({ outcome: 'container_gone' });

    registry.createStack({
      id: 'cg', project: 'p', project_dir: '/p', ticket: null,
      branch: null, description: null, status: 'completed', runtime: 'docker',
    });

    await runStartupReconciliation(
      registry, manager, taskWatcher, runtime, runtime, notifyUpdate,
    );

    expect(recheckSpy).toHaveBeenCalledWith('cg');
    // Stack status unchanged
    expect(registry.getStack('cg')?.status).toBe('completed');
  });
});
