import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DarkFactoryOrchestrator } from '../../src/main/control-plane/dark-factory-orchestrator';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/main/tray', () => ({
  showNotification: vi.fn(),
}));

vi.mock('../../src/main/control-plane/pr-creator', () => ({
  workspacePathFor: vi.fn((projectDir: string, stackId: string) =>
    `${projectDir}/.sandstorm/workspaces/${stackId}`,
  ),
  draftPullRequest: vi.fn(),
  createPullRequest: vi.fn(),
}));

vi.mock('../../src/main/control-plane/ticket-config', () => ({
  fetchTicketWithConfig: vi.fn().mockResolvedValue(''),
}));

// execFile mock needs [util.promisify.custom] so promisify() resolves { stdout, stderr }
// (matching real Node.js execFile promise behaviour).
const { mockExecFileInner } = vi.hoisted(() => ({ mockExecFileInner: vi.fn() }));

vi.mock('child_process', async () => {
  const { promisify } = await import('util');
  const inner = mockExecFileInner;
  const execFileMock = Object.assign(inner, {
    [promisify.custom]: (...args: unknown[]) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const cb = (err: unknown, stdout: string, stderr: string) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        };
        inner(...args, cb);
      }),
  });
  return { execFile: execFileMock };
});

import { showNotification } from '../../src/main/tray';
import { draftPullRequest, createPullRequest, workspacePathFor } from '../../src/main/control-plane/pr-creator';
import { fetchTicketWithConfig } from '../../src/main/control-plane/ticket-config';

const mockExecFile = mockExecFileInner;

