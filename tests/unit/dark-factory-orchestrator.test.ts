import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const mockExecFile = mockExecFileInner;

function makeRegistry(overrides: Partial<{
  getDarkFactoryEnabled: (dir: string) => boolean;
  getStack: (id: string) => unknown;
  getProjectTicketConfig: (dir: string) => null;
  setBoardTicketColumn: () => void;
}> = {}) {
  return {
    getDarkFactoryEnabled: vi.fn().mockReturnValue(false),
    getStack: vi.fn().mockReturnValue(null),
    getProjectTicketConfig: vi.fn().mockReturnValue(null),
    setBoardTicketColumn: vi.fn(),
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
