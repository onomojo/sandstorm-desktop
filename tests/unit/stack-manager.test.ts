import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StackManager } from '../../src/main/control-plane/stack-manager';
import { Registry } from '../../src/main/control-plane/registry';
import { PortAllocator } from '../../src/main/control-plane/port-allocator';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import { ContainerRuntime } from '../../src/main/runtime/types';
import fs from 'fs';
import path from 'path';
import os from 'os';

function createMockRuntime(): ContainerRuntime {
  return {
    name: 'mock',
    composeUp: vi.fn().mockResolvedValue(undefined),
    composeDown: vi.fn().mockResolvedValue(undefined),
    listContainers: vi.fn().mockResolvedValue([
      {
        id: 'claude-container-1',
        name: 'sandstorm-proj-test-stack-claude-1',
        image: 'sandstorm-claude',
        status: 'running' as const,
        state: 'running',
        ports: [],
        labels: {},
        created: new Date().toISOString(),
      },
    ]),
    inspect: vi.fn(),
    logs: vi.fn(),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('Mock 1.0'),
  };
}

describe('StackManager', () => {
  let registry: Registry;
  let portAllocator: PortAllocator;
  let taskWatcher: TaskWatcher;
  let runtime: ContainerRuntime;
  let manager: StackManager;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `sandstorm-manager-test-${Date.now()}.db`);
    registry = new Registry(dbPath);
    runtime = createMockRuntime();
    portAllocator = new PortAllocator(registry, [40000, 40099]);
    taskWatcher = new TaskWatcher(registry, runtime, { pollInterval: 100 });
    manager = new StackManager(registry, portAllocator, taskWatcher, runtime);
  });

  afterEach(() => {
    taskWatcher.unwatchAll();
    registry.close();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(`${dbPath}-wal`);
      fs.unlinkSync(`${dbPath}-shm`);
    } catch {
      // ignore
    }
  });

  it('retrieves tasks for a stack', () => {
    registry.createStack({
      id: 'task-test',
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'up',
      runtime: 'docker',
    });
    registry.createTask('task-test', 'Task 1');
    registry.createTask('task-test', 'Task 2');

    const tasks = manager.getTasksForStack('task-test');
    expect(tasks).toHaveLength(2);
  });

  it('dispatches a task to a stack', async () => {
    registry.createStack({
      id: 'dispatch-test',
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'up',
      runtime: 'docker',
    });

    const task = await manager.dispatchTask('dispatch-test', 'Fix the bug');
    expect(task.prompt).toBe('Fix the bug');
    expect(task.status).toBe('running');

    // Should have written prompt and trigger to container
    const execFn = runtime.exec as ReturnType<typeof vi.fn>;
    expect(execFn).toHaveBeenCalled();
  });

  it('throws when dispatching to non-existent stack', async () => {
    await expect(
      manager.dispatchTask('nonexistent', 'task')
    ).rejects.toThrow('not found');
  });

  it('tears down a stack', async () => {
    registry.createStack({
      id: 'teardown-test',
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'up',
      runtime: 'docker',
    });

    await manager.teardownStack('teardown-test');
    expect(registry.getStack('teardown-test')).toBeUndefined();
    expect(runtime.composeDown).toHaveBeenCalled();
  });

  it('gets diff from claude container', async () => {
    registry.createStack({
      id: 'diff-test',
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'completed',
      runtime: 'docker',
    });

    (runtime.exec as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'diff --git a/file.txt b/file.txt\n+new line',
      stderr: '',
    });

    // Need to mock listContainers for findClaudeContainer
    (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: 'claude-1',
        name: 'sandstorm-proj-diff-test-claude-1',
        image: 'sandstorm-claude',
        status: 'running',
        state: 'running',
        ports: [],
        labels: {},
        created: new Date().toISOString(),
      },
    ]);

    const diff = await manager.getDiff('diff-test');
    expect(diff).toContain('+new line');
  });
});
