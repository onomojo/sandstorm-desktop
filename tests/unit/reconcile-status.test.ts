import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Registry } from '../../src/main/control-plane/registry';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import { ContainerRuntime, Container } from '../../src/main/runtime/types';
import {
  reconcileStack,
  readAgentState,
  performReconciliation,
  runStartupReconciliation,
  AgentStateResult,
} from '../../src/main/control-plane/reconcile-status';
import type { Stack, Task, StackStatus } from '../../src/main/control-plane/registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-reconcile-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

function makeStack(overrides: Partial<Stack> = {}): Stack {
  return {
    id: 'stack-1',
    project: 'proj',
    project_dir: '/proj',
    ticket: null,
    branch: null,
    description: null,
    status: 'running',
    error: null,
    pr_url: null,
    pr_number: null,
    runtime: 'docker',
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_execution_input_tokens: 0,
    total_execution_output_tokens: 0,
    total_review_input_tokens: 0,
    total_review_output_tokens: 0,
    rate_limit_reset_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    current_model: null,
    ...overrides,
  } as Stack;
}

function makeContainer(overrides: Partial<Container> = {}): Container {
  return {
    id: 'container-abc',
    name: 'sandstorm-proj-stack-1-claude-1',
    image: 'sandstorm-claude',
    status: 'running',
    state: 'running',
    ports: [],
    labels: {},
    created: new Date().toISOString(),
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    stack_id: 'stack-1',
    prompt: 'do the thing',
    model: null,
    resolved_model: null,
    status: 'running',
    exit_code: null,
    warnings: null,
    session_id: null,
    input_tokens: 0,
    output_tokens: 0,
    execution_input_tokens: 0,
    execution_output_tokens: 0,
    review_input_tokens: 0,
    review_output_tokens: 0,
    review_iterations: 0,
    verify_retries: 0,
    review_verdicts: null,
    verify_outputs: null,
    execution_summary: null,
    execution_started_at: null,
    execution_finished_at: null,
    review_started_at: null,
    review_finished_at: null,
    verify_started_at: null,
    verify_finished_at: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    resumed_at: null,
    ...overrides,
  } as Task;
}

