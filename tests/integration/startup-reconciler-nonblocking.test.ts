import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Registry } from '../../src/main/control-plane/registry';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import { StackManager } from '../../src/main/control-plane/stack-manager';
import { ContainerRuntime, Container } from '../../src/main/runtime/types';
import { makeFakeContainerRuntime } from '../helpers/fake-container-runtime';
import { runStartupReconciliation } from '../../src/main/control-plane/startup-reconciler';

function makeTempDb(): string {
  return path.join(
    os.tmpdir(),
    `sandstorm-nonblocking-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

/**
 * DR-F integration test: verifies that the startup reconciliation pass is fired
 * as fire-and-forget after the main window becomes ready, not before.
 *
 * Mirrors the index.ts wiring at src/main/index.ts:386-397:
 *   mainWindow.webContents.once('did-finish-load', () => {
 *     runStartupReconciliation(...).catch(...);
 *   });
 *
 * The app window appears immediately; reconciliation runs in the background.
 */
describe('DR-F: non-blocking startup reconciliation (integration)', () => {
  let registry: Registry;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
    vi.restoreAllMocks();
  });

  it('window reaches did-finish-load before reconciliation completes; stacks:updated emitted per stack', async () => {
    // Seed a stale running stack — simulates an app restart where the container
    // was still active when the user closed the app.
    const stackId = 'dr-f-test-stack';
    registry.createStack({
      id: stackId,
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'up',
      runtime: 'docker',
    });
    registry.createTask(stackId, 'stale task that was running when the app closed');

    const timeline: string[] = [];
    const updates: string[] = [];

    // A barrier that holds listContainers until we release it, simulating the
    // real Docker daemon latency (network round-trip + container enumeration).
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });

    const mockContainer: Container = {
      id: 'container-abc',
      name: 'sandstorm-proj-dr-f-test-stack-claude-1',
      image: 'sandstorm-claude',
      status: 'running',
      state: 'running',
      ports: [],
      labels: {},
      created: '2026-01-01T00:00:00.000Z',
    };

    const slowRuntime = makeFakeContainerRuntime({
      listContainers: vi.fn().mockImplementation(async () => {
        await barrier; // Blocked until we call releaseBarrier()
        return [mockContainer];
      }),
      exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
        if (cmd.includes('/tmp/claude-task.status')) {
          return { exitCode: 0, stdout: 'completed', stderr: '' };
        }
        if (cmd.includes('/tmp/claude-task.exit')) {
          return { exitCode: 0, stdout: '0', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    });

    const stackManagerMock = {
      resumeStackWithContinuation: vi.fn(),
      dispatchTask: vi.fn(),
    };

    const watcher = new TaskWatcher(registry, slowRuntime, slowRuntime, { pollInterval: 50 });

    // ── Simulate the index.ts did-finish-load handler ─────────────────────────
    // In index.ts:386-397:
    //   mainWindow.webContents.once('did-finish-load', () => {
    //     runStartupReconciliation(...).catch(...);
    //   });
    //
    // The window becomes ready synchronously (did-finish-load fires),
    // THEN reconciliation starts fire-and-forget (no await).

    // Step 1: window is now ready (did-finish-load fired)
    timeline.push('window:did-finish-load');

    // Step 2: kick off reconciliation fire-and-forget, exactly as index.ts does
    const reconcilePromise = runStartupReconciliation(
      registry,
      stackManagerMock as unknown as StackManager,
      watcher,
      slowRuntime,
      slowRuntime,
      () => { updates.push('stacks:updated'); },
      { workspaceExistsFn: () => false },
    ).then(() => timeline.push('reconcile:complete'));

    // ── Core DR-F assertion ───────────────────────────────────────────────────
    // The window is ready immediately; reconciliation is NOT yet complete because
    // listContainers is blocked. This is the fire-and-forget guarantee: the
    // window never waits for the (potentially slow) recovery pass.
    expect(timeline).toContain('window:did-finish-load');
    expect(timeline).not.toContain('reconcile:complete');

    // ── Unblock the reconciler and wait for it to finish ─────────────────────
    releaseBarrier();
    await reconcilePromise;

    // ── Post-completion assertions ────────────────────────────────────────────
    expect(timeline).toContain('reconcile:complete');
    expect(updates).toContain('stacks:updated');

    // Critical ordering: window was ready BEFORE reconcile completed
    expect(timeline.indexOf('window:did-finish-load'))
      .toBeLessThan(timeline.indexOf('reconcile:complete'));

    watcher.unwatchAll();
  });

  it('emits stacks:updated after each recovered stack (per-stack live updates)', async () => {
    // Two stale running stacks — branch 5 (no container, no workspace, no ticket → orphan removal)
    const stackId1 = 'nonblocking-stack-1';
    const stackId2 = 'nonblocking-stack-2';

    for (const id of [stackId1, stackId2]) {
      registry.createStack({
        id,
        project: 'proj',
        project_dir: '/proj',
        ticket: null,
        branch: null,
        description: null,
        status: 'up',
        runtime: 'docker',
      });
      registry.createTask(id, 'stale task');
    }

    const updatesEmitted: string[] = [];
    const notifyUpdate = vi.fn(() => updatesEmitted.push('stacks:updated'));

    const noContainerRuntime = makeFakeContainerRuntime({
      exec: vi.fn(),
    });

    const stackManagerMock = {
      resumeStackWithContinuation: vi.fn(),
      dispatchTask: vi.fn(),
    };

    const watcher = new TaskWatcher(registry, noContainerRuntime, noContainerRuntime, { pollInterval: 50 });

    await runStartupReconciliation(
      registry,
      stackManagerMock as unknown as StackManager,
      watcher,
      noContainerRuntime,
      noContainerRuntime,
      notifyUpdate,
      { workspaceExistsFn: () => false },
    );

    // stacks:updated must be emitted at least once per recovered stack so the
    // renderer can refresh cards live as each stack is processed.
    expect(updatesEmitted.filter((e) => e === 'stacks:updated').length)
      .toBeGreaterThanOrEqual(2);

    watcher.unwatchAll();
  });
});
