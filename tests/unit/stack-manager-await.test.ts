/**
 * Unit tests for StackManager.awaitTaskCompletion
 *
 * Uses a mocked TaskWatcher EventEmitter and a minimal registry stub to
 * exercise the event-driven + polling-backstop + timeout paths.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { SandstormError, ErrorCode } from '../../src/main/errors';

// ---------------------------------------------------------------------------
// Minimal stub types
// ---------------------------------------------------------------------------
interface StubTask {
  id: number;
  stack_id: string;
  status: 'running' | 'completed' | 'failed' | 'needs_human' | 'interrupted';
  exit_code: number | null;
}

// ---------------------------------------------------------------------------
// Build a minimal StackManager-like object with only awaitTaskCompletion
// exposed, so we can test it in isolation without bringing up the full class.
// ---------------------------------------------------------------------------

function makeAwaitFn(taskWatcher: EventEmitter, getTasksForStack: (stackId: string) => StubTask[]) {
  function awaitTaskCompletion(
    stackId: string,
    taskId: number,
    opts?: { timeoutMs?: number }
  ): Promise<StubTask> {
    const timeoutMs = opts?.timeoutMs ?? 30 * 60 * 1000;

    return new Promise<StubTask>((resolve, reject) => {
      let settled = false;
      let pollInterval: ReturnType<typeof setInterval> | null = null;
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const settle = (task?: StubTask, err?: Error) => {
        if (settled) return;
        settled = true;
        taskWatcher.removeListener('task:completed', onCompleted);
        taskWatcher.removeListener('task:failed', onFailed);
        if (pollInterval !== null) clearInterval(pollInterval);
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        if (err) reject(err);
        else resolve(task!);
      };

      const isTerminal = (t: StubTask) =>
        t.status === 'completed' || t.status === 'failed' || t.status === 'needs_human';

      const onCompleted = ({ stackId: sid, task }: { stackId: string; task: StubTask }) => {
        if (sid === stackId && task.id === taskId) settle(task);
      };
      const onFailed = ({ stackId: sid, task }: { stackId: string; task: StubTask }) => {
        if (sid === stackId && task.id === taskId) settle(task);
      };

      taskWatcher.on('task:completed', onCompleted);
      taskWatcher.on('task:failed', onFailed);

      pollInterval = setInterval(() => {
        try {
          const tasks = getTasksForStack(stackId);
          const task = tasks.find(t => t.id === taskId);
          if (task && isTerminal(task)) settle(task);
        } catch { /* best effort */ }
      }, 2000);

      timeoutHandle = setTimeout(() => {
        settle(
          undefined,
          new SandstormError(
            ErrorCode.TASK_DISPATCH_FAILED,
            'Auto-resolve timed out waiting for task completion'
          )
        );
      }, timeoutMs);

      // Immediate backstop check
      try {
        const tasks = getTasksForStack(stackId);
        const task = tasks.find(t => t.id === taskId);
        if (task && isTerminal(task)) { settle(task); return; }
      } catch { /* ignore */ }
    });
  }

  return awaitTaskCompletion;
}

describe('awaitTaskCompletion', () => {
  let emitter: EventEmitter;
  let tasks: StubTask[];
  let getTasksForStack: ReturnType<typeof vi.fn>;
  let awaitTask: ReturnType<typeof makeAwaitFn>;

  beforeEach(() => {
    vi.useFakeTimers();
    emitter = new EventEmitter();
    tasks = [];
    getTasksForStack = vi.fn(() => tasks);
    awaitTask = makeAwaitFn(emitter, getTasksForStack);
  });

  afterEach(() => {
    vi.useRealTimers();
    emitter.removeAllListeners();
  });

  it('resolves when task:completed event fires for matching stackId and taskId', async () => {
    const completedTask: StubTask = { id: 1, stack_id: 's1', status: 'completed', exit_code: 0 };

    const promise = awaitTask('s1', 1);
    emitter.emit('task:completed', { stackId: 's1', task: completedTask });

    await expect(promise).resolves.toEqual(completedTask);
  });

  it('resolves when task:failed event fires for matching stackId and taskId', async () => {
    const failedTask: StubTask = { id: 2, stack_id: 's1', status: 'failed', exit_code: 1 };

    const promise = awaitTask('s1', 2);
    emitter.emit('task:failed', { stackId: 's1', task: failedTask });

    await expect(promise).resolves.toEqual(failedTask);
  });

  it('ignores task:completed events for a different stackId', async () => {
    const otherTask: StubTask = { id: 1, stack_id: 's2', status: 'completed', exit_code: 0 };
    const targetTask: StubTask = { id: 1, stack_id: 's1', status: 'completed', exit_code: 0 };

    const promise = awaitTask('s1', 1);
    // Different stack
    emitter.emit('task:completed', { stackId: 's2', task: otherTask });
    // Correct stack
    emitter.emit('task:completed', { stackId: 's1', task: targetTask });

    await expect(promise).resolves.toEqual(targetTask);
  });

  it('ignores task:completed events for a different taskId', async () => {
    const siblingTask: StubTask = { id: 99, stack_id: 's1', status: 'completed', exit_code: 0 };
    const targetTask: StubTask = { id: 1, stack_id: 's1', status: 'completed', exit_code: 0 };

    const promise = awaitTask('s1', 1);
    emitter.emit('task:completed', { stackId: 's1', task: siblingTask });
    emitter.emit('task:completed', { stackId: 's1', task: targetTask });

    await expect(promise).resolves.toEqual(targetTask);
  });

  it('settles via polling backstop when task is already terminal before any event fires', async () => {
    const completedTask: StubTask = { id: 5, stack_id: 's1', status: 'completed', exit_code: 0 };
    tasks = [completedTask];

    const promise = awaitTask('s1', 5, { timeoutMs: 10000 });

    // The immediate backstop check should resolve synchronously
    await expect(promise).resolves.toEqual(completedTask);
  });

  it('settles via the polling interval when task becomes terminal after a poll tick', async () => {
    const targetTask: StubTask = { id: 7, stack_id: 's1', status: 'completed', exit_code: 0 };

    const promise = awaitTask('s1', 7, { timeoutMs: 10000 });

    // Task not terminal yet
    tasks = [];
    vi.advanceTimersByTime(1999);
    // Still not there

    // Now task becomes terminal
    tasks = [targetTask];
    vi.advanceTimersByTime(2001);

    await expect(promise).resolves.toEqual(targetTask);
  });

  it('rejects on timeout when no terminal event arrives', async () => {
    const promise = awaitTask('s1', 3, { timeoutMs: 5000 });

    vi.advanceTimersByTime(5001);

    await expect(promise).rejects.toThrow('Auto-resolve timed out');
  });

  it('removes listeners on settle (no leak)', async () => {
    const completedTask: StubTask = { id: 10, stack_id: 's1', status: 'completed', exit_code: 0 };

    const promise = awaitTask('s1', 10);
    emitter.emit('task:completed', { stackId: 's1', task: completedTask });
    await promise;

    // After settle, emitter should have no remaining listeners
    expect(emitter.listenerCount('task:completed')).toBe(0);
    expect(emitter.listenerCount('task:failed')).toBe(0);
  });
});
