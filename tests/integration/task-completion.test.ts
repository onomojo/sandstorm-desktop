import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import { Registry } from '../../src/main/control-plane/registry';
import { ContainerRuntime } from '../../src/main/runtime/types';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Task Completion (Integration)', () => {
  let registry: Registry;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `sandstorm-task-int-${Date.now()}.db`);
    registry = await Registry.create(dbPath);

    registry.createStack({
      id: 'int-task-stack',
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

  it('watcher correctly transitions task through running → completed', async () => {
    let callCount = 0;
    const runtime: ContainerRuntime = {
      name: 'mock',
      composeUp: vi.fn(),
      composeDown: vi.fn(),
      listContainers: vi.fn().mockResolvedValue([]),
      inspect: vi.fn(),
      logs: vi.fn(),
      exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
        if (cmd.includes('/tmp/claude-task.status')) {
          callCount++;
          // First poll: still running. Second: completed
          if (callCount <= 1) {
            return { exitCode: 0, stdout: 'running', stderr: '' };
          }
          return { exitCode: 0, stdout: 'completed', stderr: '' };
        }
        if (cmd.includes('/tmp/claude-task.exit')) {
          return { exitCode: 0, stdout: '0', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      version: vi.fn().mockResolvedValue('Mock 1.0'),
    };

    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });
    registry.createTask('int-task-stack', 'integration task');

    const result = await new Promise<{ stackId: string }>((resolve) => {
      watcher.on('task:completed', (data) => resolve(data));
      watcher.watch('int-task-stack', 'container-123');
    });

    expect(result.stackId).toBe('int-task-stack');

    // Verify registry was updated
    const stack = registry.getStack('int-task-stack');
    expect(stack!.status).toBe('completed');

    const tasks = registry.getTasksForStack('int-task-stack');
    expect(tasks[0].status).toBe('completed');
    expect(tasks[0].exit_code).toBe(0);

    watcher.unwatchAll();
  });
});
