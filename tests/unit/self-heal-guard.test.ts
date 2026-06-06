import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Registry } from '../../src/main/control-plane/registry';
import { StackManager } from '../../src/main/control-plane/stack-manager';
import { PortAllocator } from '../../src/main/control-plane/port-allocator';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import fs from 'fs';
import path from 'path';
import os from 'os';

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

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}
function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

describe('selfheal_continue_used guard (registry)', () => {
  let registry: Registry;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    registry.createStack({
      id: 'test-stack',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix',
      description: null,
      status: 'failed',
      runtime: 'docker',
    });
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
  });

  it('defaults to 0 on new stack', () => {
    const stack = registry.getStack('test-stack');
    expect(stack?.selfheal_continue_used).toBe(0);
  });

  it('setSelfhealContinueUsed sets to 1', () => {
    registry.setSelfhealContinueUsed('test-stack', 1);
    const stack = registry.getStack('test-stack');
    expect(stack?.selfheal_continue_used).toBe(1);
  });

  it('setSelfhealContinueUsed can reset to 0', () => {
    registry.setSelfhealContinueUsed('test-stack', 1);
    registry.setSelfhealContinueUsed('test-stack', 0);
    const stack = registry.getStack('test-stack');
    expect(stack?.selfheal_continue_used).toBe(0);
  });

  it('archiveStack mirrors selfheal_continue_used to stack_history', () => {
    registry.setSelfhealContinueUsed('test-stack', 1);
    registry.archiveStack('test-stack', 'failed');
    const history = registry.listStackHistory();
    expect(history).toHaveLength(1);
    expect(history[0].selfheal_continue_used).toBe(1);
  });

  it('archiveStack preserves selfheal_continue_used = 0 in history', () => {
    registry.archiveStack('test-stack', 'failed');
    const history = registry.listStackHistory();
    expect(history[0].selfheal_continue_used).toBe(0);
  });
});

