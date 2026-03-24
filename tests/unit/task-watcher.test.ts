import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import { Registry } from '../../src/main/control-plane/registry';
import { ContainerRuntime } from '../../src/main/runtime/types';
import fs from 'fs';
import path from 'path';
import os from 'os';

function createMockRuntime(
  taskStatus: string = 'running',
  exitCode: string = '0'
): ContainerRuntime {
  return {
    name: 'mock',
    composeUp: vi.fn(),
    composeDown: vi.fn(),
    listContainers: vi.fn().mockResolvedValue([]),
    inspect: vi.fn(),
    logs: vi.fn(),
    exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
      if (cmd.includes('/tmp/claude-task.status')) {
        return { exitCode: 0, stdout: taskStatus, stderr: '' };
      }
      if (cmd.includes('/tmp/claude-task.exit')) {
        return { exitCode: 0, stdout: exitCode, stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('Mock 1.0'),
  };
}

/**
 * Create a mock runtime that transitions through status phases.
 * Returns `statuses[callIndex]` for each successive read of the status file,
 * staying on the last entry once exhausted.
 */
function createSequencedRuntime(
  statuses: string[],
  exitCode: string = '0'
): ContainerRuntime {
  let callIndex = 0;
  return {
    name: 'mock',
    composeUp: vi.fn(),
    composeDown: vi.fn(),
    listContainers: vi.fn().mockResolvedValue([]),
    inspect: vi.fn(),
    logs: vi.fn(),
    exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
      if (cmd.includes('/tmp/claude-task.status')) {
        const idx = Math.min(callIndex, statuses.length - 1);
        callIndex++;
        return { exitCode: 0, stdout: statuses[idx], stderr: '' };
      }
      if (cmd.includes('/tmp/claude-task.exit')) {
        return { exitCode: 0, stdout: exitCode, stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('Mock 1.0'),
  };
}

describe('TaskWatcher', () => {
  let registry: Registry;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `sandstorm-watcher-test-${Date.now()}.db`);
    registry = await Registry.create(dbPath);

    registry.createStack({
      id: 'watch-stack',
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'up',
      runtime: 'docker',
    });
  });

  afterEach(() => {
    registry.close();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(`${dbPath}-wal`);
      fs.unlinkSync(`${dbPath}-shm`);
    } catch {
      // ignore
    }
  });

  it('emits task:completed when task finishes successfully', async () => {
    // Status transitions: running → completed
    const runtime = createSequencedRuntime(['running', 'completed'], '0');
    const watcher = new TaskWatcher(registry, runtime, {
      pollInterval: 50,
    });

    registry.createTask('watch-stack', 'test task');

    const completedPromise = new Promise<void>((resolve) => {
      watcher.on('task:completed', ({ stackId, task }) => {
        expect(stackId).toBe('watch-stack');
        expect(task.exit_code).toBe(0);
        resolve();
      });
    });

    watcher.watch('watch-stack', 'container-123');

    await completedPromise;
    watcher.unwatchAll();
  });

  it('emits task:failed when task exits with error', async () => {
    // Status transitions: running → failed
    const runtime = createSequencedRuntime(['running', 'failed'], '1');
    const watcher = new TaskWatcher(registry, runtime, {
      pollInterval: 50,
    });

    registry.createTask('watch-stack', 'failing task');

    const failedPromise = new Promise<void>((resolve) => {
      watcher.on('task:failed', ({ stackId, task }) => {
        expect(stackId).toBe('watch-stack');
        expect(task.exit_code).toBe(1);
        resolve();
      });
    });

    watcher.watch('watch-stack', 'container-123');

    await failedPromise;
    watcher.unwatchAll();
  });

  it('stops watching after task completes', async () => {
    // Status transitions: running → completed
    const runtime = createSequencedRuntime(['running', 'completed'], '0');
    const watcher = new TaskWatcher(registry, runtime, {
      pollInterval: 50,
    });

    registry.createTask('watch-stack', 'test task');

    await new Promise<void>((resolve) => {
      watcher.on('task:completed', () => resolve());
      watcher.watch('watch-stack', 'container-123');
    });

    // The exec should have been called a limited number of times
    const execFn = runtime.exec as ReturnType<typeof vi.fn>;
    const callCount = execFn.mock.calls.length;

    // Wait a bit and verify no more calls
    await new Promise((r) => setTimeout(r, 100));
    expect(execFn.mock.calls.length).toBe(callCount);

    watcher.unwatchAll();
  });

  it('unwatchAll clears all watchers', () => {
    const runtime = createMockRuntime('running', '0');
    const watcher = new TaskWatcher(registry, runtime, {
      pollInterval: 50,
    });

    watcher.watch('watch-stack', 'container-1');
    watcher.unwatchAll();

    // No error thrown — clean shutdown
  });

  it('ignores stale completed status from prior task (regression #18)', async () => {
    // Simulate the bug scenario:
    // 1. First task completes → status file says "completed"
    // 2. Second task dispatched → watcher starts, status file still says "completed"
    // 3. Task runner eventually overwrites with "running", then "completed"
    //
    // Without the fix, the watcher would immediately mark the second task as
    // completed because it reads the stale "completed" from the first task.

    // Phase 1: Complete the first task normally (running → completed)
    const runtime1 = createSequencedRuntime(['running', 'completed'], '0');
    const watcher = new TaskWatcher(registry, runtime1, { pollInterval: 50 });

    registry.createTask('watch-stack', 'first task');

    await new Promise<void>((resolve) => {
      watcher.on('task:completed', () => resolve());
      watcher.watch('watch-stack', 'container-123');
    });

    // Verify first task completed
    const stack1 = registry.getStack('watch-stack');
    expect(stack1!.status).toBe('completed');

    // Phase 2: Dispatch second task — status file still has "completed" from task 1
    // Simulate: stale "completed" → then task runner resets to "running" → then "completed"
    const runtime2 = createSequencedRuntime(
      ['completed', 'completed', 'running', 'running', 'completed'],
      '0'
    );
    const watcher2 = new TaskWatcher(registry, runtime2, { pollInterval: 50 });

    const task2 = registry.createTask('watch-stack', 'second task');

    // The watcher should NOT immediately complete — it must wait for "running" first
    let completedTaskId: number | null = null;
    const task2Completed = new Promise<void>((resolve) => {
      watcher2.on('task:completed', ({ task }) => {
        completedTaskId = task.id;
        resolve();
      });
    });

    watcher2.watch('watch-stack', 'container-123');

    await task2Completed;

    // Must be the second task that completed, not the first
    expect(completedTaskId).toBe(task2.id);

    // Stack should be completed
    const stack2 = registry.getStack('watch-stack');
    expect(stack2!.status).toBe('completed');

    watcher2.unwatchAll();
  });

  it('detects completion for first task without needing prior running (fresh dispatch)', async () => {
    // For the very first task on a stack, the status file doesn't exist yet.
    // The task runner writes "running" first, then "completed".
    // This should work normally.
    const runtime = createSequencedRuntime(['running', 'completed'], '0');
    const watcher = new TaskWatcher(registry, runtime, { pollInterval: 50 });

    registry.createTask('watch-stack', 'fresh task');

    const completed = new Promise<void>((resolve) => {
      watcher.on('task:completed', ({ task }) => {
        expect(task.exit_code).toBe(0);
        resolve();
      });
    });

    watcher.watch('watch-stack', 'container-123');
    await completed;
    watcher.unwatchAll();
  });
});