function makeRegistry(overrides: Partial<{
  getDarkFactoryEnabled: (dir: string) => boolean;
  getStack: (id: string) => unknown;
  getProjectTicketConfig: (dir: string) => null;
  setBoardTicketColumn: () => void;
  listBoardTickets: (dir: string) => unknown[];
  listProjects: () => { directory: string }[];
}> = {}) {
  return {
    getDarkFactoryEnabled: vi.fn().mockReturnValue(false),
    getStack: vi.fn().mockReturnValue(null),
    getProjectTicketConfig: vi.fn().mockReturnValue(null),
    setBoardTicketColumn: vi.fn(),
    listBoardTickets: vi.fn().mockReturnValue([]),
    listProjects: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

function makeStackManager() {
  return {
    createStack: vi.fn(),
    push: vi.fn().mockResolvedValue(undefined),
    setPullRequest: vi.fn(),
    teardownStack: vi.fn().mockResolvedValue(undefined),
    execInContainer: vi.fn().mockResolvedValue(undefined),
    getTaskOutput: vi.fn().mockResolvedValue(''),
  };
}

function makeAgentBackend() {
  return {
    runEphemeralAgent: vi.fn().mockResolvedValue(''),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DarkFactoryOrchestrator', () => {
  let registry: ReturnType<typeof makeRegistry>;
  let stackManager: ReturnType<typeof makeStackManager>;
  let agentBackend: ReturnType<typeof makeAgentBackend>;
  let notifyUpdate: ReturnType<typeof vi.fn>;
  let orchestrator: DarkFactoryOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = makeRegistry();
    stackManager = makeStackManager();
    agentBackend = makeAgentBackend();
    notifyUpdate = vi.fn();
    orchestrator = new DarkFactoryOrchestrator(
      registry as never,
      stackManager as never,
      agentBackend as never,
      notifyUpdate,
    );
  });

  // -------------------------------------------------------------------------
  // handleTicketColumnChanged — gating
  // -------------------------------------------------------------------------
  describe('handleTicketColumnChanged — flag OFF', () => {
    it('does nothing when dark factory is disabled', async () => {
      registry.getDarkFactoryEnabled.mockReturnValue(false);
      orchestrator.handleTicketColumnChanged('T-1', '/proj', 'spec_ready');
      // Allow microtasks to flush
      await new Promise((r) => setTimeout(r, 0));
      expect(stackManager.createStack).not.toHaveBeenCalled();
    });

    it('does nothing for non spec_ready columns', async () => {
      registry.getDarkFactoryEnabled.mockReturnValue(true);
      orchestrator.handleTicketColumnChanged('T-1', '/proj', 'in_stack');
      await new Promise((r) => setTimeout(r, 0));
      expect(stackManager.createStack).not.toHaveBeenCalled();
    });
  });

  describe('handleTicketColumnChanged — flag ON', () => {
    it('calls createStack and moves ticket to in_stack when spec_ready and flag is ON', async () => {
      registry.getDarkFactoryEnabled.mockReturnValue(true);
      orchestrator.handleTicketColumnChanged('T-42', '/proj', 'spec_ready');
      await new Promise((r) => setTimeout(r, 10));
      expect(registry.setBoardTicketColumn).toHaveBeenCalledWith('T-42', '/proj', 'in_stack');
      expect(stackManager.createStack).toHaveBeenCalledWith(
        expect.objectContaining({
          ticket: 'T-42',
          projectDir: '/proj',
          gateApproved: true,
          runtime: 'docker',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // handleTaskCompleted — gating
  // -------------------------------------------------------------------------
  describe('handleTaskCompleted — flag OFF', () => {
    it('does nothing when flag is OFF', async () => {
      registry.getStack.mockReturnValue({ ticket: 'T-1', project_dir: '/proj' });
      registry.getDarkFactoryEnabled.mockReturnValue(false);
      orchestrator.handleTaskCompleted('stack-1', {} as never);
      await new Promise((r) => setTimeout(r, 0));
      expect(vi.mocked(draftPullRequest)).not.toHaveBeenCalled();
    });

    it('does nothing when stack has no ticket', async () => {
      registry.getStack.mockReturnValue({ ticket: null, project_dir: '/proj' });
      registry.getDarkFactoryEnabled.mockReturnValue(true);
      orchestrator.handleTaskCompleted('stack-1', {} as never);
      await new Promise((r) => setTimeout(r, 0));
      expect(vi.mocked(draftPullRequest)).not.toHaveBeenCalled();
    });
  });

  describe('handleTaskCompleted — flag ON', () => {
    it('calls draftPullRequest when flag is ON and stack has ticket', async () => {
      registry.getStack.mockReturnValue({ ticket: 'T-1', project_dir: '/proj' });
      registry.getDarkFactoryEnabled.mockReturnValue(true);

      vi.mocked(draftPullRequest).mockResolvedValue({ title: 'feat: T-1', body: 'body' });
      vi.mocked(createPullRequest).mockResolvedValue({ url: 'https://gh/pr/1', number: 1 });

      // Stub execFile for the merge step (pr view + pr merge)
      mockExecFile.mockImplementation(
        (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          if ((args as string[]).includes('view')) {
            cb(null, JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), '');
          } else {
            cb(null, '', '');
          }
          return {} as never;
        },
      );

      orchestrator.handleTaskCompleted('stack-1', {} as never);
      await new Promise((r) => setTimeout(r, 50));

      expect(vi.mocked(draftPullRequest)).toHaveBeenCalledWith(
        expect.objectContaining({ stackId: 'stack-1' }),
        expect.any(Object),
      );
    });
  });

  // -------------------------------------------------------------------------
  // handlePrCreated — gating
  // -------------------------------------------------------------------------
  describe('handlePrCreated — flag OFF', () => {
    it('does nothing when flag is OFF', async () => {
      registry.getStack.mockReturnValue({ ticket: 'T-1', project_dir: '/proj' });
      registry.getDarkFactoryEnabled.mockReturnValue(false);
      orchestrator.handlePrCreated('stack-1', 99);
      await new Promise((r) => setTimeout(r, 0));
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe('handlePrCreated — flag ON, no conflicts', () => {
    beforeEach(() => {
      registry.getStack.mockReturnValue({ ticket: 'T-1', project_dir: '/proj' });
      registry.getDarkFactoryEnabled.mockReturnValue(true);
    });

    it('calls gh pr merge --squash --auto when no conflicts', async () => {
      mockExecFile.mockImplementation(
        (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          if ((args as string[]).includes('view')) {
            cb(null, JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), '');
          } else {
            cb(null, '', '');
          }
          return {} as never;
        },
      );

      orchestrator.handlePrCreated('stack-1', 99);
      await new Promise((r) => setTimeout(r, 50));

      const mergeCalls = (mockExecFile.mock.calls as unknown[][]).filter(
        (c) => (c[1] as string[]).includes('merge'),
      );
      const autoMergeCall = mergeCalls.find(
        (c) => (c[1] as string[]).includes('--auto'),
      );
      expect(autoMergeCall).toBeDefined();
      const args = autoMergeCall![1] as string[];
      expect(args).toContain('--squash');
      expect(args).toContain('--auto');
    });

    it('falls back to gh pr merge --squash when --auto is rejected', async () => {
      let autoAttempted = false;
      mockExecFile.mockImplementation(
        (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          const a = args as string[];
          if (a.includes('view')) {
            cb(null, JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), '');
          } else if (a.includes('--auto') && !autoAttempted) {
            autoAttempted = true;
            cb(Object.assign(new Error('auto-merge is disabled'), { stderr: 'auto-merge is disabled' }), '', 'auto-merge is disabled');
          } else {
            cb(null, '', '');
          }
          return {} as never;
        },
      );

      orchestrator.handlePrCreated('stack-1', 99);
      await new Promise((r) => setTimeout(r, 50));

      const fallbackCall = (mockExecFile.mock.calls as unknown[][]).find(
        (c) => (c[1] as string[]).includes('merge') && !(c[1] as string[]).includes('--auto'),
      );
      expect(fallbackCall).toBeDefined();
      const args = fallbackCall![1] as string[];
      expect(args).toContain('--squash');
      expect(args).not.toContain('--auto');
    });

    it('advances card to merged after successful merge', async () => {
      mockExecFile.mockImplementation(
        (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          if ((args as string[]).includes('view')) {
            cb(null, JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), '');
          } else {
            cb(null, '', '');
          }
          return {} as never;
        },
      );

      orchestrator.handlePrCreated('stack-1', 99);
      await new Promise((r) => setTimeout(r, 50));

      expect(stackManager.teardownStack).toHaveBeenCalledWith('stack-1');
      expect(registry.setBoardTicketColumn).toHaveBeenCalledWith('T-1', '/proj', 'merged');
    });

    it('treats already-merged PR as success (swallows --auto error)', async () => {
      mockExecFile.mockImplementation(
        (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          const a = args as string[];
          if (a.includes('view')) {
            cb(null, JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), '');
          } else if (a.includes('--auto')) {
            cb(Object.assign(new Error('Pull request is already merged'), { stderr: 'Pull request is already merged' }), '', '');
          } else {
            cb(null, '', '');
          }
          return {} as never;
        },
      );

      orchestrator.handlePrCreated('stack-1', 99);
      await new Promise((r) => setTimeout(r, 50));

      // Already-merged is treated as success — card should advance
      expect(registry.setBoardTicketColumn).toHaveBeenCalledWith('T-1', '/proj', 'merged');
    });
  });

  // -------------------------------------------------------------------------
  // handleDarkFactoryEnabled — scan-on-enable
  // -------------------------------------------------------------------------
  describe('handleDarkFactoryEnabled', () => {
    function makeTicket(id: string, col: string, created: string) {
      return { ticket_id: id, column: col, project_dir: '/proj', title: '', created_at: created, updated_at: created };
    }

    let fastOrchestrator: DarkFactoryOrchestrator;

    beforeEach(() => {
      // Use 0ms poll so tests resolve without advancing timers
      fastOrchestrator = new DarkFactoryOrchestrator(
        registry as never,
        stackManager as never,
        agentBackend as never,
        notifyUpdate,
        600_000,
        0,
      );
    });

    it('starts a stack for every spec_ready ticket when enabled (regression)', async () => {
      registry.listBoardTickets.mockReturnValue([
        makeTicket('T-1', 'spec_ready', '2024-01-01T00:00:00'),
        makeTicket('T-2', 'spec_ready', '2024-01-02T00:00:00'),
      ]);
      registry.getStack.mockReturnValue({ status: 'up' });

      await fastOrchestrator.handleDarkFactoryEnabled('/proj');

      expect(stackManager.createStack).toHaveBeenCalledTimes(2);
      expect(registry.setBoardTicketColumn).toHaveBeenCalledWith('T-1', expect.any(String), 'in_stack');
      expect(registry.setBoardTicketColumn).toHaveBeenCalledWith('T-2', expect.any(String), 'in_stack');
    });

    it('dispatches in created_at-ascending order', async () => {
      registry.listBoardTickets.mockReturnValue([
        makeTicket('T-1', 'spec_ready', '2024-01-01T00:00:00'),
        makeTicket('T-2', 'spec_ready', '2024-01-02T00:00:00'),
        makeTicket('T-3', 'spec_ready', '2024-01-03T00:00:00'),
      ]);
      registry.getStack.mockReturnValue({ status: 'up' });

      await fastOrchestrator.handleDarkFactoryEnabled('/proj');

      const calls = stackManager.createStack.mock.calls;
      expect(calls).toHaveLength(3);
      expect((calls[0][0] as { ticket: string }).ticket).toBe('T-1');
      expect((calls[1][0] as { ticket: string }).ticket).toBe('T-2');
      expect((calls[2][0] as { ticket: string }).ticket).toBe('T-3');
    });

    it('waits for stack N to be ready before dispatching N+1 (serialization)', async () => {
      registry.listBoardTickets.mockReturnValue([
        makeTicket('T-1', 'spec_ready', '2024-01-01T00:00:00'),
        makeTicket('T-2', 'spec_ready', '2024-01-02T00:00:00'),
      ]);

      const events: string[] = [];
      let t1PollCount = 0;
      registry.getStack.mockImplementation((name: string) => {
        if (name === 'ticket-t-1') {
          t1PollCount++;
          const status = t1PollCount === 1 ? 'building' : 'up';
          events.push(`poll:${name}:${status}`);
          return { status };
        }
        events.push(`poll:${name}:up`);
        return { status: 'up' };
      });
      stackManager.createStack.mockImplementation((opts: { ticket: string }) => {
        events.push(`create:${opts.ticket}`);
      });

      await fastOrchestrator.handleDarkFactoryEnabled('/proj');

      // T-1 must have been polled at least once (saw 'building') before T-2 was created
      const buildingIdx = events.findIndex((e) => e === 'poll:ticket-t-1:building');
      const createT2Idx = events.indexOf('create:T-2');
      expect(buildingIdx).toBeGreaterThanOrEqual(0);
      expect(createT2Idx).toBeGreaterThan(buildingIdx);
    });

    it('continues batch when stack reaches failed (Q4)', async () => {
      registry.listBoardTickets.mockReturnValue([
        makeTicket('T-1', 'spec_ready', '2024-01-01T00:00:00'),
        makeTicket('T-2', 'spec_ready', '2024-01-02T00:00:00'),
      ]);
      registry.getStack
        .mockReturnValueOnce({ status: 'failed' })
        .mockReturnValue({ status: 'up' });

      await fastOrchestrator.handleDarkFactoryEnabled('/proj');

      expect(stackManager.createStack).toHaveBeenCalledTimes(2);
      // Both tickets moved to in_stack (failed ticket stays there, not reverted)
      const inStackCalls = registry.setBoardTicketColumn.mock.calls.filter(
        (c) => c[2] === 'in_stack',
      );
      expect(inStackCalls).toHaveLength(2);
      expect(stackManager.teardownStack).not.toHaveBeenCalled();
    });

    it('continues batch when stack hangs in building past timeout (Q5)', async () => {
      vi.useFakeTimers();

      const timeoutOrchestrator = new DarkFactoryOrchestrator(
        registry as never,
        stackManager as never,
        agentBackend as never,
        notifyUpdate,
        100,  // 100ms timeout so the test advances only a little
        50,   // 50ms poll interval
      );

      registry.listBoardTickets.mockReturnValue([
        makeTicket('T-1', 'spec_ready', '2024-01-01T00:00:00'),
        makeTicket('T-2', 'spec_ready', '2024-01-02T00:00:00'),
      ]);
      registry.getStack.mockImplementation((name: string) => {
        if (name === 'ticket-t-1') return { status: 'building' };
        return { status: 'up' };
      });

      const scanPromise = timeoutOrchestrator.handleDarkFactoryEnabled('/proj');
      await vi.advanceTimersByTimeAsync(200);
      await scanPromise;

      // Both stacks dispatched; T-1 stayed in_stack after timeout
      expect(stackManager.createStack).toHaveBeenCalledTimes(2);
      const inStackCalls = registry.setBoardTicketColumn.mock.calls.filter(
        (c) => c[2] === 'in_stack',
      );
      expect(inStackCalls).toHaveLength(2);
      expect(stackManager.teardownStack).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('no-op when spec_ready column is empty', async () => {
      registry.listBoardTickets.mockReturnValue([
        makeTicket('T-1', 'backlog', '2024-01-01T00:00:00'),
        makeTicket('T-2', 'in_stack', '2024-01-02T00:00:00'),
      ]);

      await fastOrchestrator.handleDarkFactoryEnabled('/proj');

      expect(stackManager.createStack).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // darkFactory:setEnabled off→on guard (tested via handleDarkFactoryEnabled)
  // -------------------------------------------------------------------------
  describe('off→on guard', () => {
    function makeTicket(id: string) {
      return { ticket_id: id, column: 'spec_ready', project_dir: '/proj', title: '', created_at: '2024-01-01T00:00:00', updated_at: '2024-01-01T00:00:00' };
    }

    let guardOrchestrator: DarkFactoryOrchestrator;

    beforeEach(() => {
      guardOrchestrator = new DarkFactoryOrchestrator(
        registry as never,
        stackManager as never,
        agentBackend as never,
        notifyUpdate,
        600_000,
        0,
      );
    });

    it('dispatches when called on an off→on transition', async () => {
      registry.listBoardTickets.mockReturnValue([makeTicket('T-1')]);
      registry.getStack.mockReturnValue({ status: 'up' });

      await guardOrchestrator.handleDarkFactoryEnabled('/proj');

      expect(stackManager.createStack).toHaveBeenCalledTimes(1);
    });

    it('does not re-dispatch when called a second time (already-enabled guard in IPC)', async () => {
      // The off→on guard lives in the IPC handler (reads prior state before writing).
      // handleDarkFactoryEnabled itself has no guard — it just processes whatever spec_ready
      // tickets it finds. This test documents that calling it twice dispatches twice,
      // confirming the guard must live in the caller (ipc.ts).
      registry.listBoardTickets.mockReturnValue([makeTicket('T-1')]);
      registry.getStack.mockReturnValue({ status: 'up' });

      // Simulate that the ticket was already moved to in_stack after first enable
      registry.setBoardTicketColumn.mockImplementation(() => {
        // After first call, ticket is no longer in spec_ready
        registry.listBoardTickets.mockReturnValue([]);
      });

      await guardOrchestrator.handleDarkFactoryEnabled('/proj');
      await guardOrchestrator.handleDarkFactoryEnabled('/proj'); // second call: empty spec_ready

      // createStack only called once because second call found no spec_ready tickets
      expect(stackManager.createStack).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // reconcileSpecReady — startup dispatch and periodic safety-net
  // -------------------------------------------------------------------------
  describe('reconcileSpecReady', () => {
    function makeTicket(id: string, col: string = 'spec_ready') {
      return { ticket_id: id, column: col, project_dir: '/proj', title: '', created_at: '2024-01-01T00:00:00', updated_at: '2024-01-01T00:00:00' };
    }

    let fastOrchestrator: DarkFactoryOrchestrator;

    beforeEach(() => {
      fastOrchestrator = new DarkFactoryOrchestrator(
        registry as never,
        stackManager as never,
        agentBackend as never,
        notifyUpdate,
        600_000,
        0,
      );
    });

    afterEach(() => {
      fastOrchestrator.destroy();
    });

    it('regression: dispatches a stranded spec_ready ticket with no existing stack on startup', async () => {
      registry.getDarkFactoryEnabled.mockReturnValue(true);
      registry.listBoardTickets.mockReturnValue([makeTicket('T-1')]);
      registry.getStack.mockReturnValue(null); // no stack exists

      await fastOrchestrator.reconcileSpecReady('/proj');

      expect(stackManager.createStack).toHaveBeenCalledTimes(1);
      expect(stackManager.createStack).toHaveBeenCalledWith(
        expect.objectContaining({ ticket: 'T-1', projectDir: '/proj', gateApproved: true }),
      );
      expect(registry.setBoardTicketColumn).toHaveBeenCalledWith('T-1', expect.any(String), 'in_stack');
    });

    it('dedup: skips a spec_ready ticket whose stack already exists in the registry', async () => {
      registry.getDarkFactoryEnabled.mockReturnValue(true);
      registry.listBoardTickets.mockReturnValue([makeTicket('T-1')]);
      registry.getStack.mockReturnValue({ status: 'up' }); // stack already exists

      await fastOrchestrator.reconcileSpecReady('/proj');

      expect(stackManager.createStack).not.toHaveBeenCalled();
    });

    it('skips a project with Dark Factory disabled', async () => {
      registry.getDarkFactoryEnabled.mockReturnValue(false);
      registry.listBoardTickets.mockReturnValue([makeTicket('T-1')]);

      await fastOrchestrator.reconcileSpecReady('/proj');

      expect(stackManager.createStack).not.toHaveBeenCalled();
    });

    it('multi-project: only dispatches for Dark-Factory-enabled projects', async () => {
      registry.getDarkFactoryEnabled.mockImplementation((dir: string) => dir === '/proj-a');
      registry.listBoardTickets.mockImplementation((dir: string) => {
        if (dir === '/proj-a') return [makeTicket('T-1')];
        if (dir === '/proj-b') return [makeTicket('T-2')];
        return [];
      });
      registry.getStack.mockReturnValue(null);
      registry.listProjects.mockReturnValue([{ directory: '/proj-a' }, { directory: '/proj-b' }]);

      await fastOrchestrator.reconcileSpecReady('/proj-a');
      await fastOrchestrator.reconcileSpecReady('/proj-b');

      expect(stackManager.createStack).toHaveBeenCalledTimes(1);
      expect(stackManager.createStack).toHaveBeenCalledWith(
        expect.objectContaining({ ticket: 'T-1', projectDir: '/proj-a' }),
      );
    });

    it('periodic watcher: dispatches a ticket that appears in spec_ready between ticks', async () => {
      vi.useFakeTimers();

      const watcherOrchestrator = new DarkFactoryOrchestrator(
        registry as never,
        stackManager as never,
        agentBackend as never,
        notifyUpdate,
        600_000,
        0,
        100, // 100ms watcher interval
      );

      registry.getDarkFactoryEnabled.mockReturnValue(true);
      registry.listProjects.mockReturnValue([{ directory: '/proj' }]);
      registry.getStack.mockReturnValue(null);
      // No tickets initially
      registry.listBoardTickets.mockReturnValue([]);

      watcherOrchestrator.startPeriodicWatcher();

      // Advance past first tick — nothing dispatched yet
      await vi.advanceTimersByTimeAsync(110);
      expect(stackManager.createStack).not.toHaveBeenCalled();

      // Ticket appears in spec_ready
      registry.listBoardTickets.mockReturnValue([makeTicket('T-1')]);

      // Advance past second tick — ticket should be dispatched
      await vi.advanceTimersByTimeAsync(110);
      expect(stackManager.createStack).toHaveBeenCalledTimes(1);
      expect(stackManager.createStack).toHaveBeenCalledWith(
        expect.objectContaining({ ticket: 'T-1' }),
      );

      watcherOrchestrator.destroy();
      vi.useRealTimers();
    });

    it('re-entrancy: concurrent reconcile calls do not double-dispatch the same ticket', async () => {
      registry.getDarkFactoryEnabled.mockReturnValue(true);
      registry.getStack.mockReturnValue(null);

      let resolveStartStack!: () => void;
      const startStackBlocker = new Promise<void>((resolve) => { resolveStartStack = resolve; });

      // Make fetchTicketWithConfig hang so startStack is slow
      registry.listBoardTickets.mockReturnValue([makeTicket('T-1')]);
      registry.getProjectTicketConfig.mockReturnValue({ provider: 'test' } as never);

      vi.mocked(fetchTicketWithConfig).mockImplementation(() => startStackBlocker.then(() => ''));

      // Start first reconcile (won't complete until startStackBlocker resolves)
      const first = fastOrchestrator.reconcileSpecReady('/proj');

      // Second reconcile should be blocked by re-entrancy guard
      const second = fastOrchestrator.reconcileSpecReady('/proj');

      // Resolve the blocker so first call can finish
      resolveStartStack();
      await Promise.all([first, second]);

      // Only one stack should have been created
      expect(stackManager.createStack).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Merge conflict resolution
  // -------------------------------------------------------------------------
  describe('conflict resolution', () => {
    beforeEach(() => {
      registry.getStack.mockReturnValue({ ticket: 'T-1', project_dir: '/proj' });
      registry.getDarkFactoryEnabled.mockReturnValue(true);
    });

    it('spawns runEphemeralAgent when conflicts detected, then merges on success', async () => {
      let viewCallCount = 0;
      mockExecFile.mockImplementation(
        (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          const a = args as string[];
          if (a.includes('view')) {
            viewCallCount++;
            // First call: conflicted. Second call (after resolution): clean.
            if (viewCallCount <= 1) {
              cb(null, JSON.stringify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), '');
            } else {
              cb(null, JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), '');
            }
          } else {
            cb(null, '', '');
          }
          return {} as never;
        },
      );

      orchestrator.handlePrCreated('stack-1', 99);
      await new Promise((r) => setTimeout(r, 100));

      expect(agentBackend.runEphemeralAgent).toHaveBeenCalledTimes(1);
      expect(agentBackend.runEphemeralAgent).toHaveBeenCalledWith(
        expect.stringContaining('resolve'),
        '/proj',
        300_000,
      );
      expect(registry.setBoardTicketColumn).toHaveBeenCalledWith('T-1', '/proj', 'merged');
    });

    it('notifies user and leaves card in pr_open after max attempts exhausted', async () => {
      mockExecFile.mockImplementation(
        (_cmd: unknown, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
          // Always report conflicted
          if ((args as string[]).includes('view')) {
            cb(null, JSON.stringify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), '');
          } else {
            cb(null, '', '');
          }
          return {} as never;
        },
      );

      orchestrator.handlePrCreated('stack-1', 99);
      await new Promise((r) => setTimeout(r, 200));

      // Should have tried up to 2 times
      expect(agentBackend.runEphemeralAgent.mock.calls.length).toBeLessThanOrEqual(2);
      expect(vi.mocked(showNotification)).toHaveBeenCalledWith(
        expect.stringContaining('merge needs attention'),
        expect.any(String),
      );
      // Card stays in pr_open — setBoardTicketColumn should NOT be called with 'merged'
      const mergedCalls = vi.mocked(registry.setBoardTicketColumn).mock.calls.filter(
        (c) => c[2] === 'merged',
      );
      expect(mergedCalls).toHaveLength(0);
    });
  });
});