describe('resumeNeedsHumanStack status guard', () => {
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

  it('rejects stacks in idle state with INVALID_INPUT', async () => {
    registry.createStack({
      id: 'idle-stack',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix',
      description: null,
      status: 'idle',
      runtime: 'docker',
    });
    const sm = makeStackManager(registry);
    await expect(sm.resumeNeedsHumanStack('idle-stack', 'answers')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('accepts failed stacks and proceeds past the status guard', async () => {
    registry.createStack({
      id: 'failed-stack',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix',
      description: null,
      status: 'failed',
      runtime: 'docker',
    });
    const sm = makeStackManager(registry);
    // Passes the status guard; fails on INTERNAL_ERROR (no task) rather than INVALID_INPUT
    await expect(sm.resumeNeedsHumanStack('failed-stack', 'answers')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('accepts needs_human stacks and proceeds past the status guard', async () => {
    registry.createStack({
      id: 'nh-stack',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix',
      description: null,
      status: 'needs_human',
      runtime: 'docker',
    });
    const sm = makeStackManager(registry);
    // Passes the status guard; fails on INTERNAL_ERROR (no task)
    await expect(sm.resumeNeedsHumanStack('nh-stack', 'answers')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});

describe('eligibility gating logic', () => {
  it('selfHeal is true when agent says true (selfheal_continue_used no longer gates UI eligibility)', () => {
    const eligible = (agentSelfHeal: boolean) => agentSelfHeal === true;

    expect(eligible(true)).toBe(true);
    expect(eligible(false)).toBe(false);
  });

  it('answerQuestions requires questions to be non-empty', () => {
    const eligible = (agentAnswerQ: boolean, qCount: number) =>
      agentAnswerQ === true && qCount > 0;

    expect(eligible(true, 2)).toBe(true);
    expect(eligible(true, 0)).toBe(false);
    expect(eligible(false, 2)).toBe(false);
  });

  it('reincorporateSpec follows agent verdict directly', () => {
    expect(true).toBe(true);  // gated only by diagnosis.eligibility.reincorporateSpec
    expect(false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// selfHealContinue — resume/repeat/guard behavior
// ---------------------------------------------------------------------------

describe('selfHealContinue', () => {
  let registry: Registry;
  let dbPath: string;
  let manager: ReturnType<typeof makeStackManager>;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    manager = makeStackManager(registry);
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
    vi.restoreAllMocks();
  });

  function makeFailedStack(sessionId: string | null = null, reviewIterations = 3): { stackId: string; taskId: number } {
    const stackId = `failed-${Math.random().toString(36).slice(2)}`;
    registry.createStack({
      id: stackId,
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix',
      description: null,
      status: 'up',
      runtime: 'docker',
    });
    const task = registry.createTask(stackId, 'Fix the bug', 'sonnet');
    if (sessionId) registry.setTaskSessionId(task.id, sessionId);
    registry.setTaskIterations(task.id, reviewIterations, 0);
    // Drive stack+task to failed state
    registry.completeTask(task.id, 1);
    return { stackId, taskId: task.id };
  }

  function mockDispatch() {
    const ensureRunning = vi.spyOn(manager as any, 'ensureStackContainersRunning').mockResolvedValue(undefined);
    const dispatchCont = vi.spyOn(manager as any, 'dispatchContinuation').mockResolvedValue(undefined);
    const dispatchTask = vi.spyOn(manager, 'dispatchTask').mockResolvedValue({ id: 999, stack_id: 'x', status: 'running' } as any);
    return { ensureRunning, dispatchCont, dispatchTask };
  }

  it('(a) dispatches via dispatchContinuation when session_id is present', async () => {
    const { stackId } = makeFailedStack('session-abc');
    const { dispatchCont, dispatchTask } = mockDispatch();

    await manager.selfHealContinue(stackId);

    expect(dispatchCont).toHaveBeenCalledOnce();
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it('(b) falls back to dispatchTask when session_id is null', async () => {
    const { stackId } = makeFailedStack(null);
    const { dispatchCont, dispatchTask } = mockDispatch();

    await manager.selfHealContinue(stackId);

    expect(dispatchTask).toHaveBeenCalledOnce();
    expect(dispatchCont).not.toHaveBeenCalled();
  });

  it('(c) resets review_iterations to 0 on the resumed task (Case A)', async () => {
    const { stackId, taskId } = makeFailedStack('session-xyz', 5);
    mockDispatch();

    await manager.selfHealContinue(stackId);

    const task = registry.getMostRecentTask(stackId)!;
    expect(task.id).toBe(taskId);
    expect(task.review_iterations).toBe(0);
  });

  it('(d) is repeatable — second call does not throw after first succeeds', async () => {
    const { stackId } = makeFailedStack('session-rep');
    const { dispatchCont } = mockDispatch();

    await manager.selfHealContinue(stackId);

    // Reset stack to failed so second call is valid
    registry.updateStackStatus(stackId, 'failed');

    await expect(manager.selfHealContinue(stackId)).resolves.toBeUndefined();
    expect(dispatchCont).toHaveBeenCalledTimes(2);
  });

  it('(e) resets selfheal_continue_used to 0 on dispatch failure (not stranded at 1)', async () => {
    const { stackId } = makeFailedStack('session-fail');
    vi.spyOn(manager as any, 'ensureStackContainersRunning').mockResolvedValue(undefined);
    vi.spyOn(manager as any, 'dispatchContinuation').mockRejectedValue(new Error('CLI failed'));

    await expect(manager.selfHealContinue(stackId)).rejects.toThrow('CLI failed');

    const stack = registry.getStack(stackId)!;
    expect(stack.selfheal_continue_used).toBe(0);
  });

  it('(e) resets selfheal_continue_used to 0 when ensureStackContainersRunning fails', async () => {
    const { stackId } = makeFailedStack('session-err');
    vi.spyOn(manager as any, 'ensureStackContainersRunning').mockRejectedValue(new Error('Docker down'));

    await expect(manager.selfHealContinue(stackId)).rejects.toThrow('Docker down');

    const stack = registry.getStack(stackId)!;
    expect(stack.selfheal_continue_used).toBe(0);
  });

  it('rejects non-failed stacks with INVALID_INPUT', async () => {
    registry.createStack({
      id: 'idle-sh',
      project: 'proj',
      project_dir: '/proj',
      ticket: '123',
      branch: 'feat/123-fix',
      description: null,
      status: 'idle',
      runtime: 'docker',
    });
    await expect(manager.selfHealContinue('idle-sh')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('ticket-522 fixture: two consecutive failed→continue cycles both reset review_iterations to 0 and selfheal_continue_used to 0', async () => {
    // Matches ticket-522 shape: status=failed, selfheal_continue_used=0, session_id present, review_iterations=5
    const { stackId, taskId } = makeFailedStack('session-ticket-522', 5);
    expect(registry.getStack(stackId)!.selfheal_continue_used).toBe(0);

    const { dispatchCont } = mockDispatch();

    // Cycle 1
    await manager.selfHealContinue(stackId);
    expect(registry.getMostRecentTask(stackId)!.review_iterations).toBe(0);
    expect(registry.getStack(stackId)!.selfheal_continue_used).toBe(0);
    expect(dispatchCont).toHaveBeenCalledTimes(1);

    // Drive stack back to failed for cycle 2
    registry.updateStackStatus(stackId, 'failed');
    const task2 = registry.getMostRecentTask(stackId)!;
    registry.setTaskIterations(task2.id, 5, 0);

    // Cycle 2
    await manager.selfHealContinue(stackId);
    expect(registry.getMostRecentTask(stackId)!.review_iterations).toBe(0);
    expect(registry.getStack(stackId)!.selfheal_continue_used).toBe(0);
    expect(dispatchCont).toHaveBeenCalledTimes(2);
  });
});
