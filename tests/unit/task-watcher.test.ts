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
    const runtime = createMockRuntime('completed', '0');
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
    const runtime = createMockRuntime('failed', '1');
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
    const runtime = createMockRuntime('completed', '0');
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
});