function makeRuntime(overrides: Partial<ContainerRuntime> = {}): ContainerRuntime {
  return {
    name: 'mock',
    composeUp: vi.fn(),
    composeDown: vi.fn(),
    listContainers: vi.fn().mockResolvedValue([]),
    inspect: vi.fn(),
    logs: vi.fn().mockReturnValue({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
    containerStats: vi.fn(),
    exec: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' }),
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('Mock 1.0'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit tests: reconcileStack() pure function
// ---------------------------------------------------------------------------

describe('reconcileStack', () => {
  describe('container missing (null)', () => {
    it('orphans a running stack', () => {
      const action = reconcileStack(makeStack({ status: 'running' }), null, null, makeTask());
      expect(action).toEqual({ kind: 'orphan', finalStatus: 'failed' });
    });

    it('orphans a building stack', () => {
      const action = reconcileStack(makeStack({ status: 'building' }), null, null, undefined);
      expect(action).toEqual({ kind: 'orphan', finalStatus: 'failed' });
    });

    it('orphans an idle stack', () => {
      const action = reconcileStack(makeStack({ status: 'idle' }), null, null, undefined);
      expect(action).toEqual({ kind: 'orphan', finalStatus: 'failed' });
    });

    it('orphans session_paused stack with finalStatus=failed', () => {
      const action = reconcileStack(makeStack({ status: 'session_paused' }), null, null, undefined);
      expect(action).toEqual({ kind: 'orphan', finalStatus: 'failed' });
    });

    it('orphans rate_limited stack with finalStatus=failed', () => {
      const action = reconcileStack(makeStack({ status: 'rate_limited' }), null, null, undefined);
      expect(action).toEqual({ kind: 'orphan', finalStatus: 'failed' });
    });
  });

  describe('container not running (exited)', () => {
    const exitedContainer = makeContainer({ status: 'exited' });

    it('marks failed when running task exists', () => {
      const task = makeTask();
      const action = reconcileStack(makeStack({ status: 'running' }), exitedContainer, null, task);
      expect(action).toEqual({
        kind: 'update',
        newStatus: 'failed',
        taskUpdate: { taskId: 1, outcome: 'complete', exitCode: 1 },
      });
    });

    it('returns none when no running task', () => {
      const action = reconcileStack(makeStack({ status: 'up' }), exitedContainer, null, undefined);
      expect(action).toEqual({ kind: 'none' });
    });

    it('orphans session_paused stack with exited container', () => {
      const action = reconcileStack(makeStack({ status: 'session_paused' }), exitedContainer, null, undefined);
      expect(action).toEqual({ kind: 'orphan', finalStatus: 'failed' });
    });

    it('orphans rate_limited stack with exited container', () => {
      const action = reconcileStack(makeStack({ status: 'rate_limited' }), exitedContainer, null, undefined);
      expect(action).toEqual({ kind: 'orphan', finalStatus: 'failed' });
    });
  });

  describe('container running, agent still running', () => {
    const runningContainer = makeContainer({ status: 'running' });
    const runningAgentState: AgentStateResult = { status: 'running', exitCode: 0 };

    it('reattaches watcher when running task exists', () => {
      const task = makeTask();
      const action = reconcileStack(makeStack({ status: 'running' }), runningContainer, runningAgentState, task);
      expect(action).toEqual({ kind: 'reattach', containerId: 'container-abc' });
    });

    it('returns none when no running task (agent somehow still running)', () => {
      const action = reconcileStack(makeStack({ status: 'building' }), runningContainer, runningAgentState, undefined);
      expect(action).toEqual({ kind: 'none' });
    });
  });

  describe('container running, agent completed (exit 0)', () => {
    const runningContainer = makeContainer({ status: 'running' });
    const completedState: AgentStateResult = { status: 'completed', exitCode: 0 };

    it('updates stack and task to completed', () => {
      const task = makeTask();
      const action = reconcileStack(makeStack({ status: 'running' }), runningContainer, completedState, task);
      expect(action).toEqual({
        kind: 'update',
        newStatus: 'completed',
        taskUpdate: { taskId: 1, outcome: 'complete', exitCode: 0 },
      });
    });

    it('updates stack only when no running task', () => {
      const action = reconcileStack(makeStack({ status: 'running' }), runningContainer, completedState, undefined);
      expect(action).toEqual({ kind: 'update', newStatus: 'completed', taskUpdate: undefined });
    });
  });

  describe('container running, agent failed (exit 1)', () => {
    const runningContainer = makeContainer({ status: 'running' });
    const failedState: AgentStateResult = { status: 'failed', exitCode: 1 };

    it('updates stack and task to failed', () => {
      const task = makeTask();
      const action = reconcileStack(makeStack({ status: 'running' }), runningContainer, failedState, task);
      expect(action).toEqual({
        kind: 'update',
        newStatus: 'failed',
        taskUpdate: { taskId: 1, outcome: 'complete', exitCode: 1 },
      });
    });
  });

  describe('container running, agent needs_human', () => {
    const runningContainer = makeContainer({ status: 'running' });
    const needsHumanState: AgentStateResult = {
      status: 'needs_human',
      exitCode: 1,
      stopReason: 'Cannot proceed without clarification',
    };

    it('updates stack and task to needs_human with reason', () => {
      const task = makeTask();
      const action = reconcileStack(makeStack({ status: 'running' }), runningContainer, needsHumanState, task);
      expect(action).toEqual({
        kind: 'update',
        newStatus: 'needs_human',
        taskUpdate: {
          taskId: 1,
          outcome: 'needs_human',
          exitCode: 1,
          reason: 'Cannot proceed without clarification',
        },
      });
    });
  });

  describe('container running, agent verify_blocked_environmental', () => {
    const runningContainer = makeContainer({ status: 'running' });
    const envBlockedState: AgentStateResult = {
      status: 'verify_blocked_environmental',
      exitCode: 1,
      envReason: 'Verify blocked (environmental): missing binary',
    };

    it('updates stack and task to verify_blocked_environmental', () => {
      const task = makeTask();
      const action = reconcileStack(makeStack({ status: 'running' }), runningContainer, envBlockedState, task);
      expect(action).toEqual({
        kind: 'update',
        newStatus: 'verify_blocked_environmental',
        taskUpdate: {
          taskId: 1,
          outcome: 'verify_blocked_environmental',
          exitCode: 1,
          reason: 'Verify blocked (environmental): missing binary',
        },
      });
    });
  });

  describe('container running, agent state unreadable', () => {
    const runningContainer = makeContainer({ status: 'running' });

    it('returns none when running task exists (leave unchanged)', () => {
      const task = makeTask();
      const action = reconcileStack(makeStack({ status: 'running' }), runningContainer, null, task);
      expect(action).toEqual({ kind: 'none' });
    });

    it('normalizes to idle when no running task and status is building', () => {
      const action = reconcileStack(makeStack({ status: 'building' }), runningContainer, null, undefined);
      expect(action).toEqual({ kind: 'update', newStatus: 'idle' });
    });

    it('returns none when already idle and no running task', () => {
      const action = reconcileStack(makeStack({ status: 'idle' }), runningContainer, null, undefined);
      expect(action).toEqual({ kind: 'none' });
    });
  });

  describe('halted stacks (session_paused / rate_limited) with running container', () => {
    const runningContainer = makeContainer({ status: 'running' });
    const completedState: AgentStateResult = { status: 'completed', exitCode: 0 };

    it('leaves session_paused stack untouched even if agent is completed', () => {
      const action = reconcileStack(makeStack({ status: 'session_paused' }), runningContainer, completedState, undefined);
      expect(action).toEqual({ kind: 'none' });
    });

    it('leaves session_paused stack untouched when agent is running', () => {
      const runningState: AgentStateResult = { status: 'running', exitCode: 0 };
      const action = reconcileStack(makeStack({ status: 'session_paused' }), runningContainer, runningState, makeTask());
      expect(action).toEqual({ kind: 'none' });
    });

    it('leaves rate_limited stack untouched with running container', () => {
      const action = reconcileStack(makeStack({ status: 'rate_limited' }), runningContainer, completedState, undefined);
      expect(action).toEqual({ kind: 'none' });
    });
  });

  describe('task update never uses interrupted', () => {
    it('uses complete outcome (not interrupted) when container is exited with running task', () => {
      const task = makeTask();
      const exitedContainer = makeContainer({ status: 'exited' });
      const action = reconcileStack(makeStack({ status: 'running' }), exitedContainer, null, task);
      expect(action.kind).toBe('update');
      if (action.kind === 'update' && action.taskUpdate) {
        expect(action.taskUpdate.outcome).not.toBe('interrupted');
        expect(action.taskUpdate.outcome).toBe('complete');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Unit tests: readAgentState()
// ---------------------------------------------------------------------------

describe('readAgentState', () => {
  it('returns null when exec throws', async () => {
    const runtime = makeRuntime({
      exec: vi.fn().mockRejectedValue(new Error('container not running')),
    });
    const result = await readAgentState(runtime, 'ctr-1');
    expect(result).toBeNull();
  });

  it('returns null for unknown status value', async () => {
    const runtime = makeRuntime({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'unknown_value', stderr: '' }),
    });
    const result = await readAgentState(runtime, 'ctr-1');
    expect(result).toBeNull();
  });

  it('returns running status', async () => {
    const runtime = makeRuntime({
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'running', stderr: '' }),
    });
    const result = await readAgentState(runtime, 'ctr-1');
    expect(result?.status).toBe('running');
  });

  it('returns completed with exit code 0 from file', async () => {
    const runtime = makeRuntime({
      exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
        if (cmd.includes('/tmp/claude-task.status')) return { exitCode: 0, stdout: 'completed', stderr: '' };
        if (cmd.includes('/tmp/claude-task.exit')) return { exitCode: 0, stdout: '0', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    });
    const result = await readAgentState(runtime, 'ctr-1');
    expect(result).toEqual({ status: 'completed', exitCode: 0 });
  });

  it('returns failed with exit code from file', async () => {
    const runtime = makeRuntime({
      exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
        if (cmd.includes('/tmp/claude-task.status')) return { exitCode: 0, stdout: 'failed', stderr: '' };
        if (cmd.includes('/tmp/claude-task.exit')) return { exitCode: 0, stdout: '2', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    });
    const result = await readAgentState(runtime, 'ctr-1');
    expect(result).toEqual({ status: 'failed', exitCode: 2 });
  });

  it('returns needs_human with stop reason', async () => {
    const runtime = makeRuntime({
      exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
        if (cmd.includes('/tmp/claude-task.status')) return { exitCode: 0, stdout: 'needs_human', stderr: '' };
        if (cmd.includes('/tmp/claude-stop-reason.txt')) return { exitCode: 0, stdout: 'Custom stop reason', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    });
    const result = await readAgentState(runtime, 'ctr-1');
    expect(result).toEqual({ status: 'needs_human', exitCode: 1, stopReason: 'Custom stop reason' });
  });

  it('returns needs_human with default reason when stop file is empty', async () => {
    const runtime = makeRuntime({
      exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
        if (cmd.includes('/tmp/claude-task.status')) return { exitCode: 0, stdout: 'needs_human', stderr: '' };
        if (cmd.includes('/tmp/claude-stop-reason.txt')) return { exitCode: 0, stdout: '', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    });
    const result = await readAgentState(runtime, 'ctr-1');
    expect(result?.status).toBe('needs_human');
    expect(result?.stopReason).toContain('STOP_AND_ASK');
  });

  it('returns verify_blocked_environmental with env reason', async () => {
    const runtime = makeRuntime({
      exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
        if (cmd.includes('/tmp/claude-task.status')) return { exitCode: 0, stdout: 'verify_blocked_environmental', stderr: '' };
        if (cmd.includes('/tmp/claude-verify-environmental.txt')) return { exitCode: 0, stdout: 'missing node binary', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    });
    const result = await readAgentState(runtime, 'ctr-1');
    expect(result?.status).toBe('verify_blocked_environmental');
    expect(result?.envReason).toContain('missing node binary');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: performReconciliation()
// ---------------------------------------------------------------------------

describe('performReconciliation', () => {
  let registry: Registry;
  let dbPath: string;
  let tmpDir: string;
  let projectDir: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-int-'));
    projectDir = tmpDir;
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createWorkspace(stackId: string): string {
    const wsPath = path.join(projectDir, '.sandstorm', 'workspaces', stackId);
    fs.mkdirSync(wsPath, { recursive: true });
    return wsPath;
  }

  function createStackInRegistry(
    stackId: string,
    status: StackStatus,
  ) {
    return registry.createStack({
      id: stackId,
      project: 'testproj',
      project_dir: projectDir,
      ticket: null,
      branch: null,
      description: null,
      status,
      runtime: 'docker',
    });
  }

  function makeTaskWatcher(): TaskWatcher {
    const mockRuntime = makeRuntime();
    return new TaskWatcher(registry, mockRuntime, mockRuntime, { pollInterval: 100000 });
  }

  it('reconciles running stack with completed agent to completed status', async () => {
    const stackId = 'stack-completed';
    createWorkspace(stackId);
    createStackInRegistry(stackId, 'running');
    registry.createTask(stackId, 'test prompt');

    const runtime = makeRuntime({
      listContainers: vi.fn().mockResolvedValue([
        makeContainer({ id: 'ctr-1', status: 'running' }),
      ]),
      exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
        if (cmd.includes('/tmp/claude-task.status')) return { exitCode: 0, stdout: 'completed', stderr: '' };
        if (cmd.includes('/tmp/claude-task.exit')) return { exitCode: 0, stdout: '0', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    });

    const watcher = makeTaskWatcher();
    await performReconciliation(registry, runtime, runtime, watcher);

    const stack = registry.getStack(stackId);
    expect(stack?.status).toBe('completed');

    const tasks = registry.getTasksForStack(stackId);
    expect(tasks[0].status).toBe('completed');
    expect(tasks[0].exit_code).toBe(0);
    // Must NOT be interrupted
    expect(tasks[0].status).not.toBe('interrupted');
  });

  it('reconciles running stack with failed agent to failed status', async () => {
    const stackId = 'stack-failed';
    createWorkspace(stackId);
    createStackInRegistry(stackId, 'running');
    registry.createTask(stackId, 'test prompt');

    const runtime = makeRuntime({
      listContainers: vi.fn().mockResolvedValue([
        makeContainer({ id: 'ctr-1', status: 'running' }),
      ]),
      exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
        if (cmd.includes('/tmp/claude-task.status')) return { exitCode: 0, stdout: 'failed', stderr: '' };
        if (cmd.includes('/tmp/claude-task.exit')) return { exitCode: 0, stdout: '1', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    });

    const watcher = makeTaskWatcher();
    await performReconciliation(registry, runtime, runtime, watcher);

    const stack = registry.getStack(stackId);
    expect(stack?.status).toBe('failed');

    const tasks = registry.getTasksForStack(stackId);
    expect(tasks[0].status).toBe('failed');
    expect(tasks[0].status).not.toBe('interrupted');
  });

  it('reconciles running stack with needs_human agent', async () => {
    const stackId = 'stack-needs-human';
    createWorkspace(stackId);
    createStackInRegistry(stackId, 'running');
    registry.createTask(stackId, 'test prompt');

    const runtime = makeRuntime({
      listContainers: vi.fn().mockResolvedValue([
        makeContainer({ id: 'ctr-1', status: 'running' }),
      ]),
      exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
        if (cmd.includes('/tmp/claude-task.status')) return { exitCode: 0, stdout: 'needs_human', stderr: '' };
        if (cmd.includes('/tmp/claude-stop-reason.txt')) return { exitCode: 0, stdout: 'Need clarification on scope', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    });

    const watcher = makeTaskWatcher();
    await performReconciliation(registry, runtime, runtime, watcher);

    const stack = registry.getStack(stackId);
    expect(stack?.status).toBe('needs_human');

    const tasks = registry.getTasksForStack(stackId);
    expect(tasks[0].status).toBe('needs_human');
    expect(tasks[0].status).not.toBe('interrupted');
  });

  it('reattaches watcher for stack with still-running agent', async () => {
    const stackId = 'stack-still-running';
    createWorkspace(stackId);
    createStackInRegistry(stackId, 'running');
    registry.createTask(stackId, 'test prompt');

    const runtime = makeRuntime({
      listContainers: vi.fn().mockResolvedValue([
        makeContainer({ id: 'ctr-running', status: 'running' }),
      ]),
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'running', stderr: '' }),
    });

    const watcher = makeTaskWatcher();
    const watchSpy = vi.spyOn(watcher, 'watch');

    await performReconciliation(registry, runtime, runtime, watcher);

    // Watcher must be reattached
    expect(watchSpy).toHaveBeenCalledWith(stackId, 'ctr-running');

    // Stack should still be running (not changed to terminal)
    const stack = registry.getStack(stackId);
    expect(stack?.status).toBe('running');

    watcher.unwatchAll();
  });

  it('orphans stack when container is missing — removes from stacks, writes stack_history', async () => {
    const stackId = 'stack-orphaned';
    createWorkspace(stackId);
    createStackInRegistry(stackId, 'running');
    registry.createTask(stackId, 'test prompt');

    const runtime = makeRuntime({
      listContainers: vi.fn().mockResolvedValue([]), // No containers
    });

    const watcher = makeTaskWatcher();
    await performReconciliation(registry, runtime, runtime, watcher);

    // Stack must be removed from active stacks
    expect(registry.getStack(stackId)).toBeUndefined();

    // stack_history must have a row
    const history = registry.listStackHistory();
    expect(history.some((h) => h.stack_id === stackId)).toBe(true);

    // Workspace dir must still exist (not auto-deleted)
    expect(fs.existsSync(path.join(projectDir, '.sandstorm', 'workspaces', stackId))).toBe(true);
  });

  it('orphans stack when workspace directory is missing', async () => {
    const stackId = 'stack-no-workspace';
    // Do NOT create workspace dir
    createStackInRegistry(stackId, 'running');
    registry.createTask(stackId, 'test prompt');

    const runtime = makeRuntime({
      listContainers: vi.fn().mockResolvedValue([
        makeContainer({ id: 'ctr-1', status: 'running' }),
      ]),
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'completed', stderr: '' }),
    });

    const watcher = makeTaskWatcher();
    await performReconciliation(registry, runtime, runtime, watcher);

    expect(registry.getStack(stackId)).toBeUndefined();
    const history = registry.listStackHistory();
    expect(history.some((h) => h.stack_id === stackId)).toBe(true);
  });

  it('leaves session_paused stack untouched when container is running', async () => {
    const stackId = 'stack-paused';
    createWorkspace(stackId);
    createStackInRegistry(stackId, 'session_paused');

    const runtime = makeRuntime({
      listContainers: vi.fn().mockResolvedValue([
        makeContainer({ id: 'ctr-1', status: 'running' }),
      ]),
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'running', stderr: '' }),
    });

    const watcher = makeTaskWatcher();
    await performReconciliation(registry, runtime, runtime, watcher);

    const stack = registry.getStack(stackId);
    expect(stack?.status).toBe('session_paused');
  });

  it('orphans session_paused stack when container is exited', async () => {
    const stackId = 'stack-paused-exited';
    createWorkspace(stackId);
    createStackInRegistry(stackId, 'session_paused');

    const runtime = makeRuntime({
      listContainers: vi.fn().mockResolvedValue([
        makeContainer({ id: 'ctr-1', status: 'exited' }),
      ]),
    });

    const watcher = makeTaskWatcher();
    await performReconciliation(registry, runtime, runtime, watcher);

    expect(registry.getStack(stackId)).toBeUndefined();
    const history = registry.listStackHistory();
    expect(history.some((h) => h.stack_id === stackId)).toBe(true);
  });

  it('leaves rate_limited stack untouched when container is running', async () => {
    const stackId = 'stack-rate-limited';
    createWorkspace(stackId);
    createStackInRegistry(stackId, 'rate_limited');

    const runtime = makeRuntime({
      listContainers: vi.fn().mockResolvedValue([
        makeContainer({ id: 'ctr-1', status: 'running' }),
      ]),
    });

    const watcher = makeTaskWatcher();
    await performReconciliation(registry, runtime, runtime, watcher);

    const stack = registry.getStack(stackId);
    expect(stack?.status).toBe('rate_limited');
  });

  it('handles container exited with running task — marks failed', async () => {
    const stackId = 'stack-exited-ctr';
    createWorkspace(stackId);
    createStackInRegistry(stackId, 'running');
    registry.createTask(stackId, 'test prompt');

    const runtime = makeRuntime({
      listContainers: vi.fn().mockResolvedValue([
        makeContainer({ id: 'ctr-1', status: 'exited' }),
      ]),
    });

    const watcher = makeTaskWatcher();
    await performReconciliation(registry, runtime, runtime, watcher);

    const stack = registry.getStack(stackId);
    expect(stack?.status).toBe('failed');

    const tasks = registry.getTasksForStack(stackId);
    expect(tasks[0].status).toBe('failed');
    expect(tasks[0].status).not.toBe('interrupted');
  });

  it('skips stack when container list throws — leaves status unchanged', async () => {
    const stackId = 'stack-error';
    createWorkspace(stackId);
    createStackInRegistry(stackId, 'running');

    const runtime = makeRuntime({
      listContainers: vi.fn().mockRejectedValue(new Error('Docker daemon not available')),
    });

    const watcher = makeTaskWatcher();
    await performReconciliation(registry, runtime, runtime, watcher);

    // Status must remain unchanged
    const stack = registry.getStack(stackId);
    expect(stack?.status).toBe('running');
  });

  it('processes multiple stacks independently', async () => {
    const completedId = 'stack-multi-1';
    const orphanId = 'stack-multi-2';

    createWorkspace(completedId);
    createWorkspace(orphanId);
    createStackInRegistry(completedId, 'running');
    createStackInRegistry(orphanId, 'running');
    registry.createTask(completedId, 'task 1');
    registry.createTask(orphanId, 'task 2');

    const runtime = makeRuntime({
      listContainers: vi.fn().mockImplementation(async (filter: { name?: string }) => {
        if (filter?.name?.includes(completedId)) {
          return [makeContainer({ id: 'ctr-completed', status: 'running' })];
        }
        if (filter?.name?.includes(orphanId)) {
          return []; // missing container → orphan
        }
        return [];
      }),
      exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
        if (cmd.includes('/tmp/claude-task.status')) return { exitCode: 0, stdout: 'completed', stderr: '' };
        if (cmd.includes('/tmp/claude-task.exit')) return { exitCode: 0, stdout: '0', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    });

    const watcher = makeTaskWatcher();
    await performReconciliation(registry, runtime, runtime, watcher);

    const completedStack = registry.getStack(completedId);
    expect(completedStack?.status).toBe('completed');

    // Orphaned stack must be removed
    expect(registry.getStack(orphanId)).toBeUndefined();
    const history = registry.listStackHistory();
    expect(history.some((h) => h.stack_id === orphanId)).toBe(true);
  });

  it('reconciles building stack with running container and no task → sets idle', async () => {
    const stackId = 'stack-building';
    createWorkspace(stackId);
    createStackInRegistry(stackId, 'building');

    const runtime = makeRuntime({
      listContainers: vi.fn().mockResolvedValue([
        makeContainer({ id: 'ctr-1', status: 'running' }),
      ]),
      exec: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' }), // no status file
    });

    const watcher = makeTaskWatcher();
    await performReconciliation(registry, runtime, runtime, watcher);

    const stack = registry.getStack(stackId);
    expect(stack?.status).toBe('idle');
  });

  it('reconciles running stack with verify_blocked_environmental agent', async () => {
    const stackId = 'stack-env-blocked';
    createWorkspace(stackId);
    createStackInRegistry(stackId, 'running');
    registry.createTask(stackId, 'test prompt');

    const runtime = makeRuntime({
      listContainers: vi.fn().mockResolvedValue([
        makeContainer({ id: 'ctr-1', status: 'running' }),
      ]),
      exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
        if (cmd.includes('/tmp/claude-task.status')) return { exitCode: 0, stdout: 'verify_blocked_environmental', stderr: '' };
        if (cmd.includes('/tmp/claude-verify-environmental.txt')) return { exitCode: 0, stdout: 'missing node binary', stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    });

    const watcher = makeTaskWatcher();
    await performReconciliation(registry, runtime, runtime, watcher);

    const stack = registry.getStack(stackId);
    expect(stack?.status).toBe('verify_blocked_environmental');

    const tasks = registry.getTasksForStack(stackId);
    // task-watcher uses needs_human for the task row in this case (verify_blocked_environmental
    // is reflected on the stack; the task row uses needs_human to indicate human intervention needed)
    expect(tasks[0].status).toBe('needs_human');
    expect(tasks[0].status).not.toBe('interrupted');
  });

  it('orphans rate_limited stack when container is exited', async () => {
    const stackId = 'stack-rate-limited-exited';
    createWorkspace(stackId);
    createStackInRegistry(stackId, 'rate_limited');

    const runtime = makeRuntime({
      listContainers: vi.fn().mockResolvedValue([
        makeContainer({ id: 'ctr-1', status: 'exited' }),
      ]),
    });

    const watcher = makeTaskWatcher();
    await performReconciliation(registry, runtime, runtime, watcher);

    expect(registry.getStack(stackId)).toBeUndefined();
    const history = registry.listStackHistory();
    expect(history.some((h) => h.stack_id === stackId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: runStartupReconciliation()
// ---------------------------------------------------------------------------

describe('runStartupReconciliation', () => {
  it('emits docker:startup-unavailable and skips reconciliation when Docker is unreachable', async () => {
    const mockReconcile = vi.fn();
    const mockEmit = vi.fn();
    const runtime = makeRuntime({
      isAvailable: vi.fn().mockResolvedValue(false),
    });

    await runStartupReconciliation(runtime, mockReconcile, mockEmit);

    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockEmit).toHaveBeenCalledWith('docker:startup-unavailable');
    expect(mockEmit).not.toHaveBeenCalledWith('stacks:updated');
  });

  it('emits docker:startup-unavailable and skips reconciliation when isAvailable throws', async () => {
    const mockReconcile = vi.fn();
    const mockEmit = vi.fn();
    const runtime = makeRuntime({
      isAvailable: vi.fn().mockRejectedValue(new Error('connection refused')),
    });

    await runStartupReconciliation(runtime, mockReconcile, mockEmit);

    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockEmit).toHaveBeenCalledWith('docker:startup-unavailable');
  });

  it('runs reconciliation and emits stacks:updated when Docker is available', async () => {
    const mockReconcile = vi.fn().mockResolvedValue(undefined);
    const mockEmit = vi.fn();
    const runtime = makeRuntime({
      isAvailable: vi.fn().mockResolvedValue(true),
    });

    await runStartupReconciliation(runtime, mockReconcile, mockEmit);

    expect(mockReconcile).toHaveBeenCalledOnce();
    expect(mockEmit).toHaveBeenCalledWith('stacks:updated');
    expect(mockEmit).not.toHaveBeenCalledWith('docker:startup-unavailable');
  });

  it('skips docker:startup-unavailable when Docker is unreachable but no stacks need reconciliation', async () => {
    const mockReconcile = vi.fn();
    const mockEmit = vi.fn();
    const runtime = makeRuntime({
      isAvailable: vi.fn().mockResolvedValue(false),
    });

    await runStartupReconciliation(runtime, mockReconcile, mockEmit, () => false);

    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalledWith('docker:startup-unavailable');
    expect(mockEmit).not.toHaveBeenCalledWith('stacks:updated');
  });

  it('still emits docker:startup-unavailable when Docker is unreachable and stacks exist', async () => {
    const mockReconcile = vi.fn();
    const mockEmit = vi.fn();
    const runtime = makeRuntime({
      isAvailable: vi.fn().mockResolvedValue(false),
    });

    await runStartupReconciliation(runtime, mockReconcile, mockEmit, () => true);

    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockEmit).toHaveBeenCalledWith('docker:startup-unavailable');
  });
});
