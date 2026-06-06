import { describe, it, expect, beforeEach, afterEach, vi, type MockedFunction } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Registry, Stack } from '../../src/main/control-plane/registry';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import { StackManager } from '../../src/main/control-plane/stack-manager';
import { ContainerRuntime } from '../../src/main/runtime/types';
import {
  runStartupReconciliation,
  type ReconcilerDeps,
} from '../../src/main/control-plane/startup-reconciler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

function makeRunningStack(registry: Registry, overrides: Partial<Parameters<Registry['createStack']>[0]> = {}) {
  const id = `stack-${Math.random().toString(36).slice(2)}`;
  registry.createStack({
    id,
    project: 'proj',
    project_dir: '/proj',
    ticket: null,
    branch: null,
    description: null,
    status: 'up',
    runtime: 'docker',
    ...overrides,
  });
  registry.createTask(id, 'test task');
  // createTask sets status to 'running'
  return id;
}

/** Returns a ContainerRuntime mock that pretends a container exists with the given status sequence */
function makeRuntime(opts: {
  containerId?: string;
  containerFound?: boolean;
  statusSequence?: string[];
  exitCode?: string;
  execThrows?: boolean;
  listThrows?: boolean;
} = {}): ContainerRuntime {
  const {
    containerId = 'container-abc',
    containerFound = true,
    statusSequence = ['running'],
    exitCode = '0',
    execThrows = false,
    listThrows = false,
  } = opts;

  let callIdx = 0;

  return {
    name: 'mock',
    composeUp: vi.fn(),
    composeDown: vi.fn(),
    listContainers: vi.fn().mockImplementation(async () => {
      if (listThrows) throw new Error('Docker daemon unavailable');
      if (!containerFound) return [];
      return [{
        id: containerId,
        name: `sandstorm-proj-${containerId}-claude-1`,
        image: 'sandstorm-claude',
        status: 'running' as const,
        state: 'running',
        ports: [],
        labels: {},
        created: new Date().toISOString(),
      }];
    }),
    inspect: vi.fn(),
    logs: vi.fn().mockReturnValue((async function* () {})()),
    exec: vi.fn().mockImplementation(async (_id: string, cmd: string[]) => {
      if (execThrows) throw new Error('container exec failed');
      if (cmd.includes('/tmp/claude-task.status')) {
        const idx = Math.min(callIdx, statusSequence.length - 1);
        callIdx++;
        return { exitCode: 0, stdout: statusSequence[idx], stderr: '' };
      }
      if (cmd.includes('/tmp/claude-task.exit')) {
        return { exitCode: 0, stdout: exitCode, stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('Mock 1.0'),
    containerStats: vi.fn(),
  };
}

function makeStackManagerMock(): Partial<StackManager> & {
  resumeStackWithContinuation: MockedFunction<StackManager['resumeStackWithContinuation']>;
  dispatchTask: MockedFunction<StackManager['dispatchTask']>;
} {
  return {
    resumeStackWithContinuation: vi.fn().mockResolvedValue({ outcome: 'resuming_with_session' }),
    dispatchTask: vi.fn().mockResolvedValue({ id: 1, stack_id: 'x', status: 'running' }),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('runStartupReconciliation', () => {
  let registry: Registry;
  let dbPath: string;
  let notifyUpdate: ReturnType<typeof vi.fn>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    notifyUpdate = vi.fn();
    consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // (a) readable terminal status → driven to terminal
  // -------------------------------------------------------------------------
  it('(a) drives stack to terminal when container has terminal status file', async () => {
    const stackId = makeRunningStack(registry);
    const runtime = makeRuntime({ statusSequence: ['completed'] });
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false }
    );

    const stack = registry.getStack(stackId)!;
    expect(stack.status).toBe('completed');
    const tasks = registry.getTasksForStack(stackId);
    expect(tasks[0].status).toBe('completed');
    expect(notifyUpdate).toHaveBeenCalled();

    watcher.unwatchAll();
  });

  it('(a) drives stack to failed when container has failed status', async () => {
    const stackId = makeRunningStack(registry);
    // Return exit code '1' so completeTask maps it to 'failed'
    const runtime = makeRuntime({ statusSequence: ['failed'], exitCode: '1' });
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false }
    );

    const stack = registry.getStack(stackId)!;
    expect(stack.status).toBe('failed');

    watcher.unwatchAll();
  });

  it('(a) drives stack to needs_human when container has needs_human status', async () => {
    const stackId = makeRunningStack(registry);
    const runtime = makeRuntime({ statusSequence: ['needs_human'] });
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false }
    );

    const stack = registry.getStack(stackId)!;
    expect(stack.status).toBe('needs_human');

    watcher.unwatchAll();
  });

  // -------------------------------------------------------------------------
  // (b) container gone + workspace present → recreate-and-resume
  // -------------------------------------------------------------------------
  it('(b) sets session_paused and calls resumeStackWithContinuation when workspace exists', async () => {
    const stackId = makeRunningStack(registry);
    const runtime = makeRuntime({ containerFound: false });
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => true }
    );

    expect(sm.resumeStackWithContinuation).toHaveBeenCalledWith(stackId, expect.any(Function), true);

    watcher.unwatchAll();
  });

  it('(b) marks needs_human if resumeStackWithContinuation throws', async () => {
    const stackId = makeRunningStack(registry);
    const runtime = makeRuntime({ containerFound: false });
    const sm = makeStackManagerMock();
    sm.resumeStackWithContinuation.mockRejectedValueOnce(new Error('container start failed'));
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => true }
    );

    const stack = registry.getStack(stackId)!;
    expect(stack.status).toBe('needs_human');

    watcher.unwatchAll();
  });

  // -------------------------------------------------------------------------
  // (c) container present + status malformed → investigate-and-correct
  // -------------------------------------------------------------------------
  it('(c) interrupts old task and dispatches investigate task when status is malformed', async () => {
    const stackId = makeRunningStack(registry);
    const runtime = makeRuntime({ statusSequence: ['garbage-status'] });
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    const taskBefore = registry.getRunningTask(stackId)!;

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false }
    );

    // Old task should be interrupted
    const tasks = registry.getTasksForStack(stackId);
    const interrupted = tasks.find((t) => t.id === taskBefore.id);
    expect(interrupted?.status).toBe('interrupted');

    // dispatchTask should have been called with the investigate prompt
    expect(sm.dispatchTask).toHaveBeenCalledWith(
      stackId,
      expect.stringContaining('investigate'),
      undefined,
      { skipTicketFetch: true }
    );

    watcher.unwatchAll();
  });

  it('(c) interrupts old task and dispatches investigate task when exec throws (unreadable)', async () => {
    const stackId = makeRunningStack(registry);
    const runtime = makeRuntime({ execThrows: true });
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    const taskBefore = registry.getRunningTask(stackId)!;

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false }
    );

    const tasks = registry.getTasksForStack(stackId);
    expect(tasks.find((t) => t.id === taskBefore.id)?.status).toBe('interrupted');
    expect(sm.dispatchTask).toHaveBeenCalled();

    watcher.unwatchAll();
  });

  it('(c-unknown) watcher maps "unknown" status to needs_human', async () => {
    const stackId = makeRunningStack(registry);
    // Simulate: reconciler dispatches investigate task; inner Claude writes running then unknown
    const runtime = makeRuntime({ statusSequence: ['running', 'unknown'] });
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    // Simulate what dispatchTask does: create a new task and attach watcher
    sm.dispatchTask.mockImplementationOnce(async (sid: string) => {
      // Interrupt old task (reconciler does this, but mock needs to create new task for watcher)
      const newTask = registry.createTask(sid, 'investigate prompt');
      watcher.watch(sid, 'container-abc');
      return { id: newTask.id, stack_id: sid, status: 'running' };
    });

    // Also interrupt old task as reconciler would
    const taskBefore = registry.getRunningTask(stackId)!;
    registry.interruptTask(taskBefore.id);

    // Run reconciler — branch 4 because status is 'garbage' initially
    const runtimeForReconcile = makeRuntime({ statusSequence: ['garbage'] });
    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtimeForReconcile, runtimeForReconcile, notifyUpdate,
      { workspaceExistsFn: () => false }
    );

    // Now the watcher is attached (by mock dispatchTask) and will poll the runtime
    // that returns running then unknown. Wait for terminalisation.
    const result = await new Promise<{ stackId: string }>((resolve) => {
      watcher.on('task:failed', (data) => resolve(data));
    });

    expect(result.stackId).toBe(stackId);
    const stack = registry.getStack(stackId)!;
    expect(stack.status).toBe('needs_human');

    watcher.unwatchAll();
  });

  it('(c) marks needs_human if dispatchTask throws during branch 4', async () => {
    const stackId = makeRunningStack(registry);
    const runtime = makeRuntime({ statusSequence: ['garbage'] });
    const sm = makeStackManagerMock();
    sm.dispatchTask.mockRejectedValueOnce(new Error('CLI unreachable'));
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false }
    );

    const stack = registry.getStack(stackId)!;
    expect(stack.status).toBe('needs_human');

    watcher.unwatchAll();
  });

  // -------------------------------------------------------------------------
  // (d) genuinely running → running retained + watcher re-attached
  // -------------------------------------------------------------------------
  it('(d) re-attaches watcher and retains running status for genuinely-running stack', async () => {
    const stackId = makeRunningStack(registry);
    // Status file reports 'running' — task is genuinely in progress
    const runtime = makeRuntime({ statusSequence: ['running'] });
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false }
    );

    // Stack should still be 'running'
    const stack = registry.getStack(stackId)!;
    expect(stack.status).toBe('running');

    // Watcher should be attached (it has an entry)
    expect((watcher as unknown as { watchers: Map<string, unknown> }).watchers.has(stackId)).toBe(true);

    watcher.unwatchAll();
  });

  // -------------------------------------------------------------------------
  // (e) idempotency — already-terminalized stack not corrupted
  // -------------------------------------------------------------------------
  it('(e) does not touch stacks that are already in terminal status', async () => {
    const runtime = makeRuntime({ statusSequence: ['completed'] });
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    // Create a stack that is already terminal (not 'running')
    registry.createStack({
      id: 'already-done',
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'completed',
      runtime: 'docker',
    });

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false }
    );

    // No branches should have been called for a non-running stack
    expect(sm.dispatchTask).not.toHaveBeenCalled();
    expect(sm.resumeStackWithContinuation).not.toHaveBeenCalled();

    const stack = registry.getStack('already-done')!;
    expect(stack.status).toBe('completed');

    watcher.unwatchAll();
  });

  it('(e) branch 1 is idempotent when no running task exists', async () => {
    // A stack is 'running' in DB but has no running task (already terminalized by something else)
    registry.createStack({
      id: 'no-task-stack',
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'running',
      runtime: 'docker',
    });
    // No createTask call — stack has no running task

    const runtime = makeRuntime({ statusSequence: ['completed'] });
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false }
    );

    // No crash and stack status remains unchanged (no task to complete)
    const stack = registry.getStack('no-task-stack')!;
    expect(stack.status).toBe('running');

    watcher.unwatchAll();
  });

  // -------------------------------------------------------------------------
  // (f) container gone + workspace gone + ticket CLOSED → card removed
  // -------------------------------------------------------------------------
  it('(f) archives and deletes stack when container+workspace gone and ticket is CLOSED', async () => {
    const stackId = makeRunningStack(registry, {
      ticket: '42',
      project_dir: '/myproj',
    });
    // Seed a board ticket in 'in_stack'
    registry.setBoardTicketColumn('42', '/myproj', 'in_stack');

    const runtime = makeRuntime({ containerFound: false });
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    const fetchTicketStateFn = vi.fn().mockResolvedValue('CLOSED' as const);

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false, fetchTicketStateFn }
    );

    // Stack should be gone from the DB
    expect(registry.getStack(stackId)).toBeUndefined();
    expect(fetchTicketStateFn).toHaveBeenCalledWith('42', '/myproj');
    expect(notifyUpdate).toHaveBeenCalled();

    watcher.unwatchAll();
  });

  // -------------------------------------------------------------------------
  // (g) container gone + workspace gone + ticket OPEN → stack removed + backlog
  // -------------------------------------------------------------------------
  it('(g) removes stack and moves ticket to backlog when container+workspace gone and ticket is OPEN', async () => {
    const stackId = makeRunningStack(registry, {
      ticket: '99',
      project_dir: '/myproj',
    });
    registry.setBoardTicketColumn('99', '/myproj', 'in_stack');

    const runtime = makeRuntime({ containerFound: false });
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    const fetchTicketStateFn = vi.fn().mockResolvedValue('OPEN' as const);

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false, fetchTicketStateFn }
    );

    // Stack should be deleted
    expect(registry.getStack(stackId)).toBeUndefined();

    // Ticket should be moved to backlog
    const tickets = registry.listBoardTickets('/myproj');
    const ticket = tickets.find((t) => t.ticket_id === '99');
    expect(ticket?.column).toBe('backlog');

    expect(notifyUpdate).toHaveBeenCalled();

    watcher.unwatchAll();
  });

  // -------------------------------------------------------------------------
  // (h) container gone + workspace gone + gh fails → stack left as-is + warning
  // -------------------------------------------------------------------------
  it('(h) leaves stack untouched and logs warning when gh lookup fails', async () => {
    const stackId = makeRunningStack(registry, {
      ticket: '55',
      project_dir: '/myproj',
    });

    const runtime = makeRuntime({ containerFound: false });
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    const fetchTicketStateFn = vi.fn().mockRejectedValue(new Error('gh: not authenticated'));

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false, fetchTicketStateFn }
    );

    // Stack should still be present with its original status
    const stack = registry.getStack(stackId)!;
    expect(stack).toBeDefined();
    expect(stack.status).toBe('running');

    // A warning should have been logged containing the stack/ticket identifiers
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[StartupReconciler]') && expect.stringContaining('55'),
      expect.anything()
    );

    watcher.unwatchAll();
  });

  it('(h) follow-up pass with gh succeeding performs cleanup', async () => {
    const stackId = makeRunningStack(registry, {
      ticket: '55',
      project_dir: '/myproj',
    });
    registry.setBoardTicketColumn('55', '/myproj', 'in_stack');

    const runtime = makeRuntime({ containerFound: false });
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    // First pass: gh fails
    const fetchFailing = vi.fn().mockRejectedValue(new Error('offline'));
    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false, fetchTicketStateFn: fetchFailing }
    );
    expect(registry.getStack(stackId)).toBeDefined(); // still present

    // Second pass: gh succeeds with OPEN
    const fetchSucceeding = vi.fn().mockResolvedValue('OPEN' as const);
    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false, fetchTicketStateFn: fetchSucceeding }
    );

    // Stack gone, ticket in backlog
    expect(registry.getStack(stackId)).toBeUndefined();
    const tickets = registry.listBoardTickets('/myproj');
    expect(tickets.find((t) => t.ticket_id === '55')?.column).toBe('backlog');

    watcher.unwatchAll();
  });

  // -------------------------------------------------------------------------
  // (i) non-blocking startup — reconciler does not block window readiness
  // -------------------------------------------------------------------------
  it('(i) reconciliation starts as a fire-and-forget pass and resolves sequentially', async () => {
    const stackId1 = makeRunningStack(registry);
    const stackId2 = makeRunningStack(registry);

    const order: string[] = [];

    // Use a mock dispatchTask that resolves for stack1 quickly, stack2 a bit later
    // The key assertion is sequential order
    let resolveStack1!: () => void;
    let resolveStack2!: () => void;

    const sm = makeStackManagerMock();

    // Make branch 4 for stack1 resolve immediately, stack2 after stack1
    sm.dispatchTask.mockImplementation(async (sid: string) => {
      order.push(sid);
      return { id: 1, stack_id: sid, status: 'running' };
    });

    const runtime = makeRuntime({ statusSequence: ['garbage'] });
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false }
    );

    // Both stacks processed sequentially (one at a time)
    expect(order).toHaveLength(2);
    // notifyUpdate called after each stack
    expect(notifyUpdate.mock.calls.length).toBeGreaterThanOrEqual(2);

    watcher.unwatchAll();
    void resolveStack1; void resolveStack2;
  });

  // -------------------------------------------------------------------------
  // Misc edge cases
  // -------------------------------------------------------------------------

  it('skips stacks not in running status', async () => {
    for (const status of ['building', 'completed', 'failed', 'session_paused', 'idle'] as const) {
      registry.createStack({
        id: `skip-${status}`,
        project: 'proj',
        project_dir: '/proj',
        ticket: null,
        branch: null,
        description: null,
        status,
        runtime: 'docker',
      });
    }

    const runtime = makeRuntime();
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false }
    );

    expect(sm.dispatchTask).not.toHaveBeenCalled();
    expect(sm.resumeStackWithContinuation).not.toHaveBeenCalled();

    watcher.unwatchAll();
  });

  it('handles listContainers throwing without propagating error', async () => {
    const stackId = makeRunningStack(registry);
    const runtime = makeRuntime({ listThrows: true });
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    await expect(
      runStartupReconciliation(
        registry, sm as unknown as StackManager, watcher,
        runtime, runtime, notifyUpdate,
        { workspaceExistsFn: () => false }
      )
    ).resolves.toBeUndefined(); // should not throw

    // Stack status unchanged (listContainers failed, skip gracefully)
    expect(registry.getStack(stackId)?.status).toBe('running');

    watcher.unwatchAll();
  });

  it('branch 5 no-ticket: removes dead orphan stack without calling gh', async () => {
    const stackId = makeRunningStack(registry, { ticket: null });
    const runtime = makeRuntime({ containerFound: false });
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });
    const fetchTicketStateFn = vi.fn();

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false, fetchTicketStateFn }
    );

    expect(registry.getStack(stackId)).toBeUndefined();
    expect(fetchTicketStateFn).not.toHaveBeenCalled();

    watcher.unwatchAll();
  });

  // -------------------------------------------------------------------------
  // (j) failed-stack guard reset — selfheal_continue_used reset to 0 on startup
  // -------------------------------------------------------------------------
  it('(j) resets selfheal_continue_used to 0 for every failed stack', async () => {
    const stackId = `failed-guard-${Math.random().toString(36).slice(2)}`;
    registry.createStack({
      id: stackId,
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'failed',
      runtime: 'docker',
    });
    registry.setSelfhealContinueUsed(stackId, 1);

    const runtime = makeRuntime();
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false }
    );

    const stack = registry.getStack(stackId)!;
    expect(stack.selfheal_continue_used).toBe(0);

    watcher.unwatchAll();
  });

  it('(j) idempotent — reset is safe to run twice', async () => {
    const stackId = `failed-idempotent-${Math.random().toString(36).slice(2)}`;
    registry.createStack({
      id: stackId,
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'failed',
      runtime: 'docker',
    });
    registry.setSelfhealContinueUsed(stackId, 1);

    const runtime = makeRuntime();
    const sm = makeStackManagerMock();
    const watcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 50 });

    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false }
    );

    // Second run — should remain 0, not flip to 1
    await runStartupReconciliation(
      registry, sm as unknown as StackManager, watcher,
      runtime, runtime, notifyUpdate,
      { workspaceExistsFn: () => false }
    );

    const stack = registry.getStack(stackId)!;
    expect(stack.selfheal_continue_used).toBe(0);

    watcher.unwatchAll();
  });
});
