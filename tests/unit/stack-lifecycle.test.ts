import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StackManager } from '../../src/main/control-plane/stack-manager';
import { Registry } from '../../src/main/control-plane/registry';
import { PortAllocator } from '../../src/main/control-plane/port-allocator';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import { ContainerRuntime } from '../../src/main/runtime/types';
import { StackStatus } from '../../src/main/control-plane/registry';
import { SandstormError, ErrorCode } from '../../src/main/errors';
import fs from 'fs';
import path from 'path';
import os from 'os';

// --- Helpers ---

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

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
    containerStats: vi.fn().mockResolvedValue({ cpuPercent: 0, memoryUsage: 0, memoryLimit: 0 }),
    logs: vi.fn().mockReturnValue((async function* () {})()),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('Mock 1.0'),
  };
}

function makeStack(id: string, status: StackStatus = 'up') {
  return {
    id,
    project: 'proj',
    project_dir: '/proj',
    ticket: null,
    branch: null,
    description: null,
    status,
    runtime: 'docker' as const,
  };
}

// --- Tests ---

describe('Stack Lifecycle Integration', () => {
  let registry: Registry;
  let portAllocator: PortAllocator;
  let taskWatcher: TaskWatcher;
  let runtime: ContainerRuntime;
  let manager: StackManager;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    runtime = createMockRuntime();
    portAllocator = new PortAllocator(registry, [40000, 40099]);
    taskWatcher = new TaskWatcher(registry, runtime, { pollInterval: 50 });
    manager = new StackManager(registry, portAllocator, taskWatcher, runtime, '/fake/cli');
  });

  afterEach(() => {
    taskWatcher.unwatchAll();
    registry.close();
    cleanupDb(dbPath);
  });

  describe('full lifecycle (happy path)', () => {
    it('create → dispatch → complete → getDiff → push → teardown', async () => {
      // 1. Create stack directly in registry (skipping CLI build)
      registry.createStack(makeStack('lifecycle-1'));
      expect(registry.getStack('lifecycle-1')!.status).toBe('up');

      // 2. Dispatch a task
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
      const task = await manager.dispatchTask('lifecycle-1', 'Fix the login bug');

      expect(task.status).toBe('running');
      expect(task.prompt).toBe('Fix the login bug');
      expect(registry.getStack('lifecycle-1')!.status).toBe('running');

      // 3. Simulate task completion via TaskWatcher event
      taskWatcher.emit('task:completed', {
        stackId: 'lifecycle-1',
        task: { ...task, status: 'completed', exit_code: 0 },
      });
      registry.completeTask(task.id, 0);

      const completedStack = registry.getStack('lifecycle-1')!;
      expect(completedStack.status).toBe('completed');

      const tasks = registry.getTasksForStack('lifecycle-1');
      expect(tasks[0].status).toBe('completed');
      expect(tasks[0].exit_code).toBe(0);

      // 4. Get diff
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: 'diff --git a/login.ts b/login.ts\n+fixed',
        stderr: '',
        exitCode: 0,
      });
      const diff = await manager.getDiff('lifecycle-1');
      expect(diff).toContain('+fixed');

      // 5. Push
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'Pushed!', stderr: '', exitCode: 0 });
      await manager.push('lifecycle-1', 'fix: login bug');
      expect(registry.getStack('lifecycle-1')!.status).toBe('pushed');

      // 6. Set PR
      manager.setPullRequest('lifecycle-1', 'https://github.com/org/repo/pull/42', 42);
      const prStack = registry.getStack('lifecycle-1')!;
      expect(prStack.status).toBe('pr_created');
      expect(prStack.pr_url).toBe('https://github.com/org/repo/pull/42');
      expect(prStack.pr_number).toBe(42);

      // 7. Teardown
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      manager.teardownStack('lifecycle-1');

      // Stack should be deleted from active stacks
      expect(registry.getStack('lifecycle-1')).toBeUndefined();

      // But archived in history
      const history = registry.listStackHistory();
      expect(history).toHaveLength(1);
      expect(history[0].stack_id).toBe('lifecycle-1');
      // pr_created is not completed/failed, so it archives as 'torn_down'
      // But the history captures the lifecycle completed
    });

    it('tracks tokens through the lifecycle', async () => {
      registry.createStack(makeStack('token-lifecycle'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      // Dispatch task
      const task = await manager.dispatchTask('token-lifecycle', 'Add feature');
      expect(task.input_tokens).toBe(0);
      expect(task.output_tokens).toBe(0);

      // Simulate token updates (as TaskWatcher would do via readTaskTokens)
      registry.updateTaskTokens(task.id, 1500, 800);

      // Verify task-level tokens
      const updatedTasks = registry.getTasksForStack('token-lifecycle');
      expect(updatedTasks[0].input_tokens).toBe(1500);
      expect(updatedTasks[0].output_tokens).toBe(800);

      // Verify stack-level aggregate tokens
      const usage = manager.getStackTokenUsage('token-lifecycle');
      expect(usage.input_tokens).toBe(1500);
      expect(usage.output_tokens).toBe(800);
      expect(usage.total_tokens).toBe(2300);

      // Complete the task
      registry.completeTask(task.id, 0);

      // Tokens should persist after completion
      const finalUsage = manager.getStackTokenUsage('token-lifecycle');
      expect(finalUsage.input_tokens).toBe(1500);
      expect(finalUsage.output_tokens).toBe(800);
    });
  });

  describe('multi-task dispatch', () => {
    it('dispatches multiple sequential tasks to same stack', async () => {
      registry.createStack(makeStack('multi-task'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      // Dispatch task 1
      const task1 = await manager.dispatchTask('multi-task', 'Task 1: fix bug');
      expect(task1.prompt).toBe('Task 1: fix bug');
      expect(registry.getStack('multi-task')!.status).toBe('running');

      // Complete task 1
      registry.completeTask(task1.id, 0);
      expect(registry.getStack('multi-task')!.status).toBe('completed');

      // Dispatch task 2 — this is the scenario that keeps breaking
      const task2 = await manager.dispatchTask('multi-task', 'Task 2: add tests');
      expect(task2.prompt).toBe('Task 2: add tests');
      expect(task2.id).not.toBe(task1.id);
      expect(registry.getStack('multi-task')!.status).toBe('running');

      // Complete task 2
      registry.completeTask(task2.id, 0);
      expect(registry.getStack('multi-task')!.status).toBe('completed');

      // Verify both tasks are recorded
      const allTasks = registry.getTasksForStack('multi-task');
      expect(allTasks).toHaveLength(2);
      expect(allTasks.every(t => t.status === 'completed')).toBe(true);
      expect(allTasks.every(t => t.exit_code === 0)).toBe(true);
    });

    it('allows dispatch after a failed task', async () => {
      registry.createStack(makeStack('retry-after-fail'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      // Task 1 fails
      const task1 = await manager.dispatchTask('retry-after-fail', 'Attempt 1');
      registry.completeTask(task1.id, 1);
      expect(registry.getStack('retry-after-fail')!.status).toBe('failed');

      // Task 2 should still dispatch successfully
      const task2 = await manager.dispatchTask('retry-after-fail', 'Attempt 2');
      expect(task2.status).toBe('running');
      expect(registry.getStack('retry-after-fail')!.status).toBe('running');

      // Complete task 2 successfully
      registry.completeTask(task2.id, 0);
      expect(registry.getStack('retry-after-fail')!.status).toBe('completed');
    });

    it('accumulates tokens across multiple tasks', async () => {
      registry.createStack(makeStack('multi-token'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      // Task 1 with tokens
      const task1 = await manager.dispatchTask('multi-token', 'Task 1');
      registry.updateTaskTokens(task1.id, 1000, 500);
      registry.completeTask(task1.id, 0);

      // Task 2 with tokens
      const task2 = await manager.dispatchTask('multi-token', 'Task 2');
      registry.updateTaskTokens(task2.id, 2000, 1000);
      registry.completeTask(task2.id, 0);

      // Stack-level tokens should be cumulative
      const usage = manager.getStackTokenUsage('multi-token');
      expect(usage.input_tokens).toBe(3000);
      expect(usage.output_tokens).toBe(1500);
      expect(usage.total_tokens).toBe(4500);

      // Task metrics should reflect both tasks
      const metrics = manager.getStackTaskMetrics('multi-token');
      expect(metrics.totalTasks).toBe(2);
      expect(metrics.completedTasks).toBe(2);
      expect(metrics.failedTasks).toBe(0);
    });
  });

  describe('no global rate limit gate', () => {
    it('stacks dispatch independently without global blocking', async () => {
      registry.createStack(makeStack('ind-a'));
      registry.createStack(makeStack('ind-b'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      // Both stacks can dispatch tasks independently
      const taskA = await manager.dispatchTask('ind-a', 'Task A');
      expect(taskA.status).toBe('running');

      const taskB = await manager.dispatchTask('ind-b', 'Task B');
      expect(taskB.status).toBe('running');
    });
  });

  describe('task failure handling', () => {
    it('stack status reflects task failure and allows re-dispatch', async () => {
      registry.createStack(makeStack('fail-handle'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      // Dispatch and fail
      const task1 = await manager.dispatchTask('fail-handle', 'Broken task');
      expect(registry.getStack('fail-handle')!.status).toBe('running');

      // Simulate failure
      registry.completeTask(task1.id, 1);
      expect(registry.getStack('fail-handle')!.status).toBe('failed');

      // Verify task recorded with failure
      const tasks = registry.getTasksForStack('fail-handle');
      expect(tasks[0].status).toBe('failed');
      expect(tasks[0].exit_code).toBe(1);

      // Re-dispatch should work (stack not stuck in "running")
      const task2 = await manager.dispatchTask('fail-handle', 'Fixed task');
      expect(task2.status).toBe('running');
      expect(registry.getStack('fail-handle')!.status).toBe('running');
    });

    it('marks task as failed when dispatch CLI fails', async () => {
      registry.createStack(makeStack('dispatch-fail'));

      // First call succeeds (waitForClaudeReady), second fails (runCli for task)
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: 'dispatch error',
        exitCode: 1,
      });

      await expect(
        manager.dispatchTask('dispatch-fail', 'Doomed task')
      ).rejects.toThrow('dispatch error');

      // Task should be marked as failed so stack isn't stuck
      const tasks = registry.getTasksForStack('dispatch-fail');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('failed');
      expect(tasks[0].exit_code).toBe(1);
    });

    it('marks task as failed when container is not found', async () => {
      registry.createStack(makeStack('no-container'));

      // No claude container found
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      await expect(
        manager.dispatchTask('no-container', 'Ghost task')
      ).rejects.toThrow('Agent container not found');

      // Task should still be marked failed
      const tasks = registry.getTasksForStack('no-container');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('failed');
      expect(tasks[0].exit_code).toBe(1);
    });

    it('task metrics accurately reflect mixed outcomes', async () => {
      registry.createStack(makeStack('mixed-metrics'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      // 2 completed, 1 failed
      const t1 = await manager.dispatchTask('mixed-metrics', 'Good 1');
      registry.completeTask(t1.id, 0);
      const t2 = await manager.dispatchTask('mixed-metrics', 'Bad 1');
      registry.completeTask(t2.id, 1);
      const t3 = await manager.dispatchTask('mixed-metrics', 'Good 2');
      registry.completeTask(t3.id, 0);

      const metrics = manager.getStackTaskMetrics('mixed-metrics');
      expect(metrics.totalTasks).toBe(3);
      expect(metrics.completedTasks).toBe(2);
      expect(metrics.failedTasks).toBe(1);
      expect(metrics.runningTasks).toBe(0);
    });
  });

  describe('nonexistent stack errors', () => {
    it('dispatchTask to a nonexistent stack throws STACK_NOT_FOUND', async () => {
      await expect(
        manager.dispatchTask('no-such-stack', 'Hello')
      ).rejects.toThrow(expect.objectContaining({
        code: ErrorCode.STACK_NOT_FOUND,
      }));
    });

    it('teardownStack on a nonexistent stack throws STACK_NOT_FOUND', () => {
      expect(() => manager.teardownStack('no-such-stack')).toThrow(
        expect.objectContaining({ code: ErrorCode.STACK_NOT_FOUND })
      );
    });

    it('push on a nonexistent stack throws STACK_NOT_FOUND', async () => {
      await expect(
        manager.push('no-such-stack', 'msg')
      ).rejects.toThrow(expect.objectContaining({
        code: ErrorCode.STACK_NOT_FOUND,
      }));
    });

    it('getDiff on a nonexistent stack throws STACK_NOT_FOUND', async () => {
      await expect(
        manager.getDiff('no-such-stack')
      ).rejects.toThrow(expect.objectContaining({
        code: ErrorCode.STACK_NOT_FOUND,
      }));
    });
  });

  describe('concurrent stacks', () => {
    it('manages independent stacks without state leakage', async () => {
      registry.createStack(makeStack('stack-a'));
      registry.createStack(makeStack('stack-b'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      // Dispatch tasks to both stacks
      const taskA = await manager.dispatchTask('stack-a', 'Task for A');
      const taskB = await manager.dispatchTask('stack-b', 'Task for B');

      // Both should be running independently
      expect(registry.getStack('stack-a')!.status).toBe('running');
      expect(registry.getStack('stack-b')!.status).toBe('running');
      expect(taskA.stack_id).toBe('stack-a');
      expect(taskB.stack_id).toBe('stack-b');

      // Complete A, B still running
      registry.completeTask(taskA.id, 0);
      expect(registry.getStack('stack-a')!.status).toBe('completed');
      expect(registry.getStack('stack-b')!.status).toBe('running');

      // Fail B
      registry.completeTask(taskB.id, 1);
      expect(registry.getStack('stack-b')!.status).toBe('failed');
      // A should be unaffected
      expect(registry.getStack('stack-a')!.status).toBe('completed');
    });

    it('push from one stack while another is running', async () => {
      registry.createStack(makeStack('push-stack'));
      registry.createStack(makeStack('running-stack'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      // Dispatch to both
      const taskPush = await manager.dispatchTask('push-stack', 'Work');
      const taskRunning = await manager.dispatchTask('running-stack', 'More work');

      // Complete and push from push-stack
      registry.completeTask(taskPush.id, 0);
      await manager.push('push-stack', 'Ship it');
      expect(registry.getStack('push-stack')!.status).toBe('pushed');

      // running-stack should still be running
      expect(registry.getStack('running-stack')!.status).toBe('running');

      // Complete running-stack — should not affect push-stack
      registry.completeTask(taskRunning.id, 0);
      expect(registry.getStack('running-stack')!.status).toBe('completed');
      expect(registry.getStack('push-stack')!.status).toBe('pushed');
    });

    it('teardown one stack while another continues', async () => {
      registry.createStack(makeStack('teardown-a'));
      registry.createStack(makeStack('keep-b'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      // Dispatch to both
      await manager.dispatchTask('keep-b', 'Keep working');
      const taskA = await manager.dispatchTask('teardown-a', 'Will be torn down');
      registry.completeTask(taskA.id, 0);

      // Teardown A
      manager.teardownStack('teardown-a');
      expect(registry.getStack('teardown-a')).toBeUndefined();

      // B should be completely unaffected
      expect(registry.getStack('keep-b')!.status).toBe('running');
      const bTasks = registry.getTasksForStack('keep-b');
      expect(bTasks).toHaveLength(1);
      expect(bTasks[0].status).toBe('running');
    });

    it('token usage is isolated per stack', async () => {
      registry.createStack(makeStack('tok-a'));
      registry.createStack(makeStack('tok-b'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      const tA = await manager.dispatchTask('tok-a', 'A task');
      registry.updateTaskTokens(tA.id, 100, 50);

      const tB = await manager.dispatchTask('tok-b', 'B task');
      registry.updateTaskTokens(tB.id, 500, 250);

      // Each stack tracks its own tokens
      expect(manager.getStackTokenUsage('tok-a').total_tokens).toBe(150);
      expect(manager.getStackTokenUsage('tok-b').total_tokens).toBe(750);

      // Global usage aggregates both
      const global = manager.getGlobalTokenUsage();
      expect(global.total_input_tokens).toBe(600);
      expect(global.total_output_tokens).toBe(300);
      expect(global.total_tokens).toBe(900);
      expect(global.per_stack).toHaveLength(2);
    });

    it('dispatch to one stack does not affect another stack', async () => {
      registry.createStack(makeStack('iso-a'));
      registry.createStack(makeStack('iso-b'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      await manager.dispatchTask('iso-a', 'Working');
      // Stack B can still dispatch regardless of stack A's status
      const taskB = await manager.dispatchTask('iso-b', 'Also working');
      expect(taskB.status).toBe('running');
    });
  });

  describe('TaskWatcher integration with lifecycle', () => {
    it('watcher completes task and updates stack status through registry', async () => {
      registry.createStack(makeStack('watcher-int'));

      // Create a runtime that transitions running → completed
      let callIndex = 0;
      (runtime.exec as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: string, cmd: string[]) => {
          if (cmd.includes('/tmp/claude-task.status')) {
            callIndex++;
            if (callIndex <= 2) return { exitCode: 0, stdout: 'running', stderr: '' };
            return { exitCode: 0, stdout: 'completed', stderr: '' };
          }
          if (cmd.includes('/tmp/claude-task.exit')) {
            return { exitCode: 0, stdout: '0', stderr: '' };
          }
          if (cmd.includes('/tmp/claude-raw.log')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (cmd.includes('/tmp/claude-task.stderr')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          // readiness check
          return { exitCode: 0, stdout: '', stderr: '' };
        }
      );

      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      // Dispatch — this starts the watcher
      const task = await manager.dispatchTask('watcher-int', 'Watched task');
      expect(task.status).toBe('running');

      // Wait for watcher to detect completion
      await vi.waitFor(() => {
        const stack = registry.getStack('watcher-int');
        expect(stack!.status).toBe('completed');
      }, { timeout: 5000 });

      // Verify task was completed in DB
      const tasks = registry.getTasksForStack('watcher-int');
      expect(tasks[0].status).toBe('completed');
      expect(tasks[0].exit_code).toBe(0);
    });

    it('watcher detects failed task and updates status', async () => {
      registry.createStack(makeStack('watcher-fail'));

      let callIndex = 0;
      (runtime.exec as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: string, cmd: string[]) => {
          if (cmd.includes('/tmp/claude-task.status')) {
            callIndex++;
            if (callIndex <= 2) return { exitCode: 0, stdout: 'running', stderr: '' };
            return { exitCode: 0, stdout: 'failed', stderr: '' };
          }
          if (cmd.includes('/tmp/claude-task.exit')) {
            return { exitCode: 0, stdout: '1', stderr: '' };
          }
          if (cmd.includes('/tmp/claude-raw.log')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          if (cmd.includes('/tmp/claude-task.stderr')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        }
      );

      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      await manager.dispatchTask('watcher-fail', 'Will fail');

      await vi.waitFor(() => {
        const stack = registry.getStack('watcher-fail');
        expect(stack!.status).toBe('failed');
      }, { timeout: 5000 });

      const tasks = registry.getTasksForStack('watcher-fail');
      expect(tasks[0].status).toBe('failed');
      expect(tasks[0].exit_code).toBe(1);
    });

    it('watcher-completed task followed by second dispatch and completion', async () => {
      registry.createStack(makeStack('watcher-multi'));

      let taskNumber = 0;
      let callIndex = 0;
      (runtime.exec as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: string, cmd: string[]) => {
          if (cmd.includes('/tmp/claude-task.status')) {
            callIndex++;
            // Each task: 2 "running" polls then "completed"
            const offsetInTask = callIndex - (taskNumber * 3);
            if (offsetInTask <= 2) return { exitCode: 0, stdout: 'running', stderr: '' };
            return { exitCode: 0, stdout: 'completed', stderr: '' };
          }
          if (cmd.includes('/tmp/claude-task.exit')) {
            return { exitCode: 0, stdout: '0', stderr: '' };
          }
          if (cmd.includes('/tmp/claude-raw.log') || cmd.includes('/tmp/claude-task.stderr')) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        }
      );

      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      // First task
      taskNumber = 0;
      callIndex = 0;
      await manager.dispatchTask('watcher-multi', 'Task 1');

      await vi.waitFor(() => {
        const stack = registry.getStack('watcher-multi');
        expect(stack!.status).toBe('completed');
      }, { timeout: 5000 });

      // Reset for second task
      taskNumber = 1;
      callIndex = 3;

      const task2 = await manager.dispatchTask('watcher-multi', 'Task 2');
      expect(task2.status).toBe('running');

      await vi.waitFor(() => {
        const tasks = registry.getTasksForStack('watcher-multi');
        const latest = tasks.find(t => t.prompt === 'Task 2');
        expect(latest!.status).toBe('completed');
      }, { timeout: 5000 });

      // Both tasks should be recorded
      const allTasks = registry.getTasksForStack('watcher-multi');
      expect(allTasks).toHaveLength(2);
      expect(allTasks.filter(t => t.status === 'completed')).toHaveLength(2);
    });
  });

  describe('stop and restart lifecycle', () => {
    it('stop → start → dispatch flows correctly', async () => {
      registry.createStack(makeStack('stop-start'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      // Stop
      manager.stopStack('stop-start');
      expect(registry.getStack('stop-start')!.status).toBe('stopped');

      // Start — goes to building then up
      manager.startStack('stop-start');
      expect(registry.getStack('stop-start')!.status).toBe('building');

      await vi.waitFor(() => {
        expect(registry.getStack('stop-start')!.status).toBe('up');
      }, { timeout: 5000 });

      // Dispatch should work on restarted stack
      const task = await manager.dispatchTask('stop-start', 'Post-restart task');
      expect(task.status).toBe('running');
      expect(registry.getStack('stop-start')!.status).toBe('running');
    });
  });

  describe('update callbacks fire at correct times', () => {
    it('callback fires for all state transitions in lifecycle', async () => {
      const updateCallback = vi.fn();
      manager.setOnStackUpdate(updateCallback);

      registry.createStack(makeStack('cb-lifecycle'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      // Dispatch triggers callback (via taskWatcher statusChange)
      const task = await manager.dispatchTask('cb-lifecycle', 'Work');
      const callsAfterDispatch = updateCallback.mock.calls.length;

      // Push triggers callback
      registry.completeTask(task.id, 0);
      await manager.push('cb-lifecycle');
      expect(updateCallback.mock.calls.length).toBeGreaterThan(callsAfterDispatch);

      const callsAfterPush = updateCallback.mock.calls.length;

      // PR set triggers callback
      manager.setPullRequest('cb-lifecycle', 'https://example.com/pr/1', 1);
      expect(updateCallback.mock.calls.length).toBeGreaterThan(callsAfterPush);

      const callsAfterPR = updateCallback.mock.calls.length;

      // Teardown triggers callback
      manager.teardownStack('cb-lifecycle');
      expect(updateCallback.mock.calls.length).toBeGreaterThan(callsAfterPR);
    });
  });
});
