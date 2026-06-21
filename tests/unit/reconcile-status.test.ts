import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  StackManager,
} from '../../src/main/control-plane/stack-manager';
import { Registry } from '../../src/main/control-plane/registry';
import { PortAllocator } from '../../src/main/control-plane/port-allocator';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import { ContainerRuntime } from '../../src/main/runtime/types';
import { makeFakeContainerRuntime } from '../helpers/fake-container-runtime';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDb(): string {
  return path.join(
    os.tmpdir(),
    `sandstorm-reconcile-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

function createMockRuntime(containerStatus = 'running'): ContainerRuntime {
  return makeFakeContainerRuntime({
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
    exec: vi.fn().mockImplementation((_id: string, cmd: string[]) => {
      const file = cmd[cmd.length - 1];
      if (file === '/tmp/claude-task.status') {
        return Promise.resolve({ exitCode: 0, stdout: containerStatus, stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }),
  });
}

describe('StackManager.reconcileStatus', () => {
  let registry: Registry;
  let portAllocator: PortAllocator;
  let taskWatcher: TaskWatcher;
  let runtime: ContainerRuntime;
  let manager: StackManager;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    runtime = createMockRuntime('needs_human');
    portAllocator = new PortAllocator(registry, [40000, 40099]);
    taskWatcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 100 });
    manager = new StackManager(registry, portAllocator, taskWatcher, runtime, runtime, '/fake/cli');
  });

  afterEach(() => {
    taskWatcher.unwatchAll();
    registry.close();
    cleanupDb(dbPath);
  });

  function makeRegistryStack(status: string = 'completed') {
    const stack = registry.createStack({
      id: 'test-stack',
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: status as any,
      runtime: 'docker',
    });
    return stack;
  }

  function makeRegistryTask(stackId: string = 'test-stack') {
    return registry.createTask(stackId, 'test prompt');
  }

  // --- Guard tests ---

  it('returns guarded for session_paused stack without touching registry', async () => {
    makeRegistryStack('session_paused');
    const updateSpy = vi.spyOn(registry, 'updateStackStatus');

    const result = await manager.reconcileStatus('test-stack');

    expect(result.outcome).toBe('guarded');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('returns guarded for rate_limited stack without touching registry', async () => {
    makeRegistryStack('rate_limited');
    const updateSpy = vi.spyOn(registry, 'updateStackStatus');

    const result = await manager.reconcileStatus('test-stack');

    expect(result.outcome).toBe('guarded');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  // --- container_gone tests ---

  it('returns container_gone when listContainers throws', async () => {
    makeRegistryStack('completed');
    vi.mocked(runtime.listContainers).mockRejectedValueOnce(new Error('Docker down'));

    const result = await manager.reconcileStatus('test-stack');
    expect(result.outcome).toBe('container_gone');
  });

  it('returns container_gone when no containers found', async () => {
    makeRegistryStack('completed');
    vi.mocked(runtime.listContainers).mockResolvedValueOnce([]);

    const result = await manager.reconcileStatus('test-stack');
    expect(result.outcome).toBe('container_gone');
  });

  it('returns container_gone when container is not running', async () => {
    makeRegistryStack('completed');
    vi.mocked(runtime.listContainers).mockResolvedValueOnce([
      {
        id: 'c1',
        name: 'test',
        image: 'img',
        status: 'exited' as any,
        state: 'exited',
        ports: [],
        labels: {},
        created: new Date().toISOString(),
      },
    ]);

    const result = await manager.reconcileStatus('test-stack');
    expect(result.outcome).toBe('container_gone');
  });

  it('returns container_gone when exec of status file throws', async () => {
    makeRegistryStack('completed');
    vi.mocked(runtime.exec).mockRejectedValueOnce(new Error('exec failed'));

    const result = await manager.reconcileStatus('test-stack');
    expect(result.outcome).toBe('container_gone');
  });

  // --- needs_human mapping ---

  it('reconciles completed→needs_human via completeTaskNeedsHuman', async () => {
    makeRegistryStack('completed');
    const task = makeRegistryTask();
    registry.completeTask(task.id, 0); // mark task completed to simulate stale state

    vi.mocked(runtime.exec).mockImplementation((_id, cmd) => {
      const file = cmd[cmd.length - 1];
      if (file === '/tmp/claude-task.status') return Promise.resolve({ exitCode: 0, stdout: 'needs_human', stderr: '' });
      if (file === '/tmp/claude-stop-reason.txt') return Promise.resolve({ exitCode: 0, stdout: 'Human review required', stderr: '' });
      if (file === '/tmp/claude-stop-questions.json') return Promise.resolve({ exitCode: 0, stdout: '[{"id":"q1","question":"What to do?","options":[]}]', stderr: '' });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const result = await manager.reconcileStatus('test-stack');

    expect(result.outcome).toBe('reconciled');
    expect(result.status).toBe('needs_human');
    expect(registry.getStack('test-stack')!.status).toBe('needs_human');
    const updatedTask = registry.getMostRecentTask('test-stack');
    expect(updatedTask?.status).toBe('needs_human');
    expect(updatedTask?.warnings).toBe('Human review required');
  });

  it('reads questions JSON for needs_human and stores them', async () => {
    makeRegistryStack('completed');
    const task = makeRegistryTask();
    registry.completeTask(task.id, 0);

    const questionsJson = '[{"id":"q1","question":"Proceed?","options":[{"id":"yes","label":"Yes"}]}]';
    vi.mocked(runtime.exec).mockImplementation((_id, cmd) => {
      const file = cmd[cmd.length - 1];
      if (file === '/tmp/claude-task.status') return Promise.resolve({ exitCode: 0, stdout: 'needs_human', stderr: '' });
      if (file === '/tmp/claude-stop-questions.json') return Promise.resolve({ exitCode: 0, stdout: questionsJson, stderr: '' });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    await manager.reconcileStatus('test-stack');

    const questions = registry.getNeedsHumanQuestions('test-stack');
    expect(questions).toBe(questionsJson);
  });

  it('reconciles via updateStackStatus when no task exists for needs_human', async () => {
    makeRegistryStack('completed');

    vi.mocked(runtime.exec).mockImplementation((_id, cmd) => {
      const file = cmd[cmd.length - 1];
      if (file === '/tmp/claude-task.status') return Promise.resolve({ exitCode: 0, stdout: 'needs_human', stderr: '' });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const result = await manager.reconcileStatus('test-stack');

    expect(result.outcome).toBe('reconciled');
    expect(result.status).toBe('needs_human');
    expect(registry.getStack('test-stack')!.status).toBe('needs_human');
  });

  // --- unknown mapping ---

  it('maps unknown container status to needs_human', async () => {
    makeRegistryStack('completed');
    const task = makeRegistryTask();
    registry.completeTask(task.id, 0);

    vi.mocked(runtime.exec).mockImplementation((_id, cmd) => {
      const file = cmd[cmd.length - 1];
      if (file === '/tmp/claude-task.status') return Promise.resolve({ exitCode: 0, stdout: 'unknown', stderr: '' });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const result = await manager.reconcileStatus('test-stack');

    expect(result.outcome).toBe('reconciled');
    expect(result.status).toBe('needs_human');
    expect(registry.getStack('test-stack')!.status).toBe('needs_human');
    const updatedTask = registry.getMostRecentTask('test-stack');
    expect(updatedTask?.warnings).toContain('unknown state');
  });

  // --- needs_key mapping ---

  it('maps needs_key container status to needs_key stack status', async () => {
    makeRegistryStack('completed');
    const task = makeRegistryTask();
    registry.completeTask(task.id, 0);

    vi.mocked(runtime.exec).mockImplementation((_id, cmd) => {
      const file = cmd[cmd.length - 1];
      if (file === '/tmp/claude-task.status') return Promise.resolve({ exitCode: 0, stdout: 'needs_key', stderr: '' });
      if (file === '/tmp/claude-task-needs-key.txt') return Promise.resolve({ exitCode: 0, stdout: 'Missing GITHUB_TOKEN', stderr: '' });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const result = await manager.reconcileStatus('test-stack');

    expect(result.outcome).toBe('reconciled');
    expect(result.status).toBe('needs_key');
    expect(registry.getStack('test-stack')!.status).toBe('needs_key');
    const updatedTask = registry.getMostRecentTask('test-stack');
    expect(updatedTask?.status).toBe('needs_key');
    expect(updatedTask?.warnings).toBe('Missing GITHUB_TOKEN');
  });

  // --- verify_blocked_environmental mapping ---

  it('maps verify_blocked_environmental to verify_blocked_environmental stack status', async () => {
    makeRegistryStack('completed');
    const task = makeRegistryTask();
    registry.completeTask(task.id, 0);

    vi.mocked(runtime.exec).mockImplementation((_id, cmd) => {
      const file = cmd[cmd.length - 1];
      if (file === '/tmp/claude-task.status') return Promise.resolve({ exitCode: 0, stdout: 'verify_blocked_environmental', stderr: '' });
      if (file === '/tmp/claude-verify-environmental.txt') return Promise.resolve({ exitCode: 0, stdout: 'pg_dump not found', stderr: '' });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const result = await manager.reconcileStatus('test-stack');

    expect(result.outcome).toBe('reconciled');
    expect(result.status).toBe('verify_blocked_environmental');
    expect(registry.getStack('test-stack')!.status).toBe('verify_blocked_environmental');
    const updatedTask = registry.getMostRecentTask('test-stack');
    expect(updatedTask?.status).toBe('needs_human');
    expect(updatedTask?.warnings).toContain('pg_dump not found');
  });

  // --- token_limited mapping ---

  it('maps token_limited to session_paused', async () => {
    makeRegistryStack('completed');

    vi.mocked(runtime.exec).mockImplementation((_id, cmd) => {
      const file = cmd[cmd.length - 1];
      if (file === '/tmp/claude-task.status') return Promise.resolve({ exitCode: 0, stdout: 'token_limited', stderr: '' });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const result = await manager.reconcileStatus('test-stack');

    expect(result.outcome).toBe('reconciled');
    expect(result.status).toBe('session_paused');
    expect(registry.getStack('test-stack')!.status).toBe('session_paused');
  });

  // --- completed / failed mapping ---

  it('maps completed container status to completed stack with exit code 0', async () => {
    makeRegistryStack('pushed');
    const task = makeRegistryTask();
    registry.completeTask(task.id, 0);

    vi.mocked(runtime.exec).mockImplementation((_id, cmd) => {
      const file = cmd[cmd.length - 1];
      if (file === '/tmp/claude-task.status') return Promise.resolve({ exitCode: 0, stdout: 'completed', stderr: '' });
      if (file === '/tmp/claude-task.exit') return Promise.resolve({ exitCode: 0, stdout: '0', stderr: '' });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const result = await manager.reconcileStatus('test-stack');

    expect(result.outcome).toBe('reconciled');
    expect(result.status).toBe('completed');
    expect(registry.getStack('test-stack')!.status).toBe('completed');
  });

  it('maps failed container status to failed stack with non-zero exit code', async () => {
    makeRegistryStack('completed');
    const task = makeRegistryTask();
    registry.completeTask(task.id, 0);

    vi.mocked(runtime.exec).mockImplementation((_id, cmd) => {
      const file = cmd[cmd.length - 1];
      if (file === '/tmp/claude-task.status') return Promise.resolve({ exitCode: 0, stdout: 'failed', stderr: '' });
      if (file === '/tmp/claude-task.exit') return Promise.resolve({ exitCode: 0, stdout: '2', stderr: '' });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const result = await manager.reconcileStatus('test-stack');

    expect(result.outcome).toBe('reconciled');
    expect(result.status).toBe('failed');
    expect(registry.getStack('test-stack')!.status).toBe('failed');
    const updatedTask = registry.getMostRecentTask('test-stack');
    expect(updatedTask?.exit_code).toBe(2);
  });

  // --- running mapping ---

  it('maps running container status: reopens task and starts watcher', async () => {
    makeRegistryStack('completed');
    const task = makeRegistryTask();
    registry.completeTask(task.id, 0); // mark completed (stale)

    vi.mocked(runtime.exec).mockImplementation((_id, cmd) => {
      const file = cmd[cmd.length - 1];
      if (file === '/tmp/claude-task.status') return Promise.resolve({ exitCode: 0, stdout: 'running', stderr: '' });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const watchSpy = vi.spyOn(taskWatcher, 'watch');

    const result = await manager.reconcileStatus('test-stack');

    expect(result.outcome).toBe('reconciled');
    expect(result.status).toBe('running');
    expect(registry.getStack('test-stack')!.status).toBe('running');
    expect(watchSpy).toHaveBeenCalledWith('test-stack', 'claude-container-1');
    const updatedTask = registry.getMostRecentTask('test-stack');
    expect(updatedTask?.status).toBe('running');
  });

  // --- idempotency ---

  it('is idempotent when stack already has correct status (needs_human→needs_human)', async () => {
    makeRegistryStack('needs_human');
    const task = makeRegistryTask();
    // Simulate task already in needs_human state
    registry.completeTaskNeedsHuman(task.id, 'Prior stop', null);

    vi.mocked(runtime.exec).mockImplementation((_id, cmd) => {
      const file = cmd[cmd.length - 1];
      if (file === '/tmp/claude-task.status') return Promise.resolve({ exitCode: 0, stdout: 'needs_human', stderr: '' });
      if (file === '/tmp/claude-stop-reason.txt') return Promise.resolve({ exitCode: 0, stdout: 'Prior stop', stderr: '' });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const result = await manager.reconcileStatus('test-stack');
    expect(result.outcome).toBe('reconciled');
    expect(result.status).toBe('needs_human');
    expect(registry.getStack('test-stack')!.status).toBe('needs_human');
  });

  // --- unrecognized status ---

  it('treats unrecognized container status as needs_human', async () => {
    makeRegistryStack('completed');
    const task = makeRegistryTask();
    registry.completeTask(task.id, 0);

    vi.mocked(runtime.exec).mockImplementation((_id, cmd) => {
      const file = cmd[cmd.length - 1];
      if (file === '/tmp/claude-task.status') return Promise.resolve({ exitCode: 0, stdout: 'totally_unknown_state', stderr: '' });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });

    const result = await manager.reconcileStatus('test-stack');
    expect(result.outcome).toBe('reconciled');
    expect(result.status).toBe('needs_human');
    expect(registry.getStack('test-stack')!.status).toBe('needs_human');
    const updatedTask = registry.getMostRecentTask('test-stack');
    expect(updatedTask?.warnings).toContain('totally_unknown_state');
  });

  // --- throws when stack not found ---

  it('throws STACK_NOT_FOUND when stack does not exist', async () => {
    await expect(manager.reconcileStatus('nonexistent')).rejects.toThrow(/not found/i);
  });
});
