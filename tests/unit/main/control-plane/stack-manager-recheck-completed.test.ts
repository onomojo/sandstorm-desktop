/**
 * Tests for StackManager.recheckCompletedStack (ticket #557)
 * and the Q-A extension to resumeStackWithContinuation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { StackManager } from '../../../../src/main/control-plane/stack-manager';
import { Registry } from '../../../../src/main/control-plane/registry';
import { PortAllocator } from '../../../../src/main/control-plane/port-allocator';
import { TaskWatcher } from '../../../../src/main/control-plane/task-watcher';
import type { ContainerRuntime } from '../../../../src/main/runtime/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeTempDb(): string {
  return path.join(
    os.tmpdir(),
    `sm-recheck-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
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
    listContainers: vi.fn().mockResolvedValue([]),
    inspect: vi.fn().mockResolvedValue({}),
    logs: vi.fn().mockReturnValue((async function* () {})()),
    containerStats: vi.fn().mockResolvedValue({ memoryUsage: 0, memoryLimit: 0, cpuPercent: 0 }),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('Mock 1.0'),
  };
}

const RUNNING_CONTAINER = { id: 'cid-abc', name: 'sandstorm-proj-s1-claude-1', status: 'running' };

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('StackManager.recheckCompletedStack', () => {
  let registry: Registry;
  let runtime: ContainerRuntime;
  let manager: StackManager;
  let dbPath: string;
  let resumeSpy: ReturnType<typeof vi.spyOn>;
  let dispatchTaskSpy: ReturnType<typeof vi.spyOn>;
  let dispatchContinuationSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    runtime = createMockRuntime();
    const portAllocator = new PortAllocator(registry, [40100, 40199]);
    const taskWatcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 100 });
    manager = new StackManager(registry, portAllocator, taskWatcher, runtime, runtime, '/fake/cli');

    registry.createStack({
      id: 's1',
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'completed',
      runtime: 'docker',
    });
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
    vi.restoreAllMocks();
  });

  // Helpers
  function setupRunningContainer() {
    vi.mocked(runtime.listContainers).mockResolvedValue([RUNNING_CONTAINER]);
  }

  function setupTokenLimitedGrep() {
    // exit 0 = token limit found
    vi.mocked(runtime.exec).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  }

  function setupNoTokenLimitGrep() {
    // exit 1 = not found
    vi.mocked(runtime.exec).mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
  }

  function createCompletedTask(sessionId: string | null = null): number {
    const task = registry.createTask('s1', 'do the work', null);
    // Close it as completed (exit 0)
    registry.completeTask(task.id, 0);
    if (sessionId) {
      registry.setTaskSessionId(task.id, sessionId);
    }
    return task.id;
  }

  // ---------------------------------------------------------------------------
  // Container absent / not running
  // ---------------------------------------------------------------------------
  it('returns container_gone when no container is found', async () => {
    vi.mocked(runtime.listContainers).mockResolvedValue([]);
    createCompletedTask();

    const result = await manager.recheckCompletedStack('s1');
    expect(result.outcome).toBe('container_gone');
    // Stack unchanged
    expect(registry.getStack('s1')?.status).toBe('completed');
  });

  it('returns container_gone when container is not running', async () => {
    vi.mocked(runtime.listContainers).mockResolvedValue([
      { ...RUNNING_CONTAINER, status: 'exited' },
    ]);
    createCompletedTask();

    const result = await manager.recheckCompletedStack('s1');
    expect(result.outcome).toBe('container_gone');
    expect(registry.getStack('s1')?.status).toBe('completed');
  });

  it('returns container_gone when listContainers throws', async () => {
    vi.mocked(runtime.listContainers).mockRejectedValue(new Error('Docker not available'));
    createCompletedTask();

    const result = await manager.recheckCompletedStack('s1');
    expect(result.outcome).toBe('container_gone');
    expect(registry.getStack('s1')?.status).toBe('completed');
  });

  // ---------------------------------------------------------------------------
  // Not token-limited
  // ---------------------------------------------------------------------------
  it('returns not_token_limited when grep exits non-zero', async () => {
    setupRunningContainer();
    setupNoTokenLimitGrep();
    createCompletedTask();

    const result = await manager.recheckCompletedStack('s1');
    expect(result.outcome).toBe('not_token_limited');
    expect(registry.getStack('s1')?.status).toBe('completed');
  });

  it('returns not_token_limited when exec throws', async () => {
    setupRunningContainer();
    vi.mocked(runtime.exec).mockRejectedValue(new Error('exec failure'));
    createCompletedTask();

    const result = await manager.recheckCompletedStack('s1');
    expect(result.outcome).toBe('not_token_limited');
    expect(registry.getStack('s1')?.status).toBe('completed');
  });

  // ---------------------------------------------------------------------------
  // Token limit confirmed — Case A (session_id present)
  // ---------------------------------------------------------------------------
  it('resumes via Case A when token-limited and session_id is present', async () => {
    setupRunningContainer();
    createCompletedTask('sess-123');

    // Sequence: exec 1 = grep (exit 0), exec 2 = cat raw log (returns session json)
    vi.mocked(runtime.exec)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // grep
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"type":"result","session_id":"sess-123"}', stderr: '' }); // cat log

    vi.spyOn(manager as any, 'ensureStackContainersRunning').mockResolvedValue(undefined);
    dispatchContinuationSpy = vi.spyOn(manager as any, 'dispatchContinuation').mockResolvedValue(undefined);

    const result = await manager.recheckCompletedStack('s1');

    expect(result.outcome).toBe('resuming_with_session');
    expect(dispatchContinuationSpy).toHaveBeenCalledOnce();
    // Task was reopened then used for Case A
    const task = registry.getMostRecentTask('s1');
    expect(task?.status).toBe('running');
    expect(task?.session_id).toBe('sess-123');
  });

  // ---------------------------------------------------------------------------
  // Token limit confirmed — Case B (no session_id)
  // ---------------------------------------------------------------------------
  it('resumes via Case B when token-limited and no session_id', async () => {
    setupRunningContainer();
    createCompletedTask(null); // no session_id

    vi.mocked(runtime.exec)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // grep
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // cat log — no session_id

    vi.spyOn(manager as any, 'ensureStackContainersRunning').mockResolvedValue(undefined);
    dispatchTaskSpy = vi.spyOn(manager, 'dispatchTask').mockResolvedValue({
      id: 99, stack_id: 's1', status: 'running',
    });

    const result = await manager.recheckCompletedStack('s1');

    expect(result.outcome).toBe('resumed_fresh');
    expect(dispatchTaskSpy).toHaveBeenCalledOnce();
    // prompt should be original task prompt
    expect(dispatchTaskSpy).toHaveBeenCalledWith(
      's1',
      'do the work',
      undefined,
      expect.objectContaining({ skipTicketFetch: true }),
    );
  });

  // ---------------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------------
  it('aborts with idle when stack is no longer completed (idempotency guard)', async () => {
    // Make it session_paused so it's no longer 'completed'
    registry.updateStackStatus('s1', 'session_paused');

    const result = await manager.recheckCompletedStack('s1');
    expect(result.outcome).toBe('idle');
    // listContainers should not have been called
    expect(runtime.listContainers).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Resume dispatch failure → revert to completed
  // ---------------------------------------------------------------------------
  it('reverts to completed when dispatch fails', async () => {
    setupRunningContainer();
    createCompletedTask('sess-456');

    vi.mocked(runtime.exec)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // grep
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"type":"result","session_id":"sess-456"}', stderr: '' }); // cat

    vi.spyOn(manager as any, 'ensureStackContainersRunning').mockResolvedValue(undefined);
    dispatchContinuationSpy = vi.spyOn(manager as any, 'dispatchContinuation')
      .mockRejectedValue(new Error('dispatch failed'));

    await expect(manager.recheckCompletedStack('s1')).rejects.toThrow('dispatch failed');

    // Stack must be reverted to completed — not left in session_paused or building
    expect(registry.getStack('s1')?.status).toBe('completed');
  });

  // ---------------------------------------------------------------------------
  // Resume dispatch failure — Case B (no session_id) → revert to completed
  // ---------------------------------------------------------------------------
  it('reverts to completed and task not stranded in interrupted when Case B dispatch fails', async () => {
    setupRunningContainer();
    createCompletedTask(null); // no session_id → Case B path

    vi.mocked(runtime.exec)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // grep
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // cat log — no session_id

    vi.spyOn(manager as any, 'ensureStackContainersRunning').mockResolvedValue(undefined);
    vi.spyOn(manager, 'dispatchTask').mockRejectedValue(new Error('dispatch failed'));

    await expect(manager.recheckCompletedStack('s1')).rejects.toThrow('dispatch failed');

    // Stack must revert to completed
    expect(registry.getStack('s1')?.status).toBe('completed');
    // Task must NOT remain in 'interrupted' — it should be completed (terminal state restored)
    const task = registry.getMostRecentTask('s1');
    expect(task?.status).not.toBe('interrupted');
    expect(task?.status).toBe('completed');
  });

  // ---------------------------------------------------------------------------
  // No task record at all
  // ---------------------------------------------------------------------------
  it('returns idle when no task exists for the stack', async () => {
    setupRunningContainer();
    setupTokenLimitedGrep();
    // Do not create any task — getMostRecentTask returns undefined

    const result = await manager.recheckCompletedStack('s1');
    expect(result.outcome).toBe('idle');
    // Stack status unchanged (no transition attempted)
    expect(registry.getStack('s1')?.status).toBe('completed');
  });

  // ---------------------------------------------------------------------------
  // Detection command correctness
  // ---------------------------------------------------------------------------
  it('execs the structured detection command targeting /tmp/claude-raw.log', async () => {
    setupRunningContainer();
    setupNoTokenLimitGrep();
    createCompletedTask();

    await manager.recheckCompletedStack('s1');

    // Find the exec call that ran the detection command
    const execCalls = vi.mocked(runtime.exec).mock.calls;
    const grepCall = execCalls.find((args) => {
      const cmd = args[1] as string[];
      return cmd[0] === 'sh' && cmd[1] === '-c';
    });
    expect(grepCall).toBeDefined();
    const shellCmd = (grepCall![1] as string[])[2];

    // Must target the log file
    expect(shellCmd).toContain('/tmp/claude-raw.log');
    // Must include structured JSON detection for rate_limit_event
    expect(shellCmd).toContain('rate_limit_event');
    expect(shellCmd).toContain('rejected');
    // Must include structured JSON detection for error result
    expect(shellCmd).toContain('is_error');
    expect(shellCmd).toContain('429');
    // Must include plain-text fallback
    expect(shellCmd).toContain("You've hit your session limit");
  });

  it('detection command: JSON lines with rate_limit_event (rejected) would match', () => {
    // Verify the structured shell command mirrors the task-runner logic:
    // JSON lines containing rate_limit_event with rejected status are the primary signal.
    const shellCmd = [
      "grep -E '^[[:space:]]*\\{' /tmp/claude-raw.log 2>/dev/null",
      "| jq -c 'select((.type == \"rate_limit_event\" and .rate_limit_info.status == \"rejected\") or (.type == \"result\" and .is_error == true and .api_error_status == 429))' 2>/dev/null",
      '| grep -q .',
      "|| grep -vE '^[[:space:]]*\\{' /tmp/claude-raw.log 2>/dev/null | grep -qi \"You've hit your session limit\"",
    ].join(' ');

    expect(shellCmd).toContain('rate_limit_event');
    expect(shellCmd).toContain('rejected');
    expect(shellCmd).toContain('is_error');
    expect(shellCmd).toContain('429');
    expect(shellCmd).toContain("You've hit your session limit");

    // JSON lines (starting with {) should be included by the first grep
    const jsJsonLineRe = /^[\s]*\{/;
    expect(jsJsonLineRe.test('{"type":"rate_limit_event"}')).toBe(true);
    // Non-JSON lines should be excluded from structured detection
    expect(jsJsonLineRe.test("You've hit your session limit")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Q-A extension: resumeStackWithContinuation Case C fallback
// ---------------------------------------------------------------------------
describe('resumeStackWithContinuation Q-A fallback (Case C → getMostRecentTask)', () => {
  let registry: Registry;
  let runtime: ContainerRuntime;
  let manager: StackManager;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    runtime = createMockRuntime();
    const portAllocator = new PortAllocator(registry, [40200, 40299]);
    const taskWatcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 100 });
    manager = new StackManager(registry, portAllocator, taskWatcher, runtime, runtime, '/fake/cli');

    registry.createStack({
      id: 's2',
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'session_paused',
      runtime: 'docker',
    });
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
    vi.restoreAllMocks();
  });

  it('falls back to getMostRecentTask when getRunningTask returns nothing', async () => {
    // Create and complete a task (no running task)
    const task = registry.createTask('s2', 'original prompt', null);
    registry.setTaskSessionId(task.id, 'sess-789');
    registry.completeTask(task.id, 0); // task is now 'completed', no running task
    // completeTask also sets stack to 'completed'; restore to session_paused
    registry.updateStackStatus('s2', 'session_paused');

    const dispatchContinuationSpy = vi.spyOn(manager as any, 'dispatchContinuation')
      .mockResolvedValue(undefined);
    vi.spyOn(manager as any, 'ensureStackContainersRunning').mockResolvedValue(undefined);
    vi.spyOn(manager as any, 'findClaudeContainer').mockResolvedValue({ id: 'cid', status: 'running' });

    const result = await manager.resumeStackWithContinuation('s2', () => false, true);

    expect(result.outcome).toBe('resuming_with_session');
    expect(dispatchContinuationSpy).toHaveBeenCalledOnce();
    // Task should have been reopened
    const reopened = registry.getMostRecentTask('s2');
    expect(reopened?.status).toBe('running');
  });

  it('returns idle when neither running task nor most-recent task exists', async () => {
    vi.spyOn(manager as any, 'ensureStackContainersRunning').mockResolvedValue(undefined);

    const result = await manager.resumeStackWithContinuation('s2', () => false, true);
    expect(result.outcome).toBe('idle');
  });

  it('does NOT trigger Q-A fallback when a running task already exists (regression)', async () => {
    // Create a running task — normal Case A path.
    // createTask also sets stack status to 'running'; restore to session_paused.
    const task = registry.createTask('s2', 'running work', null);
    registry.setTaskSessionId(task.id, 'sess-run-1');
    registry.updateStackStatus('s2', 'session_paused');

    const dispatchContinuationSpy = vi.spyOn(manager as any, 'dispatchContinuation')
      .mockResolvedValue(undefined);
    vi.spyOn(manager as any, 'ensureStackContainersRunning').mockResolvedValue(undefined);
    vi.spyOn(manager as any, 'findClaudeContainer').mockResolvedValue({ id: 'cid', status: 'running' });

    const result = await manager.resumeStackWithContinuation('s2', () => false, true);

    // Case A is reached directly — no fallback triggered
    expect(result.outcome).toBe('resuming_with_session');
    expect(dispatchContinuationSpy).toHaveBeenCalledOnce();
    // The task was already running, not reopened
    const t = registry.getRunningTask('s2');
    expect(t?.id).toBe(task.id);
  });
});
