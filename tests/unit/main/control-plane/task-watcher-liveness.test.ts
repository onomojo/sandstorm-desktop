import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskWatcher, LIVENESS_CHECK_INTERVAL_MS, LIVENESS_STALL_THRESHOLD_MS } from '../../../../src/main/control-plane/task-watcher';
import { Registry, Task } from '../../../../src/main/control-plane/registry';
import { ContainerRuntime } from '../../../../src/main/runtime/types';
import { makeFakeContainerRuntime } from '../../../helpers/fake-container-runtime';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Fast intervals for tests — override production defaults
const TEST_LIVENESS_INTERVAL = 500;
const TEST_STALL_THRESHOLD = 1000;

/**
 * Create a mock ContainerRuntime for liveness tests.
 * opts.logSize: stat return value for /tmp/claude-raw.log (default 0)
 * opts.pgrepOut: pgrep stdout (default '' = no process)
 * opts.statusSequence: successive reads of /tmp/claude-task.status
 */
function createLivenessMockRuntime(opts: {
  logSize?: number | (() => number);
  pgrepOut?: string;
  statusSequence?: string[];
  statShouldThrow?: boolean;
  pgrepShouldThrow?: boolean;
} = {}): ContainerRuntime {
  let statusCallIdx = 0;
  return makeFakeContainerRuntime({
    logs: vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: '' }) }),
    }),
    exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
      if (cmd.includes('/tmp/claude-task.status')) {
        const seq = opts.statusSequence ?? ['running'];
        const idx = Math.min(statusCallIdx++, seq.length - 1);
        return { exitCode: 0, stdout: seq[idx], stderr: '' };
      }
      if (cmd[0] === 'stat' && cmd.includes('/tmp/claude-raw.log')) {
        if (opts.statShouldThrow) throw new Error('stat exec error');
        const size = typeof opts.logSize === 'function' ? opts.logSize() : (opts.logSize ?? 0);
        return { exitCode: 0, stdout: String(size), stderr: '' };
      }
      if (cmd[0] === 'pgrep') {
        if (opts.pgrepShouldThrow) throw new Error('pgrep exec error');
        const out = opts.pgrepOut ?? '';
        return { exitCode: out ? 0 : 1, stdout: out, stderr: '' };
      }
      if (cmd.includes('/tmp/claude-task.exit')) {
        return { exitCode: 0, stdout: '0', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
  });
}

describe('TaskWatcher — liveness check', () => {
  let registry: Registry;
  let dbPath: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    dbPath = path.join(os.tmpdir(), `sandstorm-liveness-test-${Date.now()}.db`);
    registry = await Registry.create(dbPath);

    registry.createStack({
      id: 'live-stack',
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'running',
      runtime: 'docker',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    registry.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(`${dbPath}-wal`); } catch { /* ignore */ }
    try { fs.unlinkSync(`${dbPath}-shm`); } catch { /* ignore */ }
  });

  // ─── Wiring tests ──────────────────────────────────────────────────────────

  it('watch() initializes liveness tracking; unwatch() tears it down', () => {
    const runtime = createLivenessMockRuntime();
    const watcher = new TaskWatcher(registry, runtime, runtime, {
      livenessCheckInterval: TEST_LIVENESS_INTERVAL,
      livenessStallThreshold: TEST_STALL_THRESHOLD,
    });
    registry.createTask('live-stack', 'test task');

    watcher.watch('live-stack', 'c1');
    // @ts-expect-error — accessing private field to verify initialization
    expect(watcher.livenessTimers.has('live-stack')).toBe(true);
    // @ts-expect-error
    expect(watcher.livenessLogSize.has('live-stack')).toBe(true);
    // @ts-expect-error
    expect(watcher.livenessLastActivityAt.has('live-stack')).toBe(true);

    watcher.unwatch('live-stack');
    // @ts-expect-error
    expect(watcher.livenessTimers.has('live-stack')).toBe(false);
    // @ts-expect-error
    expect(watcher.livenessLogSize.has('live-stack')).toBe(false);
    // @ts-expect-error
    expect(watcher.livenessLastActivityAt.has('live-stack')).toBe(false);
  });

  it('re-watch cleans up previous liveness timer and starts fresh', () => {
    const runtime = createLivenessMockRuntime();
    const watcher = new TaskWatcher(registry, runtime, runtime, {
      livenessCheckInterval: TEST_LIVENESS_INTERVAL,
    });
    registry.createTask('live-stack', 'test task');

    watcher.watch('live-stack', 'c1');
    // @ts-expect-error
    const firstTimer = watcher.livenessTimers.get('live-stack');

    watcher.watch('live-stack', 'c2');
    // @ts-expect-error
    const secondTimer = watcher.livenessTimers.get('live-stack');

    expect(secondTimer).not.toBe(firstTimer);
    watcher.unwatch('live-stack');
  });

  // ─── Headline regression ────────────────────────────────────────────────────

  it('triggers recovery exactly once when stalled + process dead', async () => {
    const runtime = createLivenessMockRuntime({
      logSize: 0,      // log never grows
      pgrepOut: '',    // claude process dead
      statusSequence: ['running'],  // status stays running
    });
    const watcher = new TaskWatcher(registry, runtime, runtime, {
      pollInterval: 10_000, // large — keep main poll from interfering
      livenessCheckInterval: TEST_LIVENESS_INTERVAL,
      livenessStallThreshold: TEST_STALL_THRESHOLD,
    });

    const task = registry.createTask('live-stack', 'test task');
    registry.setTaskSessionId(task.id, 'session-abc');

    const dispatchCalls: Array<{ stackId: string; task: Task }> = [];
    watcher.setDispatchInvestigation(async (stackId, t) => {
      dispatchCalls.push({ stackId, task: t });
    });

    watcher.watch('live-stack', 'c1');

    // Advance past stall threshold — liveness fires, stall detected, recovery triggered
    await vi.advanceTimersByTimeAsync(TEST_STALL_THRESHOLD + TEST_LIVENESS_INTERVAL * 2);

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].stackId).toBe('live-stack');
    expect(dispatchCalls[0].task.session_id).toBe('session-abc');

    watcher.unwatchAll();
  });

  // ─── False-positive guard ───────────────────────────────────────────────────

  it('does NOT trigger recovery when log is quiet but process is alive', async () => {
    const runtime = createLivenessMockRuntime({
      logSize: 0,        // log never grows
      pgrepOut: '12345', // claude process alive — long build/test
    });
    const watcher = new TaskWatcher(registry, runtime, runtime, {
      pollInterval: 10_000,
      livenessCheckInterval: TEST_LIVENESS_INTERVAL,
      livenessStallThreshold: TEST_STALL_THRESHOLD,
    });

    const task = registry.createTask('live-stack', 'test task');
    registry.setTaskSessionId(task.id, 'session-xyz');

    const dispatchCalls: string[] = [];
    watcher.setDispatchInvestigation(async (stackId) => {
      dispatchCalls.push(stackId);
    });

    watcher.watch('live-stack', 'c1');
    await vi.advanceTimersByTimeAsync(TEST_STALL_THRESHOLD + TEST_LIVENESS_INTERVAL * 2);

    expect(dispatchCalls).toHaveLength(0); // no recovery triggered

    watcher.unwatchAll();
  });

  // ─── Activity resets clock ──────────────────────────────────────────────────

  it('resets stall clock when log grows within the window', async () => {
    let logSizeValue = 100;
    const runtime = createLivenessMockRuntime({
      logSize: () => logSizeValue,
      pgrepOut: '',
      statusSequence: ['running'],
    });
    const watcher = new TaskWatcher(registry, runtime, runtime, {
      pollInterval: 10_000,
      livenessCheckInterval: TEST_LIVENESS_INTERVAL,
      livenessStallThreshold: TEST_STALL_THRESHOLD,
    });

    const task = registry.createTask('live-stack', 'test task');
    registry.setTaskSessionId(task.id, 'session-grow');

    const dispatchCalls: string[] = [];
    watcher.setDispatchInvestigation(async (stackId) => { dispatchCalls.push(stackId); });

    watcher.watch('live-stack', 'c1');

    // First liveness check fires — log size is 100, grew from 0 → resets clock
    await vi.advanceTimersByTimeAsync(TEST_LIVENESS_INTERVAL + 50);

    // After reset, stall threshold resets: even if we advance another stall period,
    // if the log keeps growing no stall is declared
    logSizeValue = 200; // log grew again
    await vi.advanceTimersByTimeAsync(TEST_LIVENESS_INTERVAL);

    logSizeValue = 300;
    await vi.advanceTimersByTimeAsync(TEST_LIVENESS_INTERVAL);

    // 3 intervals elapsed, each with log growth → clock reset each time → no stall
    expect(dispatchCalls).toHaveLength(0);

    watcher.unwatchAll();
  });

  it('stall IS triggered when log stops growing after initial growth', async () => {
    let logSizeValue = 0;
    const runtime = createLivenessMockRuntime({
      logSize: () => logSizeValue,
      pgrepOut: '',
      statusSequence: ['running'],
    });
    const watcher = new TaskWatcher(registry, runtime, runtime, {
      pollInterval: 10_000,
      livenessCheckInterval: TEST_LIVENESS_INTERVAL,
      livenessStallThreshold: TEST_STALL_THRESHOLD,
    });

    const task = registry.createTask('live-stack', 'test task');
    registry.setTaskSessionId(task.id, 'session-stall');

    const dispatchCalls: string[] = [];
    watcher.setDispatchInvestigation(async (stackId) => { dispatchCalls.push(stackId); });

    watcher.watch('live-stack', 'c1');

    // Log grows on first check → clock reset at T=500ms
    logSizeValue = 500;
    await vi.advanceTimersByTimeAsync(TEST_LIVENESS_INTERVAL + 50);
    expect(dispatchCalls).toHaveLength(0);

    // Log stops growing — advance past stall threshold from T=500ms
    await vi.advanceTimersByTimeAsync(TEST_STALL_THRESHOLD + TEST_LIVENESS_INTERVAL * 2);
    expect(dispatchCalls).toHaveLength(1);

    watcher.unwatchAll();
  });

  // ─── Transient exec error ───────────────────────────────────────────────────

  it('does not declare stall when stat exec fails (transient error)', async () => {
    // stat always throws — liveness check returns early each cycle
    const runtime = createLivenessMockRuntime({
      statShouldThrow: true,
      pgrepOut: '',
    });
    const watcher = new TaskWatcher(registry, runtime, runtime, {
      pollInterval: 10_000,
      livenessCheckInterval: TEST_LIVENESS_INTERVAL,
      livenessStallThreshold: TEST_STALL_THRESHOLD,
    });

    registry.createTask('live-stack', 'test task');

    const dispatchCalls: string[] = [];
    watcher.setDispatchInvestigation(async (stackId) => { dispatchCalls.push(stackId); });

    watcher.watch('live-stack', 'c1');
    await vi.advanceTimersByTimeAsync(TEST_STALL_THRESHOLD + TEST_LIVENESS_INTERVAL * 3);

    // No stall declared because every stat call threw
    expect(dispatchCalls).toHaveLength(0);

    watcher.unwatchAll();
  });

  it('does not falsely stall when pgrep exec fails', async () => {
    const runtime = createLivenessMockRuntime({
      logSize: 0,
      pgrepShouldThrow: true, // pgrep errors out
    });
    const watcher = new TaskWatcher(registry, runtime, runtime, {
      pollInterval: 10_000,
      livenessCheckInterval: TEST_LIVENESS_INTERVAL,
      livenessStallThreshold: TEST_STALL_THRESHOLD,
    });

    registry.createTask('live-stack', 'test task');

    const dispatchCalls: string[] = [];
    watcher.setDispatchInvestigation(async (stackId) => { dispatchCalls.push(stackId); });

    watcher.watch('live-stack', 'c1');
    await vi.advanceTimersByTimeAsync(TEST_STALL_THRESHOLD + TEST_LIVENESS_INTERVAL * 2);

    // pgrep threw → returned early, no recovery
    expect(dispatchCalls).toHaveLength(0);

    watcher.unwatchAll();
  });

  // ─── Idempotency / terminal-wins ────────────────────────────────────────────

  it('aborts recovery when status becomes terminal before dispatch', async () => {
    // With a large pollInterval, the first /tmp/claude-task.status read happens during
    // the liveness check's idempotency re-read. Returning 'completed' here simulates
    // the task writing a terminal status concurrently — recovery should abort.
    const runtime = createLivenessMockRuntime({
      logSize: 0,
      pgrepOut: '',
      statusSequence: ['completed'], // idempotency re-read returns terminal immediately
    });
    const watcher = new TaskWatcher(registry, runtime, runtime, {
      pollInterval: 10_000, // large — main poll does not fire during our test window
      livenessCheckInterval: TEST_LIVENESS_INTERVAL,
      livenessStallThreshold: TEST_STALL_THRESHOLD,
    });

    const task = registry.createTask('live-stack', 'test task');
    registry.setTaskSessionId(task.id, 'session-idem');

    const dispatchCalls: string[] = [];
    watcher.setDispatchInvestigation(async (stackId) => { dispatchCalls.push(stackId); });

    watcher.watch('live-stack', 'c1');
    await vi.advanceTimersByTimeAsync(TEST_STALL_THRESHOLD + TEST_LIVENESS_INTERVAL * 2);

    // Terminal status was seen in idempotency re-read → no dispatch
    expect(dispatchCalls).toHaveLength(0);

    watcher.unwatchAll();
  });

  // ─── Recovery dispatch mechanism ────────────────────────────────────────────

  it('dispatches investigation with correct stackId and session_id', async () => {
    const runtime = createLivenessMockRuntime({
      logSize: 0,
      pgrepOut: '',
      statusSequence: ['running'],
    });
    const watcher = new TaskWatcher(registry, runtime, runtime, {
      pollInterval: 10_000,
      livenessCheckInterval: TEST_LIVENESS_INTERVAL,
      livenessStallThreshold: TEST_STALL_THRESHOLD,
    });

    const task = registry.createTask('live-stack', 'do the work');
    registry.setTaskSessionId(task.id, 'resume-session-id-999');

    let capturedStackId: string | null = null;
    let capturedTask: Task | null = null;
    watcher.setDispatchInvestigation(async (stackId, t) => {
      capturedStackId = stackId;
      capturedTask = t;
    });

    watcher.watch('live-stack', 'c1');
    await vi.advanceTimersByTimeAsync(TEST_STALL_THRESHOLD + TEST_LIVENESS_INTERVAL * 2);

    expect(capturedStackId).toBe('live-stack');
    expect(capturedTask).not.toBeNull();
    expect(capturedTask!.session_id).toBe('resume-session-id-999');
    // Verify the token-limit continuation prompt is NOT passed here (separate code path)
    // The investigate callback is NOT the dispatchContinuation path
    expect(capturedTask!.prompt).toBe('do the work');

    watcher.unwatchAll();
  });

  it('does NOT trigger recovery more than once for the same stall', async () => {
    const runtime = createLivenessMockRuntime({
      logSize: 0,
      pgrepOut: '',
      statusSequence: ['running'],
    });
    const watcher = new TaskWatcher(registry, runtime, runtime, {
      pollInterval: 10_000,
      livenessCheckInterval: TEST_LIVENESS_INTERVAL,
      livenessStallThreshold: TEST_STALL_THRESHOLD,
    });

    const task = registry.createTask('live-stack', 'test task');
    registry.setTaskSessionId(task.id, 'session-once');

    const dispatchCalls: string[] = [];
    watcher.setDispatchInvestigation(async (stackId) => { dispatchCalls.push(stackId); });

    watcher.watch('live-stack', 'c1');

    // Advance well past stall threshold — multiple liveness checks would fire
    await vi.advanceTimersByTimeAsync(TEST_STALL_THRESHOLD * 3 + TEST_LIVENESS_INTERVAL * 5);

    // Liveness timer was cleared after first stall detection — recovery dispatched exactly once
    expect(dispatchCalls).toHaveLength(1);

    watcher.unwatchAll();
  });

  // ─── No session_id → needs_human ────────────────────────────────────────────

  it('marks task needs_human when stalled with no session_id', async () => {
    const runtime = createLivenessMockRuntime({
      logSize: 0,
      pgrepOut: '',
      statusSequence: ['running'],
    });
    const watcher = new TaskWatcher(registry, runtime, runtime, {
      pollInterval: 10_000,
      livenessCheckInterval: TEST_LIVENESS_INTERVAL,
      livenessStallThreshold: TEST_STALL_THRESHOLD,
    });

    const task = registry.createTask('live-stack', 'test task');
    // Deliberately no session_id set

    const dispatchCalls: string[] = [];
    watcher.setDispatchInvestigation(async (stackId) => { dispatchCalls.push(stackId); });

    let statusChangeCalled = false;
    watcher.setOnStatusChange(() => { statusChangeCalled = true; });

    watcher.watch('live-stack', 'c1');
    await vi.advanceTimersByTimeAsync(TEST_STALL_THRESHOLD + TEST_LIVENESS_INTERVAL * 2);

    // No dispatch — falls back to needs_human
    expect(dispatchCalls).toHaveLength(0);

    // Task should be in needs_human state
    const updatedTask = registry.getMostRecentTask('live-stack');
    expect(updatedTask?.status).toBe('needs_human');
    expect(updatedTask?.warnings).toContain('no resumable session');
    expect(statusChangeCalled).toBe(true);

    // Watcher should be gone after needs_human
    // @ts-expect-error
    expect(watcher.livenessTimers.has('live-stack')).toBe(false);

    watcher.unwatchAll();
  });

  // ─── Token_limited recovery fallback (edge case 2) ─────────────────────────

  it('existing token_limited → session_paused path is NOT disrupted by liveness', async () => {
    // Sequence: running → token_limited (normal watcher path, not liveness)
    const runtime = createLivenessMockRuntime({
      logSize: 500, // log has content, not stalled
      pgrepOut: '9999', // process alive
      statusSequence: ['running', 'token_limited'],
    });
    const watcher = new TaskWatcher(registry, runtime, runtime, {
      pollInterval: 50, // fast poll so token_limited is seen quickly
      livenessCheckInterval: TEST_LIVENESS_INTERVAL,
      livenessStallThreshold: TEST_STALL_THRESHOLD,
    });

    const task = registry.createTask('live-stack', 'test task');
    registry.setTaskSessionId(task.id, 'token-session');

    const dispatchCalls: string[] = [];
    watcher.setDispatchInvestigation(async (stackId) => { dispatchCalls.push(stackId); });

    watcher.watch('live-stack', 'c1');

    // Advance enough for token_limited to be seen by the main poll
    await vi.advanceTimersByTimeAsync(200);

    // Stack should be session_paused (normal token_limited path)
    const stack = registry.getStack('live-stack');
    expect(stack?.status).toBe('session_paused');

    // No liveness dispatch triggered
    expect(dispatchCalls).toHaveLength(0);

    watcher.unwatchAll();
  });

  // ─── Module-level constant values ───────────────────────────────────────────

  it('exports correct production threshold constants', () => {
    expect(LIVENESS_CHECK_INTERVAL_MS).toBe(60_000);
    expect(LIVENESS_STALL_THRESHOLD_MS).toBe(5 * 60_000);
  });
});
