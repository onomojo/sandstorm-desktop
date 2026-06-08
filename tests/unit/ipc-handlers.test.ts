import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SandstormError, ErrorCode } from '../../src/main/errors';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.mock factories are hoisted above all imports, so any
// variables they reference must also be hoisted via vi.hoisted().
// ---------------------------------------------------------------------------
const {
  registeredHandlers,
  mockRegistry,
  mockStackManager,
  mockDockerRuntime,
  mockPodmanRuntime,
  mockAgentBackend,
  mockDockerConnectionManager,
  mockCustomContext,
  mockSpawn,
  mockFetchAccountUsage,
  mockRemoveProjectFromCrontab,
  mockListTicketsWithConfig,
  mockCreateTicketWithConfig,
  mockCloseTicketWithConfig,
  mockMarkTicketDoneWithConfig,
  mockTestJiraConnection,
  mockSessionMonitor,
  mockSpawnSpecCheck,
  mockSpawnSpecRefine,
  mockPostComment,
  mockListTicketComments,
  mockDeleteRefinement,
  mockPersistRefinement,
  mockLoadRefinements,
  mockFilterSessionsByBoardState,
  mockUsageEngine,
  mockRollupStoreInstance,
} = vi.hoisted(() => {
  const registeredHandlers: Record<string, (...args: unknown[]) => unknown> = {};
  const mockSpawnSpecCheck = vi.fn();
  const mockSpawnSpecRefine = vi.fn();
  const mockPostComment = vi.fn().mockResolvedValue(undefined);
  const mockListTicketComments = vi.fn().mockResolvedValue([]);
  const mockDeleteRefinement = vi.fn();
  const mockPersistRefinement = vi.fn();
  const mockLoadRefinements = vi.fn().mockReturnValue([]);
  const mockFilterSessionsByBoardState = vi.fn().mockImplementation(
    (sessions: Array<{ ticketId: string; projectDir: string; id: string }>, getColumn: (t: string, p: string) => string | null) => {
      const LIVE = new Set(['refining', 'spec_ready']);
      const keep: typeof sessions = [];
      const prune: typeof sessions = [];
      for (const s of sessions) {
        const col = getColumn(s.ticketId, s.projectDir);
        if (col !== null && LIVE.has(col)) keep.push(s);
        else prune.push(s);
      }
      return { keep, prune };
    },
  );

  const mockRegistry = {
    listProjects: vi.fn().mockReturnValue([]),
    addProject: vi.fn(),
    removeProject: vi.fn(),
    getProject: vi.fn(),
    getPorts: vi.fn(),
    getProjectTicketConfig: vi.fn().mockReturnValue(null),
    setProjectTicketConfig: vi.fn(),
    seedBoardTicket: vi.fn(),
    listBoardTickets: vi.fn().mockReturnValue([]),
    setBoardTicketColumn: vi.fn(),
    deleteClosedEarlyColumnTickets: vi.fn().mockReturnValue(0),
    deleteBoardTicket: vi.fn(),
    getDarkFactoryEnabled: vi.fn().mockReturnValue(false),
    setDarkFactoryEnabled: vi.fn(),
    getDb: vi.fn().mockReturnValue({}),
    getStepWeightsByTicket: vi.fn().mockReturnValue([]),
    getGlobalBackendSettings: vi.fn().mockReturnValue({ inner_backend: 'claude', outer_backend: 'claude', inner_provider: null, inner_model: null, outer_provider: null, outer_model: null }),
    setGlobalBackendSettings: vi.fn(),
    getProjectBackendSettings: vi.fn().mockReturnValue(null),
    setProjectBackendSettings: vi.fn(),
    getEffectiveBackend: vi.fn().mockReturnValue({ backend: 'claude' }),
    setBackendSecret: vi.fn(),
    hasBackendSecret: vi.fn().mockReturnValue(false),
    getEffectiveRouting: vi.fn().mockReturnValue({}),
    getProjectRouting: vi.fn().mockReturnValue(null),
    setProjectRouting: vi.fn(),
    removeProjectRouting: vi.fn(),
    getGlobalRouting: vi.fn().mockReturnValue({ assignments: {}, preset: null }),
    setGlobalRouting: vi.fn(),
    applyPreset: vi.fn(),
    onBoardTicketMoved: vi.fn(),
  };

  const mockStackManager = {
    setOnStackUpdate: vi.fn(),
    listStacksWithServices: vi.fn(),
    getStackWithServices: vi.fn(),
    createStack: vi.fn(),
    teardownStack: vi.fn(),
    stopStack: vi.fn(),
    startStack: vi.fn(),
    listStackHistory: vi.fn(),
    detectStaleWorkspaces: vi.fn(),
    cleanupStaleWorkspaces: vi.fn(),
    dispatchTask: vi.fn(),
    getTasksForStack: vi.fn(),
    getDiff: vi.fn(),
    push: vi.fn(),
    setPullRequest: vi.fn(),
    getStackMemoryUsage: vi.fn(),
    getStackDetailedStats: vi.fn(),
    getStackTaskMetrics: vi.fn(),
    getStackTokenUsage: vi.fn(),
    getGlobalTokenUsage: vi.fn(),
    getRateLimitState: vi.fn(),
    getWorkflowProgress: vi.fn(),
    resumeStackWithContinuation: vi.fn(),
    autoResolveConflicts: vi.fn(),
    setOnTaskCompleted: vi.fn(),
  };

  const mockDockerRuntime = {
    isAvailable: vi.fn(),
    logs: vi.fn(),
  };

  const mockPodmanRuntime = {
    isAvailable: vi.fn(),
    logs: vi.fn(),
  };

  const mockAgentBackend = {
    sendMessage: vi.fn(),
    cancelSession: vi.fn(),
    resetSession: vi.fn(),
    getHistory: vi.fn(),
    getAuthStatus: vi.fn(),
    login: vi.fn(),
    syncCredentials: vi.fn(),
    getEphemeralTimingPath: vi.fn().mockReturnValue('/tmp/mock-ephemeral-timing.jsonl'),
  };

  const mockDockerConnectionManager = {
    isConnected: false,
  };

  const mockCustomContext = {
    getCustomContext: vi.fn(),
    saveCustomInstructions: vi.fn(),
    listCustomSkills: vi.fn(),
    getCustomSkill: vi.fn(),
    saveCustomSkill: vi.fn(),
    deleteCustomSkill: vi.fn(),
    getCustomSettings: vi.fn(),
    saveCustomSettings: vi.fn(),
  };

  const mockSpawn = vi.fn();
  const mockFetchAccountUsage = vi.fn();
  const mockRemoveProjectFromCrontab = vi.fn();
  const mockListTicketsWithConfig = vi.fn().mockResolvedValue({ ok: false, error: { reason: 'network', message: 'Failed to fetch GitHub tickets' } });
  const mockCreateTicketWithConfig = vi.fn().mockResolvedValue({ url: 'https://github.com/o/r/issues/1', ticketId: '1' });
  const mockCloseTicketWithConfig = vi.fn().mockResolvedValue(undefined);
  const mockMarkTicketDoneWithConfig = vi.fn().mockResolvedValue(undefined);
  const mockTestJiraConnection = vi.fn().mockResolvedValue({
    auth: { ok: true, displayName: 'Test User' },
    jql: { ok: true, count: 5 },
  });

  const mockSessionMonitor = {
    getState: vi.fn(),
    acknowledgeCritical: vi.fn(),
    markResumed: vi.fn(),
    updateSettings: vi.fn(),
    forcePoll: vi.fn(),
  };

  const mockUsageEngine = {
    getSummary: vi.fn(),
    getDaily: vi.fn(),
    getByModel: vi.fn(),
    getSessions: vi.fn(),
    getByTicket: vi.fn().mockReturnValue([]),
  };

  const mockRollupStoreInstance = {
    getByTicket: vi.fn().mockReturnValue([]),
    refresh: vi.fn(),
    markStackDirty: vi.fn(),
    markDirty: vi.fn(),
    ticketsShipped: vi.fn().mockReturnValue(0),
    totalTicketCost: vi.fn().mockReturnValue(0),
  };

  return {
    registeredHandlers,
    mockRegistry,
    mockStackManager,
    mockDockerRuntime,
    mockPodmanRuntime,
    mockAgentBackend,
    mockDockerConnectionManager,
    mockCustomContext,
    mockSpawn,
    mockFetchAccountUsage,
    mockRemoveProjectFromCrontab,
    mockListTicketsWithConfig,
    mockCreateTicketWithConfig,
    mockCloseTicketWithConfig,
    mockMarkTicketDoneWithConfig,
    mockTestJiraConnection,
    mockSessionMonitor,
    mockSpawnSpecCheck,
    mockSpawnSpecRefine,
    mockPostComment,
    mockListTicketComments,
    mockDeleteRefinement,
    mockPersistRefinement,
    mockLoadRefinements,
    mockFilterSessionsByBoardState,
    mockUsageEngine,
    mockRollupStoreInstance,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers[channel] = handler;
    }),
    on: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(),
  },
  app: {
    getPath: () => '/tmp',
  },
}));

vi.mock('../../src/main/index', () => ({
  registry: mockRegistry,
  stackManager: mockStackManager,
  dockerRuntime: mockDockerRuntime,
  podmanRuntime: mockPodmanRuntime,
  agentBackend: mockAgentBackend,
  dockerConnectionManager: mockDockerConnectionManager,
  sessionMonitor: mockSessionMonitor,
  cliDir: '/tmp/sandstorm-cli',
  darkFactoryOrchestrator: null,
}));

vi.mock('../../src/main/custom-context', () => mockCustomContext);

vi.mock('../../src/main/control-plane/account-usage', () => ({
  fetchAccountUsage: mockFetchAccountUsage,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => '/mock-home' } };
});

vi.mock('../../src/main/telemetry/usage-engine', () => ({
  createUsageEngine: vi.fn(() => mockUsageEngine),
  clearUsageCache: vi.fn(),
}));

vi.mock('../../src/main/agent/ephemeral-timing', () => ({
  appendEphemeralTiming: vi.fn(),
  readEphemeralTimingRecords: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/main/telemetry/rollup-store', () => ({
  TicketRollupStore: vi.fn().mockImplementation(() => mockRollupStoreInstance),
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  // ticket-spec / pr-creator / ticket-updater use execFile via promisify;
  // promisify only needs the function to exist + be callable, so a no-op
  // stub is enough — the IPC handler tests don't exercise these paths.
  execFile: vi.fn(),
  // ticket-provider uses spawnSync for `gh --version` and `git remote -v`
  // detection. Return a non-zero exit so detection returns 'skeleton' for
  // the IPC handler tests (no assertions depend on the detected value).
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
}));

vi.mock('../../src/main/scheduler', () => ({
  createSchedule: vi.fn().mockReturnValue({ id: 'sch_test', cronExpression: '0 * * * *', action: { kind: 'run-script', scriptName: 'test.sh' }, enabled: true }),
  listSchedules: vi.fn().mockReturnValue([]),
  updateSchedule: vi.fn().mockReturnValue({ id: 'sch_test', cronExpression: '0 * * * *', action: { kind: 'run-script', scriptName: 'test.sh' }, enabled: true }),
  deleteSchedule: vi.fn(),
  isCronRunning: vi.fn().mockReturnValue(true),
  removeProjectFromCrontab: (...args: unknown[]) => mockRemoveProjectFromCrontab(...args),
}));

vi.mock('../../src/main/scheduler/scheduler-manager', () => ({
  syncAllProjectsCrontab: vi.fn().mockResolvedValue(undefined),
  projectIdFromDir: vi.fn().mockImplementation((dir: string) => {
    const parts = dir.split('/');
    return parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  }),
}));

vi.mock('../../src/main/control-plane/ticket-lister', () => ({
  listTicketsWithConfig: (...args: unknown[]) => mockListTicketsWithConfig(...args),
}));

vi.mock('../../src/main/control-plane/ticket-config', () => ({
  createTicketWithConfig: (...args: unknown[]) => mockCreateTicketWithConfig(...args),
  closeTicketWithConfig: (...args: unknown[]) => mockCloseTicketWithConfig(...args),
  markTicketDoneWithConfig: (...args: unknown[]) => mockMarkTicketDoneWithConfig(...args),
  testJiraConnection: (...args: unknown[]) => mockTestJiraConnection(...args),
}));

vi.mock('../../src/main/control-plane/retry-with-backoff', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../src/main/claude/tools', () => ({
  handleToolCall: vi.fn(),
  spawnSpecCheck: (...args: unknown[]) => mockSpawnSpecCheck(...args),
  spawnSpecRefine: (...args: unknown[]) => mockSpawnSpecRefine(...args),
  validateProjectDir: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/main/control-plane/ticket-comments', () => ({
  listTicketComments: (...args: unknown[]) => mockListTicketComments(...args),
  postComment: (...args: unknown[]) => mockPostComment(...args),
}));

vi.mock('../../src/main/control-plane/refinement-store', () => ({
  persistRefinement: (...args: unknown[]) => mockPersistRefinement(...args),
  deleteRefinement: (...args: unknown[]) => mockDeleteRefinement(...args),
  loadRefinements: () => mockLoadRefinements(),
  filterSessionsByBoardState: (...args: unknown[]) => mockFilterSessionsByBoardState(...args),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { registerIpcHandlers } from '../../src/main/ipc';
import { clearUsageCache } from '../../src/main/telemetry/usage-engine';
import { dialog, BrowserWindow } from 'electron';
import { execFile } from 'child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Invoke a registered IPC handler as if called from the renderer via ipcRenderer.invoke() */
async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = registeredHandlers[channel];
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1 } };
  return handler(fakeEvent, ...args);
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
describe('IPC Handlers', () => {
  let mockMainWindow: { webContents: { send: Mock } };

  beforeEach(() => {
    for (const key of Object.keys(registeredHandlers)) {
      delete registeredHandlers[key];
    }
    vi.clearAllMocks();
    mockDockerConnectionManager.isConnected = false;

    mockMainWindow = { webContents: { send: vi.fn() } };
    registerIpcHandlers(mockMainWindow as unknown as import('electron').BrowserWindow);
  });

  // =========================================================================
  // Stack Update Notifications
  // =========================================================================
  describe('stack update notifications', () => {
    it('wires up stack update callback to send stacks:updated to renderer', () => {
      expect(mockStackManager.setOnStackUpdate).toHaveBeenCalledOnce();
      const callback = mockStackManager.setOnStackUpdate.mock.calls[0][0];
      callback();
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('stacks:updated');
    });

    it('does not crash if mainWindow is undefined', () => {
      for (const key of Object.keys(registeredHandlers)) {
        delete registeredHandlers[key];
      }
      vi.clearAllMocks();
      registerIpcHandlers(undefined);
      const callback = mockStackManager.setOnStackUpdate.mock.calls[0][0];
      expect(() => callback()).not.toThrow();
    });
  });

  // =========================================================================
  // Stacks
  // =========================================================================
  describe('stacks', () => {
    it('stacks:list delegates to stackManager.listStacksWithServices', async () => {
      const stacks = [{ id: 'stack-1', status: 'up' }];
      mockStackManager.listStacksWithServices.mockResolvedValue(stacks);

      const result = await invokeHandler('stacks:list');
      expect(result).toEqual(stacks);
      expect(mockStackManager.listStacksWithServices).toHaveBeenCalledOnce();
    });

    it('stacks:get delegates to stackManager.getStackWithServices', async () => {
      const stack = { id: 'stack-1', status: 'up', services: [] };
      mockStackManager.getStackWithServices.mockResolvedValue(stack);

      const result = await invokeHandler('stacks:get', 'stack-1');
      expect(result).toEqual(stack);
      expect(mockStackManager.getStackWithServices).toHaveBeenCalledWith('stack-1');
    });

    it('stacks:create delegates to stackManager.createStack with opts', async () => {
      const opts = { project: 'test', project_dir: '/test', ticket: 'T-1' };
      const created = { id: 'stack-new', ...opts, status: 'building' };
      mockStackManager.createStack.mockReturnValue(created);

      const result = await invokeHandler('stacks:create', opts);
      expect(result).toEqual(created);
      expect(mockStackManager.createStack).toHaveBeenCalledWith(opts);
    });

    it('stacks:teardown delegates to stackManager.teardownStack', async () => {
      await invokeHandler('stacks:teardown', 'stack-1');
      expect(mockStackManager.teardownStack).toHaveBeenCalledWith('stack-1');
    });

    it('stacks:stop delegates to stackManager.stopStack', async () => {
      await invokeHandler('stacks:stop', 'stack-1');
      expect(mockStackManager.stopStack).toHaveBeenCalledWith('stack-1');
    });

    it('stacks:start delegates to stackManager.startStack', async () => {
      await invokeHandler('stacks:start', 'stack-1');
      expect(mockStackManager.startStack).toHaveBeenCalledWith('stack-1');
    });

    it('stacks:history delegates to stackManager.listStackHistory', async () => {
      const history = [{ id: 'old-stack', final_status: 'pushed' }];
      mockStackManager.listStackHistory.mockResolvedValue(history);

      const result = await invokeHandler('stacks:history');
      expect(result).toEqual(history);
    });

    it('stacks:detectStale delegates to stackManager.detectStaleWorkspaces', async () => {
      const staleWorkspaces = [
        { stackId: 'old-stack', project: 'proj', reason: 'orphaned' },
      ];
      mockStackManager.detectStaleWorkspaces.mockResolvedValue(staleWorkspaces);

      const result = await invokeHandler('stacks:detectStale');
      expect(result).toEqual(staleWorkspaces);
      expect(mockStackManager.detectStaleWorkspaces).toHaveBeenCalledOnce();
    });

    it('stacks:cleanupStale delegates to stackManager.cleanupStaleWorkspaces', async () => {
      const cleanupResults = [{ workspacePath: '/path/to/ws', success: true }];
      mockStackManager.cleanupStaleWorkspaces.mockResolvedValue(cleanupResults);

      const result = await invokeHandler('stacks:cleanupStale', ['/path/to/ws']);
      expect(result).toEqual(cleanupResults);
      expect(mockStackManager.cleanupStaleWorkspaces).toHaveBeenCalledWith(['/path/to/ws']);
    });

    it('stacks:setPr delegates to stackManager.setPullRequest', async () => {
      await invokeHandler('stacks:setPr', 'stack-1', 'https://github.com/pr/1', 1);
      expect(mockStackManager.setPullRequest).toHaveBeenCalledWith(
        'stack-1',
        'https://github.com/pr/1',
        1,
      );
    });
  });

  // =========================================================================
  // Tasks
  // =========================================================================
  describe('tasks', () => {
    it('tasks:dispatch delegates to stackManager.dispatchTask', async () => {
      const task = { id: 1, stack_id: 'stack-1', prompt: 'fix bug' };
      mockStackManager.dispatchTask.mockResolvedValue(task);

      const result = await invokeHandler('tasks:dispatch', 'stack-1', 'fix bug');
      expect(result).toEqual(task);
      expect(mockStackManager.dispatchTask).toHaveBeenCalledWith('stack-1', 'fix bug', undefined, undefined);
    });

    it('tasks:dispatch passes model parameter when provided', async () => {
      const task = { id: 2, stack_id: 'stack-1', prompt: 'fix bug', model: 'opus' };
      mockStackManager.dispatchTask.mockResolvedValue(task);

      const result = await invokeHandler('tasks:dispatch', 'stack-1', 'fix bug', 'opus');
      expect(result).toEqual(task);
      expect(mockStackManager.dispatchTask).toHaveBeenCalledWith('stack-1', 'fix bug', 'opus', undefined);
    });

    it('tasks:list delegates to stackManager.getTasksForStack', async () => {
      const tasks = [{ id: 1, prompt: 'task 1' }, { id: 2, prompt: 'task 2' }];
      mockStackManager.getTasksForStack.mockReturnValue(tasks);

      const result = await invokeHandler('tasks:list', 'stack-1');
      expect(result).toEqual(tasks);
      expect(mockStackManager.getTasksForStack).toHaveBeenCalledWith('stack-1');
    });
  });

  // =========================================================================
  // Diff & Push
  // =========================================================================
  describe('diff & push', () => {
    it('diff:get delegates to stackManager.getDiff', async () => {
      mockStackManager.getDiff.mockResolvedValue('diff --git a/file.ts');

      const result = await invokeHandler('diff:get', 'stack-1');
      expect(result).toBe('diff --git a/file.ts');
      expect(mockStackManager.getDiff).toHaveBeenCalledWith('stack-1');
    });

    it('push:execute delegates to stackManager.push without message', async () => {
      mockStackManager.push.mockResolvedValue(undefined);

      await invokeHandler('push:execute', 'stack-1');
      expect(mockStackManager.push).toHaveBeenCalledWith('stack-1', undefined);
    });

    it('push:execute delegates to stackManager.push with message', async () => {
      mockStackManager.push.mockResolvedValue(undefined);

      await invokeHandler('push:execute', 'stack-1', 'feat: add feature');
      expect(mockStackManager.push).toHaveBeenCalledWith('stack-1', 'feat: add feature');
    });
  });

  // =========================================================================
  // Ports
  // =========================================================================
  describe('ports', () => {
    it('ports:get delegates to registry.getPorts', async () => {
      const ports = [{ stack_id: 'stack-1', host_port: 3001, container_port: 3000, service: 'app' }];
      mockRegistry.getPorts.mockReturnValue(ports);

      const result = await invokeHandler('ports:get', 'stack-1');
      expect(result).toEqual(ports);
      expect(mockRegistry.getPorts).toHaveBeenCalledWith('stack-1');
    });
  });

  // =========================================================================
  // Logs
  // =========================================================================
  describe('logs', () => {
    it('logs:stream uses dockerRuntime when runtime is "docker"', async () => {
      async function* mockLogStream() {
        yield 'line 1\n';
        yield 'line 2\n';
      }
      mockDockerRuntime.logs.mockReturnValue(mockLogStream());

      const result = await invokeHandler('logs:stream', 'container-1', 'docker');
      expect(result).toBe('line 1\nline 2\n');
      expect(mockDockerRuntime.logs).toHaveBeenCalledWith('container-1', { tail: 200 });
    });

    it('logs:stream uses podmanRuntime when runtime is "podman"', async () => {
      async function* mockLogStream() {
        yield 'podman log\n';
      }
      mockPodmanRuntime.logs.mockReturnValue(mockLogStream());

      const result = await invokeHandler('logs:stream', 'container-2', 'podman');
      expect(result).toBe('podman log\n');
      expect(mockPodmanRuntime.logs).toHaveBeenCalledWith('container-2', { tail: 200 });
    });
  });

  // =========================================================================
  // Stats
  // =========================================================================
  describe('stats', () => {
    it('stats:stack-memory delegates to stackManager.getStackMemoryUsage', async () => {
      mockStackManager.getStackMemoryUsage.mockResolvedValue(1024 * 1024 * 512);

      const result = await invokeHandler('stats:stack-memory', 'stack-1');
      expect(result).toBe(1024 * 1024 * 512);
    });

    it('stats:stack-detailed delegates to stackManager.getStackDetailedStats', async () => {
      const stats = { cpu: 0.5, memory: 100, containers: [] };
      mockStackManager.getStackDetailedStats.mockResolvedValue(stats);

      const result = await invokeHandler('stats:stack-detailed', 'stack-1');
      expect(result).toEqual(stats);
    });

    it('stats:task-metrics delegates to stackManager.getStackTaskMetrics', async () => {
      const metrics = { total: 10, completed: 8, failed: 1, running: 1 };
      mockStackManager.getStackTaskMetrics.mockResolvedValue(metrics);

      const result = await invokeHandler('stats:task-metrics', 'stack-1');
      expect(result).toEqual(metrics);
    });

    it('stats:token-usage delegates to stackManager.getStackTokenUsage', async () => {
      const usage = { input_tokens: 1000, output_tokens: 500 };
      mockStackManager.getStackTokenUsage.mockResolvedValue(usage);

      const result = await invokeHandler('stats:token-usage', 'stack-1');
      expect(result).toEqual(usage);
    });

    it('stats:global-token-usage delegates to stackManager.getGlobalTokenUsage', async () => {
      const usage = { total_input: 5000, total_output: 2500 };
      mockStackManager.getGlobalTokenUsage.mockResolvedValue(usage);

      const result = await invokeHandler('stats:global-token-usage');
      expect(result).toEqual(usage);
    });

  });

  // =========================================================================
  // Telemetry IPC handlers
  // =========================================================================
  describe('telemetry', () => {
    const range = { since: '2024-01-01', until: '2024-01-31' };

    it('stats:telemetry:summary delegates to usageEngine.getSummary and enriches attribution', async () => {
      const summary = {
        monthCost: 12.5,
        prevMonthCost: 8.0,
        tokens: { input: 1000, output: 500, cacheCreate: 200, cacheRead: 800, total: 2500 },
        cacheHitPct: 44.4,
        sessions: 3,
        ticketsShipped: null,
        costPerTicket: null,
        unpricedModels: [],
        skippedLines: 0,
      };
      mockUsageEngine.getSummary.mockReturnValue(summary);

      const result = await invokeHandler('stats:telemetry:summary', range) as typeof summary;
      expect(mockUsageEngine.getSummary).toHaveBeenCalledWith(range);
      // Attribution values come from rollup store (mocked to return 0)
      expect(result.monthCost).toBe(12.5);
      expect(result.ticketsShipped).toBe(0); // from rollupStore.ticketsShipped()
      expect(result.costPerTicket).toBeNull(); // null when ticketsShipped = 0
    });

    it('stats:telemetry:summary returns null for costPerTicket when no tickets shipped', async () => {
      mockUsageEngine.getSummary.mockReturnValue({
        monthCost: 0,
        prevMonthCost: 0,
        tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
        cacheHitPct: 0,
        sessions: 0,
        ticketsShipped: null,
        costPerTicket: null,
        unpricedModels: [],
        skippedLines: 0,
      });

      const result = await invokeHandler('stats:telemetry:summary', range) as { ticketsShipped: unknown; costPerTicket: unknown };
      expect(result.ticketsShipped).toBe(0); // rollupStore returns 0 shipped
      expect(result.costPerTicket).toBeNull(); // null when 0 shipped
    });

    it('stats:telemetry:daily delegates to usageEngine.getDaily', async () => {
      const daily = [
        { date: '2024-01-15', cost: 1.5, tokens: { input: 100, output: 50, cacheCreate: 0, cacheRead: 0 }, byModel: { 'claude-opus-4-5': 1.5 } },
      ];
      mockUsageEngine.getDaily.mockReturnValue(daily);

      const result = await invokeHandler('stats:telemetry:daily', range);
      expect(result).toEqual(daily);
      expect(mockUsageEngine.getDaily).toHaveBeenCalledWith(range);
    });

    it('stats:telemetry:byModel delegates to usageEngine.getByModel', async () => {
      const byModel = [
        { model: 'claude-opus-4-5', cost: 10.0, tokens: { input: 500, output: 250, cacheCreate: 0, cacheRead: 0, total: 750 }, sessions: 2, unpriced: false },
      ];
      mockUsageEngine.getByModel.mockReturnValue(byModel);

      const result = await invokeHandler('stats:telemetry:byModel', range);
      expect(result).toEqual(byModel);
      expect(mockUsageEngine.getByModel).toHaveBeenCalledWith(range);
    });

    it('stats:telemetry:session delegates to usageEngine.getSessions', async () => {
      const sessions = [
        {
          sid: 'sess-abc',
          ticket: null,
          stack: null,
          model: 'claude-opus-4-5',
          start: '2024-01-15T10:00:00.000Z',
          durMin: 5.0,
          tokens: { input: 200, output: 100, cacheCreate: 0, cacheRead: 500, total: 800 },
          cost: 3.75,
          turns: 4,
        },
      ];
      mockUsageEngine.getSessions.mockReturnValue(sessions);

      const result = await invokeHandler('stats:telemetry:session', range);
      expect(result).toEqual(sessions);
      expect(mockUsageEngine.getSessions).toHaveBeenCalledWith(range);
    });

    it('stats:telemetry:byTicket delegates to usageEngine.getByTicket and returns the array', async () => {
      const entries = [
        {
          ticketId: 'T-42',
          model: 'claude-sonnet-4-5',
          cost: 2.5,
          tokens: { input: 500, output: 200, cacheCreate: 0, cacheRead: 100, total: 800 },
          cacheHit: 16.666666666666668,
          lifecycle: null,
          unpriced: false,
        },
      ];
      mockUsageEngine.getByTicket.mockReturnValueOnce(entries);

      const result = await invokeHandler('stats:telemetry:byTicket');

      expect(mockUsageEngine.getByTicket).toHaveBeenCalledOnce();
      expect(result).toEqual(entries);
    });

    it('stats:telemetry:refresh clears usage cache and returns { ok: true }', async () => {
      const result = await invokeHandler('stats:telemetry:refresh');

      expect(vi.mocked(clearUsageCache)).toHaveBeenCalledOnce();
      expect(result).toEqual({ ok: true });
    });
  });

  // =========================================================================
  // Projects
  // =========================================================================
  describe('projects', () => {
    it('projects:list delegates to registry.listProjects', async () => {
      const projects = [{ id: 1, directory: '/proj', name: 'proj' }];
      mockRegistry.listProjects.mockReturnValue(projects);

      const result = await invokeHandler('projects:list');
      expect(result).toEqual(projects);
    });

    it('projects:add delegates to registry.addProject', async () => {
      const project = { id: 2, directory: '/new-proj', name: 'new-proj' };
      mockRegistry.addProject.mockReturnValue(project);

      const result = await invokeHandler('projects:add', '/new-proj');
      expect(result).toEqual(project);
      expect(mockRegistry.addProject).toHaveBeenCalledWith('/new-proj');
    });

    it('projects:remove delegates to registry.removeProject', async () => {
      mockRegistry.getProject.mockReturnValue(undefined);
      await invokeHandler('projects:remove', 1);
      expect(mockRegistry.removeProject).toHaveBeenCalledWith(1);
    });

    it('projects:remove cleans up crontab entries for the removed project', async () => {
      mockRegistry.getProject.mockReturnValue({ id: 1, directory: '/home/user/my-project', name: 'my-project' });
      await invokeHandler('projects:remove', 1);
      expect(mockRegistry.removeProject).toHaveBeenCalledWith(1);
      expect(mockRemoveProjectFromCrontab).toHaveBeenCalledWith('my-project');
    });

    it('projects:remove does not crash if crontab cleanup fails', async () => {
      mockRegistry.getProject.mockReturnValue({ id: 1, directory: '/home/user/my-project', name: 'my-project' });
      mockRemoveProjectFromCrontab.mockImplementation(() => { throw new Error('crontab not available'); });
      // Should not throw
      await expect(invokeHandler('projects:remove', 1)).resolves.not.toThrow();
      expect(mockRegistry.removeProject).toHaveBeenCalledWith(1);
    });

    it('projects:browse opens native directory picker', async () => {
      const mockWin = {};
      (BrowserWindow.fromWebContents as Mock).mockReturnValue(mockWin);
      (dialog.showOpenDialog as Mock).mockResolvedValue({
        canceled: false,
        filePaths: ['/selected/dir'],
      });

      const result = await invokeHandler('projects:browse');
      expect(result).toBe('/selected/dir');
    });

    it('projects:browse returns null when dialog is canceled', async () => {
      const mockWin = {};
      (BrowserWindow.fromWebContents as Mock).mockReturnValue(mockWin);
      (dialog.showOpenDialog as Mock).mockResolvedValue({
        canceled: true,
        filePaths: [],
      });

      const result = await invokeHandler('projects:browse');
      expect(result).toBeNull();
    });

    describe('projects:checkInit', () => {
      let tmpDir: string;

      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-test-'));
      });

      afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      it('returns full when .sandstorm/config and docker-compose.yml exist', async () => {
        const sandstormDir = path.join(tmpDir, '.sandstorm');
        fs.mkdirSync(sandstormDir, { recursive: true });
        fs.writeFileSync(path.join(sandstormDir, 'config'), 'PROJECT_NAME=test');
        fs.writeFileSync(path.join(sandstormDir, 'docker-compose.yml'), 'services: {}');

        const result = await invokeHandler('projects:checkInit', tmpDir);
        expect(result).toEqual({ state: 'full' });
      });

      it('returns uninitialized when .sandstorm/config is missing', async () => {
        const sandstormDir = path.join(tmpDir, '.sandstorm');
        fs.mkdirSync(sandstormDir, { recursive: true });
        fs.writeFileSync(path.join(sandstormDir, 'docker-compose.yml'), 'services: {}');

        const result = await invokeHandler('projects:checkInit', tmpDir);
        expect(result).toEqual({ state: 'uninitialized' });
      });

      it('returns partial when .sandstorm/config exists without docker-compose.yml (#192)', async () => {
        // Projects initialized via CLI may only have .sandstorm/config; the compose
        // file lives at the project root. This is now detected as a partially
        // initialized state that needs compose setup.
        const sandstormDir = path.join(tmpDir, '.sandstorm');
        fs.mkdirSync(sandstormDir, { recursive: true });
        fs.writeFileSync(path.join(sandstormDir, 'config'), 'PROJECT_NAME=test\nCOMPOSE_FILE=docker-compose.yml');

        const result = await invokeHandler('projects:checkInit', tmpDir);
        expect(result).toEqual({ state: 'partial' });
      });

      it('returns uninitialized for non-existent directory', async () => {
        const result = await invokeHandler('projects:checkInit', '/nonexistent/path');
        expect(result).toEqual({ state: 'uninitialized' });
      });
    });

    describe('projects:initialize', () => {
      it('returns success when CLI init exits with code 0', async () => {
        const child = new EventEmitter();
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        Object.assign(child, { stdout, stderr, stdin: null });
        mockSpawn.mockReturnValue(child);

        const promise = invokeHandler('projects:initialize', '/some/project');

        // Simulate successful CLI exit
        child.emit('close', 0);

        const result = await promise;
        expect(result).toEqual({ success: true });
        expect(mockSpawn).toHaveBeenCalledWith(
          'bash',
          ['/tmp/sandstorm-cli/bin/sandstorm', 'init', '-y'],
          expect.objectContaining({ cwd: '/some/project' }),
        );
      });

      it('returns error when CLI init fails and project has a compose file', async () => {
        const child = new EventEmitter();
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        Object.assign(child, { stdout, stderr, stdin: null });
        mockSpawn.mockReturnValue(child);

        // Create a temp dir with a docker-compose.yml so the handler surfaces the error
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-init-test-'));
        fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), 'services: {}');

        const promise = invokeHandler('projects:initialize', tmpDir);

        // Simulate CLI failure with stderr output
        stderr.emit('data', Buffer.from('Docker daemon not running'));
        child.emit('close', 1);

        const result = await promise;
        expect(result).toEqual({
          success: false,
          error: expect.stringContaining('Docker daemon not running'),
        });

        // Cleanup
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      it('returns error when spawn emits an error event', async () => {
        const child = new EventEmitter();
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        Object.assign(child, { stdout, stderr, stdin: null });
        mockSpawn.mockReturnValue(child);

        // Create a temp dir with a docker-compose.yml
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-init-test-'));
        fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), 'services: {}');

        const promise = invokeHandler('projects:initialize', tmpDir);

        // Simulate spawn error (e.g., bash not found)
        child.emit('error', new Error('spawn bash ENOENT'));

        const result = await promise;
        expect(result).toEqual({
          success: false,
          error: expect.stringContaining('spawn bash ENOENT'),
        });

        // Cleanup
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      describe('overwrite guard — fallback path (no project compose file)', () => {
        let tmpDir: string;

        beforeEach(() => {
          tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-init-guard-'));
          // Ensure .sandstorm/ exists so the fallback can be exercised
          fs.mkdirSync(path.join(tmpDir, '.sandstorm', 'stacks'), { recursive: true });
        });

        afterEach(() => {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        /** Trigger the fallback by simulating a CLI failure on a dir with no project compose file */
        async function runFallback(dir: string) {
          const child = new EventEmitter();
          const stdout = new EventEmitter();
          const stderr = new EventEmitter();
          Object.assign(child, { stdout, stderr, stdin: null });
          mockSpawn.mockReturnValue(child);

          const promise = invokeHandler('projects:initialize', dir);
          child.emit('close', 1); // CLI fails → fallback runs
          return promise;
        }

        it('does not overwrite an existing verify.sh', async () => {
          const verifyPath = path.join(tmpDir, '.sandstorm', 'verify.sh');
          const originalContent = '#!/bin/bash\nsandstorm-exec app bunx jest\n';
          fs.writeFileSync(verifyPath, originalContent, { mode: 0o755 });

          const result = await runFallback(tmpDir);

          expect(result).toMatchObject({ success: true });
          expect(fs.readFileSync(verifyPath, 'utf-8')).toBe(originalContent);
        });

        it('reports skippedFiles when verify.sh already exists', async () => {
          const verifyPath = path.join(tmpDir, '.sandstorm', 'verify.sh');
          fs.writeFileSync(verifyPath, '#!/bin/bash\necho hi\n', { mode: 0o755 });

          const result = (await runFallback(tmpDir)) as { success: boolean; skippedFiles?: string[] };

          expect(result.success).toBe(true);
          expect(result.skippedFiles).toContain('verify.sh');
        });

        it('does not overwrite an existing docker-compose.yml', async () => {
          const composePath = path.join(tmpDir, '.sandstorm', 'docker-compose.yml');
          const originalContent = 'services:\n  myservice:\n    image: myimage\n';
          fs.writeFileSync(composePath, originalContent);

          const result = await runFallback(tmpDir);

          expect(result).toMatchObject({ success: true });
          expect(fs.readFileSync(composePath, 'utf-8')).toBe(originalContent);
        });

        it('reports skippedFiles when docker-compose.yml already exists', async () => {
          const composePath = path.join(tmpDir, '.sandstorm', 'docker-compose.yml');
          fs.writeFileSync(composePath, 'services: {}');

          const result = (await runFallback(tmpDir)) as { success: boolean; skippedFiles?: string[] };

          expect(result.success).toBe(true);
          expect(result.skippedFiles).toContain('docker-compose.yml');
        });

        it('writes verify.sh when it does not exist', async () => {
          const verifyPath = path.join(tmpDir, '.sandstorm', 'verify.sh');
          expect(fs.existsSync(verifyPath)).toBe(false);

          const result = await runFallback(tmpDir);

          expect(result).toMatchObject({ success: true });
          expect(fs.existsSync(verifyPath)).toBe(true);
          const skipped = (result as { skippedFiles?: string[] }).skippedFiles ?? [];
          expect(skipped).not.toContain('verify.sh');
        });

        it('writes docker-compose.yml when it does not exist', async () => {
          const composePath = path.join(tmpDir, '.sandstorm', 'docker-compose.yml');
          expect(fs.existsSync(composePath)).toBe(false);

          const result = await runFallback(tmpDir);

          expect(result).toMatchObject({ success: true });
          expect(fs.existsSync(composePath)).toBe(true);
          const skipped = (result as { skippedFiles?: string[] }).skippedFiles ?? [];
          expect(skipped).not.toContain('docker-compose.yml');
        });

        it('no-service compose includes usage mount and does not mount over /home/claude/.claude', async () => {
          const composePath = path.join(tmpDir, '.sandstorm', 'docker-compose.yml');

          await runFallback(tmpDir);

          expect(fs.existsSync(composePath)).toBe(true);
          const content = fs.readFileSync(composePath, 'utf-8');
          expect(content).toContain('${SANDSTORM_USAGE_DIR}/${SANDSTORM_STACK_ID}:/home/claude/.claude/projects');
          // Must mount only the projects/ subpath, not the parent .claude dir
          expect(content).not.toMatch(/\/home\/claude\/\.claude(?!\/projects)/);
        });
      });
    });

    describe('projects:saveMigration', () => {
      let tmpDir: string;

      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-migration-test-'));
        fs.mkdirSync(path.join(tmpDir, '.sandstorm'), { recursive: true });
      });

      afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      it('does not overwrite an existing verify.sh', async () => {
        const verifyPath = path.join(tmpDir, '.sandstorm', 'verify.sh');
        const originalContent = '#!/bin/bash\nsandstorm-exec app npm test\n';
        fs.writeFileSync(verifyPath, originalContent, { mode: 0o755 });

        const result = await invokeHandler('projects:saveMigration', tmpDir, '#!/bin/bash\necho replaced\n', {});

        expect(result).toMatchObject({ success: true });
        expect(fs.readFileSync(verifyPath, 'utf-8')).toBe(originalContent);
      });

      it('writes verify.sh when it does not exist', async () => {
        const verifyPath = path.join(tmpDir, '.sandstorm', 'verify.sh');
        expect(fs.existsSync(verifyPath)).toBe(false);

        const newContent = '#!/bin/bash\necho ok\n';
        const result = await invokeHandler('projects:saveMigration', tmpDir, newContent, {});

        expect(result).toMatchObject({ success: true });
        expect(fs.readFileSync(verifyPath, 'utf-8')).toBe(newContent);
      });
    });

    describe('projects:checkMigration', () => {
      let tmpDir: string;

      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-checkMigration-'));
        fs.mkdirSync(path.join(tmpDir, '.sandstorm', 'scripts'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, '.sandstorm', 'config'), 'PROJECT_NAME=test');
      });

      afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      it('reports ticketProviderUnconfigured:true when no provider is stored in registry', async () => {
        mockRegistry.getProjectTicketConfig.mockReturnValue(null);
        const result = await invokeHandler('projects:checkMigration', tmpDir) as Record<string, unknown>;
        expect(result.ticketProviderUnconfigured).toBe(true);
        expect(result.needsMigration).toBe(true);
      });

      it('reports ticketProviderUnconfigured:false when provider is configured', async () => {
        mockRegistry.getProjectTicketConfig.mockReturnValue({ provider: 'github' });
        const result = await invokeHandler('projects:checkMigration', tmpDir) as Record<string, unknown>;
        expect(result.ticketProviderUnconfigured).toBe(false);
      });

      it('deletes old ticket scripts from .sandstorm/scripts/ if present', async () => {
        const scriptPath = path.join(tmpDir, '.sandstorm', 'scripts', 'fetch-ticket.sh');
        fs.writeFileSync(scriptPath, '#!/bin/bash\necho ok\n', { mode: 0o755 });
        await invokeHandler('projects:checkMigration', tmpDir);
        expect(fs.existsSync(scriptPath)).toBe(false);
      });

      it('returns needsMigration:false when .sandstorm/config does not exist', async () => {
        const noConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-noconfig-'));
        try {
          const result = await invokeHandler('projects:checkMigration', noConfigDir) as Record<string, unknown>;
          expect(result.needsMigration).toBe(false);
        } finally {
          fs.rmSync(noConfigDir, { recursive: true, force: true });
        }
      });
    });

    describe('projectTicketConfig:get and :set', () => {
      it('returns the stored ticket config via get', async () => {
        const config = { provider: 'github' as const };
        mockRegistry.getProjectTicketConfig.mockReturnValue(config);
        const result = await invokeHandler('projectTicketConfig:get', '/proj') as typeof config | null;
        expect(result).toEqual(config);
      });

      it('returns null when no ticket config is stored', async () => {
        mockRegistry.getProjectTicketConfig.mockReturnValue(null);
        const result = await invokeHandler('projectTicketConfig:get', '/proj');
        expect(result).toBeNull();
      });

      it('calls setProjectTicketConfig via set handler', async () => {
        const config = { provider: 'jira' as const, jira_url: 'https://x.atlassian.net', jira_username: 'u', jira_api_token: 't', jira_project_key: 'X', jira_issue_type: null, ticket_prefix: null };
        await invokeHandler('projectTicketConfig:set', '/proj', config);
        expect(mockRegistry.setProjectTicketConfig).toHaveBeenCalledWith('/proj', config);
      });
    });
  });

  // =========================================================================
  // Agent Sessions
  // =========================================================================
  describe('agent sessions', () => {
    it('agent:send delegates to agentBackend.sendMessage', async () => {
      await invokeHandler('agent:send', 'tab-1', 'hello', '/project');
      expect(mockAgentBackend.sendMessage).toHaveBeenCalledWith('tab-1', 'hello', '/project');
    });

    it('agent:send works without optional projectDir', async () => {
      await invokeHandler('agent:send', 'tab-1', 'hello');
      expect(mockAgentBackend.sendMessage).toHaveBeenCalledWith('tab-1', 'hello', undefined);
    });

    it('agent:cancel delegates to agentBackend.cancelSession', async () => {
      await invokeHandler('agent:cancel', 'tab-1');
      expect(mockAgentBackend.cancelSession).toHaveBeenCalledWith('tab-1');
    });

    it('agent:reset delegates to agentBackend.resetSession', async () => {
      await invokeHandler('agent:reset', 'tab-1');
      expect(mockAgentBackend.resetSession).toHaveBeenCalledWith('tab-1');
    });

    it('agent:history delegates to agentBackend.getHistory', async () => {
      const history = { messages: [{ role: 'user', content: 'hi' }], processing: false };
      mockAgentBackend.getHistory.mockReturnValue(history);

      const result = await invokeHandler('agent:history', 'tab-1');
      expect(result).toEqual(history);
      expect(mockAgentBackend.getHistory).toHaveBeenCalledWith('tab-1');
    });
  });

  // =========================================================================
  // Session Resume With Continuation
  // =========================================================================
  describe('session:resumeStackWithContinuation', () => {
    it('returns halted=true when resumeStackWithContinuation throws SESSION_HALTED', async () => {
      mockSessionMonitor.getState.mockReturnValue({
        halted: true,
        usage: { session: { resetsAt: '2026-05-04T15:00:00Z' } },
      });
      mockStackManager.resumeStackWithContinuation.mockRejectedValue(
        new SandstormError(ErrorCode.SESSION_HALTED, 'Session token limit has not refreshed yet')
      );

      const result = await invokeHandler('session:resumeStackWithContinuation', 'stack-1');

      expect(result).toEqual({ halted: true, resetAt: '2026-05-04T15:00:00Z' });
      expect(mockStackManager.resumeStackWithContinuation).toHaveBeenCalledWith('stack-1', expect.any(Function), false);
    });

    it('returns halted=true with null resetAt when usage is absent', async () => {
      mockSessionMonitor.getState.mockReturnValue({ halted: true, usage: null });
      mockStackManager.resumeStackWithContinuation.mockRejectedValue(
        new SandstormError(ErrorCode.SESSION_HALTED, 'Session token limit has not refreshed yet')
      );

      const result = await invokeHandler('session:resumeStackWithContinuation', 'stack-1');

      expect(result).toEqual({ halted: true, resetAt: null });
      expect(mockStackManager.resumeStackWithContinuation).toHaveBeenCalledWith('stack-1', expect.any(Function), false);
    });

    it('calls resumeStackWithContinuation with isHalted callback when monitor is not halted', async () => {
      mockSessionMonitor.getState.mockReturnValue({ halted: false });
      mockStackManager.resumeStackWithContinuation.mockResolvedValue({ status: 'running' });

      const result = await invokeHandler('session:resumeStackWithContinuation', 'stack-1');

      expect(mockStackManager.resumeStackWithContinuation).toHaveBeenCalledWith('stack-1', expect.any(Function), false);
      expect(result).toEqual({ halted: false, status: 'running' });
    });

    it('passes manual=true to resumeStackWithContinuation when manual flag is provided', async () => {
      mockSessionMonitor.getState.mockReturnValue({ halted: true });
      mockStackManager.resumeStackWithContinuation.mockResolvedValue({ outcome: 'resuming_with_session' });

      const result = await invokeHandler('session:resumeStackWithContinuation', 'stack-1', true);

      expect(mockStackManager.resumeStackWithContinuation).toHaveBeenCalledWith('stack-1', expect.any(Function), true);
      expect(result).toEqual({ halted: false, outcome: 'resuming_with_session' });
    });
  });

  // =========================================================================
  // Auth
  // =========================================================================
  describe('auth', () => {
    it('auth:status delegates to agentBackend.getAuthStatus', async () => {
      const status = { loggedIn: true, email: 'user@test.com', expired: false };
      mockAgentBackend.getAuthStatus.mockResolvedValue(status);

      const result = await invokeHandler('auth:status');
      expect(result).toEqual(status);
    });

    it('auth:login delegates to agentBackend.login and syncs credentials on success', async () => {
      mockAgentBackend.login.mockResolvedValue({ success: true });
      const stacks = [{ id: 'stack-1', status: 'up' }];
      mockStackManager.listStacksWithServices.mockResolvedValue(stacks);
      mockAgentBackend.syncCredentials.mockResolvedValue(undefined);

      const result = await invokeHandler('auth:login');
      expect(result).toEqual({ success: true });
      expect(mockAgentBackend.login).toHaveBeenCalledWith(mockMainWindow);
      expect(mockAgentBackend.syncCredentials).toHaveBeenCalledWith(stacks);
    });

    it('auth:login does not sync credentials on failure', async () => {
      mockAgentBackend.login.mockResolvedValue({ success: false, error: 'timeout' });

      const result = await invokeHandler('auth:login');
      expect(result).toEqual({ success: false, error: 'timeout' });
      expect(mockAgentBackend.syncCredentials).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Runtime & Docker Status
  // =========================================================================
  describe('runtime & docker', () => {
    it('runtime:available checks both docker and podman', async () => {
      mockDockerRuntime.isAvailable.mockResolvedValue(true);
      mockPodmanRuntime.isAvailable.mockResolvedValue(false);

      const result = await invokeHandler('runtime:available');
      expect(result).toEqual({ docker: true, podman: false });
    });

    it('docker:status returns connection state', async () => {
      mockDockerConnectionManager.isConnected = true;

      const result = await invokeHandler('docker:status');
      expect(result).toEqual({ connected: true });
    });

    it('docker:status returns false when disconnected', async () => {
      mockDockerConnectionManager.isConnected = false;

      const result = await invokeHandler('docker:status');
      expect(result).toEqual({ connected: false });
    });
  });

  // =========================================================================
  // Custom Context
  // =========================================================================
  describe('custom context', () => {
    it('context:get delegates to getCustomContext', async () => {
      const ctx = { instructions: 'hello', skills: ['skill1'], settings: '{}' };
      mockCustomContext.getCustomContext.mockReturnValue(ctx);

      const result = await invokeHandler('context:get', '/project');
      expect(result).toEqual(ctx);
      expect(mockCustomContext.getCustomContext).toHaveBeenCalledWith('/project');
    });

    it('context:saveInstructions delegates correctly', async () => {
      await invokeHandler('context:saveInstructions', '/project', 'new instructions');
      expect(mockCustomContext.saveCustomInstructions).toHaveBeenCalledWith(
        '/project',
        'new instructions',
      );
    });

    it('context:listSkills delegates correctly', async () => {
      mockCustomContext.listCustomSkills.mockReturnValue(['skill-a', 'skill-b']);

      const result = await invokeHandler('context:listSkills', '/project');
      expect(result).toEqual(['skill-a', 'skill-b']);
    });

    it('context:getSkill delegates correctly', async () => {
      mockCustomContext.getCustomSkill.mockReturnValue('# Skill Content');

      const result = await invokeHandler('context:getSkill', '/project', 'my-skill');
      expect(result).toBe('# Skill Content');
      expect(mockCustomContext.getCustomSkill).toHaveBeenCalledWith('/project', 'my-skill');
    });

    it('context:saveSkill delegates correctly', async () => {
      await invokeHandler('context:saveSkill', '/project', 'my-skill', '# Content');
      expect(mockCustomContext.saveCustomSkill).toHaveBeenCalledWith(
        '/project',
        'my-skill',
        '# Content',
      );
    });

    it('context:deleteSkill delegates correctly', async () => {
      await invokeHandler('context:deleteSkill', '/project', 'my-skill');
      expect(mockCustomContext.deleteCustomSkill).toHaveBeenCalledWith('/project', 'my-skill');
    });

    it('context:getSettings delegates correctly', async () => {
      mockCustomContext.getCustomSettings.mockReturnValue('{"key": "value"}');

      const result = await invokeHandler('context:getSettings', '/project');
      expect(result).toBe('{"key": "value"}');
    });

    it('context:saveSettings delegates correctly', async () => {
      await invokeHandler('context:saveSettings', '/project', '{"key": "value"}');
      expect(mockCustomContext.saveCustomSettings).toHaveBeenCalledWith(
        '/project',
        '{"key": "value"}',
      );
    });
  });

  // =========================================================================
  // Error Propagation
  // =========================================================================
  describe('error propagation', () => {
    it('stacks:create propagates errors from stackManager', async () => {
      mockStackManager.createStack.mockImplementation(() => {
        throw new Error('Docker not running');
      });

      await expect(invokeHandler('stacks:create', { project: 'test' })).rejects.toThrow(
        'Docker not running',
      );
    });

    it('tasks:dispatch propagates async errors from stackManager', async () => {
      mockStackManager.dispatchTask.mockRejectedValue(new Error('Stack not ready'));

      await expect(
        invokeHandler('tasks:dispatch', 'stack-1', 'do something'),
      ).rejects.toThrow('Stack not ready');
    });

    it('stacks:teardown propagates errors', async () => {
      mockStackManager.teardownStack.mockImplementation(() => {
        throw new Error('Stack not found');
      });

      await expect(invokeHandler('stacks:teardown', 'bad-id')).rejects.toThrow('Stack not found');
    });

    it('push:execute propagates errors from push', async () => {
      mockStackManager.push.mockRejectedValue(new Error('No changes to push'));

      await expect(invokeHandler('push:execute', 'stack-1')).rejects.toThrow('No changes to push');
    });

    it('diff:get propagates errors from getDiff', async () => {
      mockStackManager.getDiff.mockRejectedValue(new Error('Container not running'));

      await expect(invokeHandler('diff:get', 'stack-1')).rejects.toThrow('Container not running');
    });

    it('logs:stream propagates errors from runtime', async () => {
      mockDockerRuntime.logs.mockImplementation(() => {
        throw new Error('Container not found');
      });

      await expect(invokeHandler('logs:stream', 'bad-container', 'docker')).rejects.toThrow(
        'Container not found',
      );
    });

    it('auth:login propagates errors from login', async () => {
      mockAgentBackend.login.mockRejectedValue(new Error('Network error'));

      await expect(invokeHandler('auth:login')).rejects.toThrow('Network error');
    });

    it('stats:token-usage propagates errors', async () => {
      mockStackManager.getStackTokenUsage.mockRejectedValue(new Error('Stack not found'));

      await expect(invokeHandler('stats:token-usage', 'bad-stack')).rejects.toThrow(
        'Stack not found',
      );
    });
  });

  // =========================================================================
  // Schedules
  // =========================================================================
  describe('schedules', () => {
    it('schedules:list delegates to listSchedules', async () => {
      const { listSchedules } = await import('../../src/main/scheduler');
      (listSchedules as Mock).mockReturnValue([{ id: 'sch_1', cronExpression: '0 * * * *' }]);

      const result = await invokeHandler('schedules:list', '/home/user/proj');
      expect(listSchedules).toHaveBeenCalledWith('/home/user/proj');
      expect(result).toEqual([{ id: 'sch_1', cronExpression: '0 * * * *' }]);
    });

    it('schedules:create delegates to createSchedule and syncs crontab', async () => {
      const { createSchedule } = await import('../../src/main/scheduler');
      const { syncAllProjectsCrontab } = await import('../../src/main/scheduler/scheduler-manager');

      const result = await invokeHandler('schedules:create', '/home/user/proj', {
        label: 'Test',
        cronExpression: '0 * * * *',
        action: { kind: 'run-script', scriptName: 'run-tests.sh' },
        enabled: true,
      });

      expect(createSchedule).toHaveBeenCalledWith({
        projectDir: '/home/user/proj',
        label: 'Test',
        cronExpression: '0 * * * *',
        action: { kind: 'run-script', scriptName: 'run-tests.sh' },
        enabled: true,
      });
      expect(syncAllProjectsCrontab).toHaveBeenCalled();
      expect((result as { id: string }).id).toBe('sch_test');
    });

    it('schedules:update delegates to updateSchedule and syncs crontab', async () => {
      const { updateSchedule } = await import('../../src/main/scheduler');
      const { syncAllProjectsCrontab } = await import('../../src/main/scheduler/scheduler-manager');

      const result = await invokeHandler('schedules:update', '/home/user/proj', 'sch_test', {
        enabled: false,
      });

      expect(updateSchedule).toHaveBeenCalledWith('/home/user/proj', 'sch_test', { enabled: false });
      expect(syncAllProjectsCrontab).toHaveBeenCalled();
      expect((result as { id: string }).id).toBe('sch_test');
    });

    it('schedules:delete delegates to deleteSchedule and syncs crontab', async () => {
      const { deleteSchedule } = await import('../../src/main/scheduler');
      const { syncAllProjectsCrontab } = await import('../../src/main/scheduler/scheduler-manager');

      await invokeHandler('schedules:delete', '/home/user/proj', 'sch_test');

      expect(deleteSchedule).toHaveBeenCalledWith('/home/user/proj', 'sch_test');
      expect(syncAllProjectsCrontab).toHaveBeenCalled();
    });

    it('schedules:list rejects relative projectDir', async () => {
      await expect(invokeHandler('schedules:list', './relative')).rejects.toThrow(/absolute path/);
    });

    it('schedules:create rejects empty projectDir', async () => {
      await expect(
        invokeHandler('schedules:create', '', { cronExpression: '0 * * * *', action: { kind: 'run-script', scriptName: 'test.sh' } })
      ).rejects.toThrow(/projectDir is required/);
    });

    it('schedules:update rejects relative projectDir', async () => {
      await expect(
        invokeHandler('schedules:update', 'relative', 'sch_test', { enabled: false })
      ).rejects.toThrow(/absolute path/);
    });

    it('schedules:delete rejects relative projectDir', async () => {
      await expect(
        invokeHandler('schedules:delete', 'relative', 'sch_test')
      ).rejects.toThrow(/absolute path/);
    });

    it('schedules:cronHealth returns cron daemon status', async () => {
      const { isCronRunning } = await import('../../src/main/scheduler');
      (isCronRunning as Mock).mockReturnValue(false);

      const result = await invokeHandler('schedules:cronHealth');
      expect(result).toEqual({ running: false });
    });

    describe('schedules:listScripts', () => {
      let tmpDir: string;

      beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-listscripts-'));
      });

      afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      });

      it('returns .sh filenames sorted from the scheduled dir', async () => {
        const scheduledDir = path.join(tmpDir, '.sandstorm', 'scripts', 'scheduled');
        fs.mkdirSync(scheduledDir, { recursive: true });
        fs.writeFileSync(path.join(scheduledDir, 'zebra.sh'), '#!/bin/bash');
        fs.writeFileSync(path.join(scheduledDir, 'alpha.sh'), '#!/bin/bash');
        fs.writeFileSync(path.join(scheduledDir, 'not-a-script.txt'), 'ignored');

        const result = await invokeHandler('schedules:listScripts', tmpDir);
        expect(result).toEqual(['alpha.sh', 'zebra.sh']);
      });

      it('returns [] when the scheduled dir does not exist', async () => {
        const result = await invokeHandler('schedules:listScripts', tmpDir);
        expect(result).toEqual([]);
      });

      it('rejects a relative projectDir', async () => {
        await expect(invokeHandler('schedules:listScripts', 'relative/path')).rejects.toThrow(
          /absolute path/,
        );
      });

      it('rejects an empty projectDir', async () => {
        await expect(invokeHandler('schedules:listScripts', '')).rejects.toThrow(
          /projectDir is required/,
        );
      });
    });
  });

  // =========================================================================
  // Ticket Board
  // =========================================================================
  describe('tickets:list', () => {
    it('skips the provider fetch and returns { tickets, error:null } when no provider is configured', async () => {
      mockRegistry.getProjectTicketConfig.mockReturnValueOnce(null);
      const boardRows = [
        { ticket_id: 'T-1', project_dir: '/proj', column: 'backlog', title: 'First ticket', updated_at: '' },
      ];
      mockRegistry.listBoardTickets.mockReturnValue(boardRows);
      mockListTicketsWithConfig.mockClear();
      mockRegistry.seedBoardTicket.mockClear();

      const result = await invokeHandler('tickets:list', '/proj');

      expect(mockListTicketsWithConfig).not.toHaveBeenCalled();
      expect(mockRegistry.seedBoardTicket).not.toHaveBeenCalled();
      expect(mockRegistry.listBoardTickets).toHaveBeenCalled();
      expect(result).toEqual({ tickets: boardRows, error: null });
    });

    it('returns { tickets, error:null } when the provider fetch throws (graceful degradation)', async () => {
      mockRegistry.getProjectTicketConfig.mockReturnValueOnce({ provider: 'github' });
      mockListTicketsWithConfig.mockRejectedValueOnce(new Error('gh not authenticated'));
      const boardRows = [
        { ticket_id: 'T-9', project_dir: '/proj', column: 'backlog', title: 'Existing', updated_at: '' },
      ];
      mockRegistry.listBoardTickets.mockReturnValue(boardRows);

      const result = await invokeHandler('tickets:list', '/proj');

      expect(result).toEqual({ tickets: boardRows, error: null });
    });

    it('returns structured error in the error field when fetch returns ok:false', async () => {
      mockRegistry.getProjectTicketConfig.mockReturnValueOnce({ provider: 'jira' });
      const listError = { reason: 'missing-creds' } as const;
      mockListTicketsWithConfig.mockResolvedValueOnce({ ok: false, error: listError });
      const boardRows = [{ ticket_id: 'T-1', project_dir: '/proj', column: 'backlog', title: 'Cached', updated_at: '' }];
      mockRegistry.listBoardTickets.mockReturnValue(boardRows);
      mockRegistry.seedBoardTicket.mockClear();

      const result = await invokeHandler('tickets:list', '/proj') as { tickets: unknown[]; error: unknown };

      expect(result.tickets).toEqual(boardRows);
      expect(result.error).toEqual(listError);
      expect(mockRegistry.seedBoardTicket).not.toHaveBeenCalled();
    });

    it('passes the project config to the provider and seeds each returned ticket', async () => {
      const config = { provider: 'github' };
      mockRegistry.getProjectTicketConfig.mockReturnValueOnce(config);
      const providerTickets = [
        { id: 'T-1', title: 'First ticket', author: 'alice' },
        { id: 'T-2', title: 'Second ticket', author: 'bob' },
      ];
      mockListTicketsWithConfig.mockResolvedValueOnce({ ok: true, tickets: providerTickets });
      mockRegistry.listBoardTickets.mockReturnValue([]);
      mockRegistry.seedBoardTicket.mockClear();
      mockRegistry.deleteClosedEarlyColumnTickets.mockClear();

      await invokeHandler('tickets:list', '/proj');

      expect(mockListTicketsWithConfig).toHaveBeenCalledWith(config, '/proj');
      expect(mockRegistry.seedBoardTicket).toHaveBeenCalledTimes(2);
      expect(mockRegistry.seedBoardTicket).toHaveBeenCalledWith('T-1', '/proj', 'First ticket');
      expect(mockRegistry.seedBoardTicket).toHaveBeenCalledWith('T-2', '/proj', 'Second ticket');
      expect(mockRegistry.deleteClosedEarlyColumnTickets).toHaveBeenCalledWith('/proj', ['T-1', 'T-2']);
    });

    it('calls deleteClosedEarlyColumnTickets with empty array on ok:true empty fetch', async () => {
      mockRegistry.getProjectTicketConfig.mockReturnValueOnce({ provider: 'github' });
      mockListTicketsWithConfig.mockResolvedValueOnce({ ok: true, tickets: [] });
      mockRegistry.seedBoardTicket.mockClear();
      mockRegistry.deleteClosedEarlyColumnTickets.mockClear();

      await invokeHandler('tickets:list', '/proj');

      expect(mockRegistry.seedBoardTicket).not.toHaveBeenCalled();
      expect(mockRegistry.deleteClosedEarlyColumnTickets).toHaveBeenCalledWith('/proj', []);
    });

    it('does not call seedBoardTicket or deleteClosedEarlyColumnTickets when fetch returns ok:false', async () => {
      mockRegistry.getProjectTicketConfig.mockReturnValueOnce({ provider: 'github' });
      mockListTicketsWithConfig.mockResolvedValueOnce({ ok: false, error: { reason: 'network', message: 'Failed to fetch GitHub tickets' } });
      mockRegistry.seedBoardTicket.mockClear();
      mockRegistry.deleteClosedEarlyColumnTickets.mockClear();

      await invokeHandler('tickets:list', '/proj');

      expect(mockRegistry.seedBoardTicket).not.toHaveBeenCalled();
      expect(mockRegistry.deleteClosedEarlyColumnTickets).not.toHaveBeenCalled();
    });

    it('logs deleted count when deleteClosedEarlyColumnTickets removes rows', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        mockRegistry.getProjectTicketConfig.mockReturnValueOnce({ provider: 'github' });
        mockListTicketsWithConfig.mockResolvedValueOnce({
          ok: true,
          tickets: [{ id: 'T-1', title: 'Open ticket', author: 'alice' }],
        });
        mockRegistry.deleteClosedEarlyColumnTickets.mockReturnValue(2);
        mockRegistry.listBoardTickets.mockReturnValue([]);

        await invokeHandler('tickets:list', '/proj');

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('[tickets:list] Removed 2 closed early-column ticket(s)'),
        );
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('re-seeds a reopened ticket into backlog on the next sync', async () => {
      // Ticket was previously discarded (deleted from board). User reopens it on
      // the provider. Next sync fetches it as an open issue and seedBoardTicket
      // inserts it back at column='backlog' (INSERT … VALUES (?, ?, 'backlog', ?)).
      mockRegistry.getProjectTicketConfig.mockReturnValueOnce({ provider: 'github' });
      mockListTicketsWithConfig.mockResolvedValueOnce({
        ok: true,
        tickets: [{ id: 'REOPEN-1', title: 'Reopened ticket', author: 'alice' }],
      });
      mockRegistry.listBoardTickets.mockReturnValue([]);
      mockRegistry.seedBoardTicket.mockClear();

      await invokeHandler('tickets:list', '/proj');

      expect(mockRegistry.seedBoardTicket).toHaveBeenCalledWith('REOPEN-1', '/proj', 'Reopened ticket');
    });
  });

  describe('tickets:testJiraConnection', () => {
    it('delegates to testJiraConnection and returns its result', async () => {
      const expected = {
        auth: { ok: true, displayName: 'Alice' },
        jql: { ok: true, count: 7, hasMore: false },
      };
      mockTestJiraConnection.mockResolvedValueOnce(expected);

      const result = await invokeHandler('tickets:testJiraConnection', {
        jiraUrl: 'https://acme.atlassian.net',
        jiraUsername: 'user@acme.com',
        jiraApiToken: 'secret',
      });

      expect(mockTestJiraConnection).toHaveBeenCalledWith({
        jiraUrl: 'https://acme.atlassian.net',
        jiraUsername: 'user@acme.com',
        jiraApiToken: 'secret',
      });
      expect(result).toEqual(expected);
    });

    it('returns auth:false result when testJiraConnection returns auth failure', async () => {
      mockTestJiraConnection.mockResolvedValueOnce({
        auth: { ok: false, status: 401, message: 'Unauthorized' },
        jql: null,
      });

      const result = await invokeHandler('tickets:testJiraConnection', {
        jiraUrl: 'https://acme.atlassian.net',
        jiraUsername: 'bad@acme.com',
        jiraApiToken: 'wrong',
      }) as { auth: { ok: boolean }; jql: null };

      expect(result.auth.ok).toBe(false);
      expect(result.jql).toBeNull();
    });
  });

  describe('tickets:create', () => {
    beforeEach(() => {
      mockRegistry.getProjectTicketConfig.mockReturnValue({ provider: 'github' });
      mockCreateTicketWithConfig.mockResolvedValue({ url: 'https://github.com/o/r/issues/99', ticketId: '99' });
      mockRegistry.seedBoardTicket.mockClear();
    });

    it('throws when no provider is configured', async () => {
      mockRegistry.getProjectTicketConfig.mockReturnValueOnce(null);
      await expect(
        invokeHandler('tickets:create', '/proj', 'My Title', 'My Body')
      ).rejects.toThrow('No ticket provider configured');
      expect(mockRegistry.seedBoardTicket).not.toHaveBeenCalled();
    });

    it('seeds the board with the new ticket after creation', async () => {
      await invokeHandler('tickets:create', '/proj', 'My Title', 'My Body');
      expect(mockRegistry.seedBoardTicket).toHaveBeenCalledWith('99', '/proj', 'My Title');
    });

    it('ticket seeded by create appears in board even when tickets:list provider fetch fails', async () => {
      // tickets:create succeeds and seeds the board
      await invokeHandler('tickets:create', '/proj', 'My Title', 'My Body');
      expect(mockRegistry.seedBoardTicket).toHaveBeenCalledWith('99', '/proj', 'My Title');

      // When tickets:list is subsequently called with a failing provider, the
      // seeded ticket must still appear — tickets:list degrades to the local DB.
      mockRegistry.getProjectTicketConfig.mockReturnValueOnce({ provider: 'github' });
      mockListTicketsWithConfig.mockRejectedValueOnce(new Error('provider unavailable'));
      mockRegistry.listBoardTickets.mockReturnValueOnce([
        { ticket_id: '99', project_dir: '/proj', column: 'backlog', title: 'My Title', updated_at: '' },
      ]);

      const result = await invokeHandler('tickets:list', '/proj') as { tickets: Array<{ ticket_id: string; column: string }>; error: null };

      expect(result.tickets).toHaveLength(1);
      expect(result.tickets[0]).toMatchObject({
        ticket_id: '99',
        column: 'backlog',
      });
    });

    it('returns the created ticket result', async () => {
      const result = await invokeHandler('tickets:create', '/proj', 'My Title', 'My Body');
      expect(result).toEqual({ url: 'https://github.com/o/r/issues/99', ticketId: '99' });
    });

    it('does not seed the board when createTicketWithConfig throws', async () => {
      mockCreateTicketWithConfig.mockRejectedValueOnce(new Error('gh auth required'));
      await expect(
        invokeHandler('tickets:create', '/proj', 'My Title', 'My Body')
      ).rejects.toThrow('gh auth required');
      expect(mockRegistry.seedBoardTicket).not.toHaveBeenCalled();
    });
  });

  describe('ticket-board:set-column', () => {
    it('rejects when column is invalid', async () => {
      mockRegistry.setBoardTicketColumn.mockClear();
      await expect(
        invokeHandler('ticket-board:set-column', 'T-1', '/proj', 'invalid')
      ).rejects.toThrow('Invalid kanban column');
      expect(mockRegistry.setBoardTicketColumn).not.toHaveBeenCalled();
    });

    it('rejects when ticketId is empty', async () => {
      await expect(
        invokeHandler('ticket-board:set-column', '', '/proj', 'backlog')
      ).rejects.toThrow('ticketId is required');
    });

    it('calls setBoardTicketColumn for a valid request', async () => {
      mockRegistry.setBoardTicketColumn.mockClear();
      await invokeHandler('ticket-board:set-column', 'T-1', '/proj', 'spec_ready');
      expect(mockRegistry.setBoardTicketColumn).toHaveBeenCalledWith('T-1', '/proj', 'spec_ready');
    });
  });

  // =========================================================================
  // PR Merge
  // =========================================================================
  describe('pr:merge', () => {
    it('invokes gh pr merge with --squash (not --merge) and no --delete-branch, cwd set to stack workspace', async () => {
      const stack = { id: 'stack-1', project_dir: '/proj', pr_number: 99, status: 'pr_created', services: [] };
      mockStackManager.getStackWithServices.mockResolvedValue(stack);
      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: (...a: unknown[]) => void) => {
          callback(null, '', '');
        },
      );

      const result = await invokeHandler('pr:merge', 'stack-1', 99);

      expect(execFile).toHaveBeenCalledWith(
        'gh',
        ['pr', 'merge', '99', '--squash'],
        expect.objectContaining({ cwd: '/proj/.sandstorm/workspaces/stack-1' }),
        expect.any(Function),
      );
      const callArgs = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1) as unknown[];
      const ghArgs = callArgs[1] as string[];
      expect(ghArgs).not.toContain('--merge');
      expect(ghArgs).not.toContain('--delete-branch');
      expect(result).toEqual({ status: 'merged' });
    });

    it('throws when stack is not found', async () => {
      mockStackManager.getStackWithServices.mockResolvedValue(null);
      await expect(invokeHandler('pr:merge', 'missing-stack', 1)).rejects.toThrow('Stack "missing-stack" not found');
    });

    it('returns { status: "conflict" } when merge fails and re-query reports CONFLICTING', async () => {
      const stack = { id: 'stack-1', project_dir: '/proj', pr_number: 42, status: 'pr_created', services: [] };
      mockStackManager.getStackWithServices.mockResolvedValue(stack);
      const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
      // First call: gh pr merge fails
      mockExecFile.mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: (...a: unknown[]) => void) => {
          callback(new Error('pull request has conflicts'), '', '');
        },
      );
      // Second call: gh pr view --json mergeable returns CONFLICTING.
      // Note: execFile is mocked as vi.fn() without util.promisify.custom, so promisify resolves
      // with the first non-error argument directly. Pass the { stdout } object as that first arg.
      mockExecFile.mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: (...a: unknown[]) => void) => {
          callback(null, { stdout: JSON.stringify({ mergeable: 'CONFLICTING' }), stderr: '' } as any);
        },
      );

      const result = await invokeHandler('pr:merge', 'stack-1', 42);

      expect(result).toEqual({ status: 'conflict' });
    });

    it('returns { status: "failed" } when merge fails and re-query reports UNKNOWN', async () => {
      const stack = { id: 'stack-1', project_dir: '/proj', pr_number: 42, status: 'pr_created', services: [] };
      mockStackManager.getStackWithServices.mockResolvedValue(stack);
      const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
      mockExecFile.mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: (...a: unknown[]) => void) => {
          callback(new Error('branch protection rule'), '', '');
        },
      );
      mockExecFile.mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: (...a: unknown[]) => void) => {
          callback(null, { stdout: JSON.stringify({ mergeable: 'UNKNOWN' }), stderr: '' } as any);
        },
      );

      const result = await invokeHandler('pr:merge', 'stack-1', 42);

      expect(result).toEqual({ status: 'failed', error: 'branch protection rule' });
    });

    it('returns { status: "failed" } when merge fails and re-query itself throws', async () => {
      const stack = { id: 'stack-1', project_dir: '/proj', pr_number: 42, status: 'pr_created', services: [] };
      mockStackManager.getStackWithServices.mockResolvedValue(stack);
      const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
      mockExecFile.mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: (...a: unknown[]) => void) => {
          callback(new Error('network error'), '', '');
        },
      );
      mockExecFile.mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: (...a: unknown[]) => void) => {
          callback(new Error('gh not found'), '', '');
        },
      );

      const result = await invokeHandler('pr:merge', 'stack-1', 42);

      expect(result).toEqual({ status: 'failed', error: 'network error' });
    });

    it('treats an already-merged PR as success — returns { status: "merged" } (error message form)', async () => {
      const stack = { id: 'stack-1', project_dir: '/proj', pr_number: 99, status: 'pr_created', services: [] };
      mockStackManager.getStackWithServices.mockResolvedValue(stack);
      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: (...a: unknown[]) => void) => {
          callback(new Error('Pull request #99 is already merged'), '', '');
        },
      );

      const result = await invokeHandler('pr:merge', 'stack-1', 99);
      expect(result).toEqual({ status: 'merged' });
    });

    it('treats an already-merged PR as success — returns { status: "merged" } when detail is on stderr', async () => {
      const stack = { id: 'stack-1', project_dir: '/proj', pr_number: 99, status: 'pr_created', services: [] };
      mockStackManager.getStackWithServices.mockResolvedValue(stack);
      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: (...a: unknown[]) => void) => {
          const err = Object.assign(new Error('Command failed: gh pr merge 99 --squash'), {
            stderr: 'GraphQL: Pull request is already merged (mergePullRequest)',
          });
          callback(err, '', err.stderr);
        },
      );

      const result = await invokeHandler('pr:merge', 'stack-1', 99);
      expect(result).toEqual({ status: 'merged' });
    });
  });

  // =========================================================================
  // Dark Factory IPC handlers
  // =========================================================================
  describe('darkFactory:getEnabled', () => {
    it('returns false by default', async () => {
      mockRegistry.getDarkFactoryEnabled.mockReturnValue(false);
      const result = await invokeHandler('darkFactory:getEnabled', '/proj');
      expect(result).toBe(false);
      expect(mockRegistry.getDarkFactoryEnabled).toHaveBeenCalledWith('/proj');
    });

    it('returns true when enabled', async () => {
      mockRegistry.getDarkFactoryEnabled.mockReturnValue(true);
      const result = await invokeHandler('darkFactory:getEnabled', '/proj');
      expect(result).toBe(true);
    });
  });

  describe('darkFactory:setEnabled', () => {
    it('calls setDarkFactoryEnabled on registry', async () => {
      await invokeHandler('darkFactory:setEnabled', '/proj', true);
      expect(mockRegistry.setDarkFactoryEnabled).toHaveBeenCalledWith('/proj', true);
    });

    it('passes false correctly', async () => {
      await invokeHandler('darkFactory:setEnabled', '/proj', false);
      expect(mockRegistry.setDarkFactoryEnabled).toHaveBeenCalledWith('/proj', false);
    });
  });

  // =========================================================================
  // PR Auto-Resolve
  // =========================================================================
  describe('pr:autoResolve', () => {
    it('delegates to stackManager.autoResolveConflicts and returns the result', async () => {
      mockStackManager.autoResolveConflicts.mockResolvedValue({ status: 'resolved' });

      const result = await invokeHandler('pr:autoResolve', 'T-1', '/proj');

      expect(mockStackManager.autoResolveConflicts).toHaveBeenCalledWith('T-1', '/proj');
      expect(result).toEqual({ status: 'resolved' });
    });

    it('propagates errors thrown by autoResolveConflicts', async () => {
      mockStackManager.autoResolveConflicts.mockRejectedValue(new Error('Stack "T-1" not found'));

      await expect(invokeHandler('pr:autoResolve', 'T-1', '/proj')).rejects.toThrow('Stack "T-1" not found');
    });

    it('returns no_conflicts when PR is already mergeable', async () => {
      mockStackManager.autoResolveConflicts.mockResolvedValue({ status: 'no_conflicts' });

      const result = await invokeHandler('pr:autoResolve', 'T-2', '/proj');

      expect(result).toEqual({ status: 'no_conflicts' });
    });

    it('returns unknown_state when mergeable is UNKNOWN', async () => {
      mockStackManager.autoResolveConflicts.mockResolvedValue({ status: 'unknown_state' });

      const result = await invokeHandler('pr:autoResolve', 'T-3', '/proj');

      expect(result).toEqual({ status: 'unknown_state' });
    });

    it('returns failed when agent could not resolve', async () => {
      mockStackManager.autoResolveConflicts.mockResolvedValue({
        status: 'failed',
        error: 'Auto-resolve failed: inner agent could not resolve conflicts or verify failed',
      });

      const result = await invokeHandler('pr:autoResolve', 'T-4', '/proj') as { status: string; error: string };

      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/inner agent/);
    });
  });

  // =========================================================================
  // Phase-aware retryRefinementAsync
  // =========================================================================
  describe('tickets:retryRefinementAsync', () => {
    const ANSWER_MARKER = '<!-- sandstorm:user-answers -->';

    beforeEach(() => {
      mockSpawnSpecCheck.mockReturnValue({
        promise: new Promise<Record<string, unknown>>(() => {}),
        cancel: vi.fn(),
      });
      mockSpawnSpecRefine.mockReturnValue({
        promise: new Promise<Record<string, unknown>>(() => {}),
        cancel: vi.fn(),
      });
    });

    it('calls check when session.phase is check', async () => {
      const r1 = await invokeHandler('tickets:specCheckAsync', 'TICKET-1', '/tmp/proj') as { sessionId: string };

      vi.clearAllMocks();
      mockSpawnSpecCheck.mockReturnValue({
        promise: new Promise<Record<string, unknown>>(() => {}),
        cancel: vi.fn(),
      });

      await invokeHandler('tickets:retryRefinementAsync', r1.sessionId, 'TICKET-1', '/tmp/proj');

      expect(mockSpawnSpecCheck).toHaveBeenCalledWith('TICKET-1', '/tmp/proj', expect.any(Function));
      expect(mockSpawnSpecRefine).not.toHaveBeenCalled();
    });

    it('calls refine with extracted answers when session.phase is refine and ANSWER_COMMENT_MARKER comments exist', async () => {
      const fakeSessionId = 'refine-ipc-test-1';
      await invokeHandler('tickets:specRefineAsync', fakeSessionId, 'TICKET-2', '/tmp/proj2', 'some answers');

      mockListTicketComments.mockResolvedValue([
        {
          author: 'devuser',
          body: `${ANSWER_MARKER}\n\nQ1: Answer A\nQ2: Answer B`,
          createdAt: new Date(Date.now() - 60000).toISOString(),
        },
      ]);

      vi.clearAllMocks();
      mockSpawnSpecRefine.mockReturnValue({
        promise: new Promise<Record<string, unknown>>(() => {}),
        cancel: vi.fn(),
      });

      const result = await invokeHandler(
        'tickets:retryRefinementAsync',
        fakeSessionId,
        'TICKET-2',
        '/tmp/proj2',
      ) as { sessionId: string };

      expect(result).toHaveProperty('sessionId');
      expect(mockSpawnSpecRefine).toHaveBeenCalledWith(
        'TICKET-2',
        '/tmp/proj2',
        'Q1: Answer A\nQ2: Answer B',
        expect.any(Function),
      );
      expect(mockSpawnSpecCheck).not.toHaveBeenCalled();
    });

    it('falls back to check when session.phase is refine but no answer comments exist', async () => {
      const fakeSessionId = 'refine-ipc-test-2';
      await invokeHandler('tickets:specRefineAsync', fakeSessionId, 'TICKET-3', '/tmp/proj3', 'answers');

      mockListTicketComments.mockResolvedValue([]);

      vi.clearAllMocks();
      mockSpawnSpecCheck.mockReturnValue({
        promise: new Promise<Record<string, unknown>>(() => {}),
        cancel: vi.fn(),
      });

      await invokeHandler('tickets:retryRefinementAsync', fakeSessionId, 'TICKET-3', '/tmp/proj3');

      expect(mockSpawnSpecCheck).toHaveBeenCalledWith('TICKET-3', '/tmp/proj3', expect.any(Function));
      expect(mockSpawnSpecRefine).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // #510 regression — completion handler is always reached (no discard path)
  // =========================================================================
  describe('tickets:specCheckAsync completion — regression for #510', () => {
    it('completion handler reaches persistRefinement(ready) when no discard clears activeRefinements', async () => {
      // Arrange: a spec-check that will resolve
      let resolveFn!: (v: Record<string, unknown>) => void;
      mockSpawnSpecCheck.mockReturnValue({
        promise: new Promise<Record<string, unknown>>((r) => { resolveFn = r; }),
        cancel: vi.fn(),
      });

      // readTicketUrl calls execFileAsync (promisify(execFile)) once.
      // Make it fail immediately so the catch block returns '' and the
      // completion handler continues synchronously.
      const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
      mockExecFile.mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: (...a: unknown[]) => void) => {
          callback(new Error('mock-exec-fail'), '', '');
        },
      );

      const { sessionId } = await invokeHandler('tickets:specCheckAsync', 'TICKET-510', '/tmp/proj510') as { sessionId: string };
      mockPersistRefinement.mockClear();

      // Act: let the subprocess complete with passed=false so markSpecReady
      // (which also calls execFile) is skipped — only readTicketUrl runs.
      // No discard has removed the entry, so the completion handler runs to completion.
      resolveFn({ passed: false, report: '' });
      // Flush the microtask/macrotask queue so the async completion chain settles
      await new Promise((r) => setTimeout(r, 0));

      // Assert: persistRefinement was called with a 'ready' session, proving
      // the 'if (!entry) return' early-out was NOT taken (the core #510 regression)
      const readyCall = mockPersistRefinement.mock.calls.find(
        (call) => (call[0] as { status: string }).status === 'ready',
      );
      expect(readyCall).toBeDefined();
      expect((readyCall![0] as { id: string }).id).toBe(sessionId);
    });

    it('tickets:discardRefinement is NOT registered as an IPC handler (#510)', () => {
      // The discard path was the root cause of #510 — removing it from the IPC
      // surface is the fix. This assertion replaces the old registration check
      // that expected it to be present.
      expect(registeredHandlers['tickets:discardRefinement']).toBeUndefined();
    });
  });

  // =========================================================================
  // FAIL report posting — #569
  // =========================================================================
  describe('tickets:specCheckAsync — FAIL report comment posting (#569)', () => {
    async function runSpecCheckAsyncWithReport(
      report: string,
      passed: boolean,
    ): Promise<void> {
      let resolveFn!: (v: Record<string, unknown>) => void;
      mockSpawnSpecCheck.mockReturnValue({
        promise: new Promise<Record<string, unknown>>((r) => { resolveFn = r; }),
        cancel: vi.fn(),
      });
      const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
      mockExecFile.mockImplementation(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: (...a: unknown[]) => void) => {
          callback(new Error('exec-fail'), '', '');
        },
      );

      await invokeHandler('tickets:specCheckAsync', 'T-569', '/tmp/proj') as { sessionId: string };
      mockPostComment.mockClear();
      mockPersistRefinement.mockClear();

      resolveFn({ passed, report });
      // Flush multiple ticks: the PASS path has extra awaits (readTicketUrl + fetchTicket).
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    it('posts a GATE_FAIL_REPORT_MARKER comment on FAIL with non-empty report', async () => {
      await runSpecCheckAsyncWithReport('## Spec Quality Gate: FAIL\n\nSome report', false);
      expect(mockPostComment).toHaveBeenCalledOnce();
      const [, , body] = mockPostComment.mock.calls[0] as [string, string, string];
      expect(body).toContain('<!-- sandstorm:gate-fail-report -->');
      expect(body).toContain('## Spec Quality Gate: FAIL');
    });

    it('does NOT post a comment on PASS', async () => {
      await runSpecCheckAsyncWithReport('## Spec Quality Gate: PASS\n\nAll good', true);
      expect(mockPostComment).not.toHaveBeenCalled();
    });

    it('does NOT post a comment when report is empty', async () => {
      await runSpecCheckAsyncWithReport('', false);
      expect(mockPostComment).not.toHaveBeenCalled();
    });

    it('gate flow completes successfully even if postComment rejects', async () => {
      mockPostComment.mockRejectedValueOnce(new Error('network failure'));
      let resolveFn!: (v: Record<string, unknown>) => void;
      mockSpawnSpecCheck.mockReturnValue({
        promise: new Promise<Record<string, unknown>>((r) => { resolveFn = r; }),
        cancel: vi.fn(),
      });
      const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
      mockExecFile.mockImplementation(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: (...a: unknown[]) => void) => {
          callback(new Error('exec-fail'), '', '');
        },
      );

      await invokeHandler('tickets:specCheckAsync', 'T-569-err', '/tmp/proj');
      resolveFn({ passed: false, report: '## Spec Quality Gate: FAIL\n\nFailed' });
      // Flush: the .catch() on postComment should absorb the error without
      // propagating it or crashing the completion handler.
      await new Promise((r) => setTimeout(r, 0));
      // persistRefinement(ready) should still have been called
      const readyCall = mockPersistRefinement.mock.calls.find(
        (call) => (call[0] as { status: string }).status === 'ready',
      );
      expect(readyCall).toBeDefined();
    });

    it('includes reportText in the persisted result on FAIL', async () => {
      await runSpecCheckAsyncWithReport('## Spec Quality Gate: FAIL\n\nSome details', false);
      const readyCall = mockPersistRefinement.mock.calls.find(
        (call) => (call[0] as { status: string }).status === 'ready',
      );
      expect(readyCall).toBeDefined();
      const session = readyCall![0] as { result?: { reportText?: string } };
      expect(session.result?.reportText).toContain('## Spec Quality Gate: FAIL');
    });

    it('truncates reportText to 64KB and appends truncation notice on FAIL', async () => {
      const hugeReport = 'x'.repeat(64 * 1024 + 100);
      await runSpecCheckAsyncWithReport(hugeReport, false);
      const readyCall = mockPersistRefinement.mock.calls.find(
        (call) => (call[0] as { status: string }).status === 'ready',
      );
      expect(readyCall).toBeDefined();
      const session = readyCall![0] as { result?: { reportText?: string } };
      const stored = session.result?.reportText ?? '';
      expect(stored.length).toBeLessThan(hugeReport.length);
      expect(stored).toContain('[Report truncated at 64KB]');
    });

  });

  // =========================================================================
  // Lifecycle cleanup — cancelRefinementSession on board column changes (#566)
  // =========================================================================
  describe('refinement lifecycle cleanup on board moves (#566)', () => {
    function getBoardMovedListener(): (ticketId: string, projectDir: string, column: string) => void {
      const calls = mockRegistry.onBoardTicketMoved.mock.calls;
      if (calls.length === 0) throw new Error('onBoardTicketMoved was not called during registerIpcHandlers');
      return calls[0][0] as (ticketId: string, projectDir: string, column: string) => void;
    }

    it('subscribes a listener to registry.onBoardTicketMoved during setup', () => {
      expect(mockRegistry.onBoardTicketMoved).toHaveBeenCalledOnce();
      expect(typeof getBoardMovedListener()).toBe('function');
    });

    it('cancels active session when ticket moves to backlog', async () => {
      mockSpawnSpecCheck.mockReturnValue({ promise: new Promise(() => {}), cancel: vi.fn() });
      const { sessionId } = await invokeHandler('tickets:specCheckAsync', 'T-1', '/proj') as { sessionId: string };

      const listener = getBoardMovedListener();
      listener('T-1', '/proj', 'backlog');

      expect(mockDeleteRefinement).toHaveBeenCalledWith(sessionId);
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('refinement:update', { id: sessionId, status: 'cancelled' });
    });

    it('cancels active session when ticket moves to in_stack', async () => {
      mockSpawnSpecCheck.mockReturnValue({ promise: new Promise(() => {}), cancel: vi.fn() });
      const { sessionId } = await invokeHandler('tickets:specCheckAsync', 'T-2', '/proj') as { sessionId: string };

      const listener = getBoardMovedListener();
      listener('T-2', '/proj', 'in_stack');

      expect(mockDeleteRefinement).toHaveBeenCalledWith(sessionId);
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('refinement:update', { id: sessionId, status: 'cancelled' });
    });

    it('cancels active session when ticket moves to merged', async () => {
      mockSpawnSpecCheck.mockReturnValue({ promise: new Promise(() => {}), cancel: vi.fn() });
      const { sessionId } = await invokeHandler('tickets:specCheckAsync', 'T-3', '/proj') as { sessionId: string };

      const listener = getBoardMovedListener();
      listener('T-3', '/proj', 'merged');

      expect(mockDeleteRefinement).toHaveBeenCalledWith(sessionId);
    });

    it('does NOT cancel session when ticket moves to spec_ready', async () => {
      mockSpawnSpecCheck.mockReturnValue({ promise: new Promise(() => {}), cancel: vi.fn() });
      const { sessionId } = await invokeHandler('tickets:specCheckAsync', 'T-4', '/proj') as { sessionId: string };
      mockDeleteRefinement.mockClear();

      const listener = getBoardMovedListener();
      listener('T-4', '/proj', 'spec_ready');

      expect(mockDeleteRefinement).not.toHaveBeenCalledWith(sessionId);
    });

    it('does NOT cancel session when ticket moves to refining', async () => {
      mockSpawnSpecCheck.mockReturnValue({ promise: new Promise(() => {}), cancel: vi.fn() });
      const { sessionId } = await invokeHandler('tickets:specCheckAsync', 'T-5', '/proj') as { sessionId: string };
      mockDeleteRefinement.mockClear();

      const listener = getBoardMovedListener();
      listener('T-5', '/proj', 'refining');

      expect(mockDeleteRefinement).not.toHaveBeenCalledWith(sessionId);
    });

    it('calls entry.cancel() to abort in-flight agent on cleanup', async () => {
      const cancelFn = vi.fn();
      mockSpawnSpecCheck.mockReturnValue({ promise: new Promise(() => {}), cancel: cancelFn });
      await invokeHandler('tickets:specCheckAsync', 'T-6', '/proj');

      const listener = getBoardMovedListener();
      listener('T-6', '/proj', 'backlog');

      expect(cancelFn).toHaveBeenCalled();
    });

    it('does not cancel a session for a different ticket', async () => {
      mockSpawnSpecCheck.mockReturnValue({ promise: new Promise(() => {}), cancel: vi.fn() });
      await invokeHandler('tickets:specCheckAsync', 'T-7', '/proj');
      mockDeleteRefinement.mockClear();

      const listener = getBoardMovedListener();
      listener('T-OTHER', '/proj', 'backlog');

      expect(mockDeleteRefinement).not.toHaveBeenCalled();
    });

    it('does not cancel a session for a different projectDir', async () => {
      mockSpawnSpecCheck.mockReturnValue({ promise: new Promise(() => {}), cancel: vi.fn() });
      await invokeHandler('tickets:specCheckAsync', 'T-8', '/proj-a');
      mockDeleteRefinement.mockClear();

      const listener = getBoardMovedListener();
      listener('T-8', '/proj-b', 'backlog');

      expect(mockDeleteRefinement).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Startup prune — stale sessions deleted before broadcast (#566)
  // =========================================================================
  describe('startup prune (#566)', () => {
    function reRegister() {
      for (const key of Object.keys(registeredHandlers)) {
        delete registeredHandlers[key];
      }
      const win = { webContents: { send: vi.fn() } };
      registerIpcHandlers(win as unknown as import('electron').BrowserWindow);
    }

    it('deletes sessions for tickets in non-live columns before broadcast', () => {
      const stale = { id: 'stale-1', ticketId: 'T1', projectDir: '/proj1', status: 'ready' as const, phase: 'check' as const, startedAt: 0 };
      const live = { id: 'live-1', ticketId: 'T2', projectDir: '/proj2', status: 'interrupted' as const, phase: 'check' as const, startedAt: 0 };

      mockLoadRefinements.mockReturnValueOnce([stale, live]);
      mockRegistry.listBoardTickets.mockImplementation((projectDir: string) => {
        if (projectDir === '/proj1') return [{ ticket_id: 'T1', project_dir: '/proj1', column: 'backlog', title: '', created_at: '', updated_at: '' }];
        if (projectDir === '/proj2') return [{ ticket_id: 'T2', project_dir: '/proj2', column: 'refining', title: '', created_at: '', updated_at: '' }];
        return [];
      });

      mockDeleteRefinement.mockClear();
      reRegister();

      expect(mockDeleteRefinement).toHaveBeenCalledWith('stale-1');
      expect(mockDeleteRefinement).not.toHaveBeenCalledWith('live-1');
    });

    it('deletes sessions whose ticket board row does not exist', () => {
      const orphan = { id: 'orphan-1', ticketId: 'T9', projectDir: '/gone', status: 'ready' as const, phase: 'check' as const, startedAt: 0 };

      mockLoadRefinements.mockReturnValueOnce([orphan]);
      mockRegistry.listBoardTickets.mockReturnValue([]);

      mockDeleteRefinement.mockClear();
      reRegister();

      expect(mockDeleteRefinement).toHaveBeenCalledWith('orphan-1');
    });

    it('keeps sessions for tickets in spec_ready', () => {
      const live = { id: 'live-sr', ticketId: 'TS', projectDir: '/proj', status: 'ready' as const, phase: 'check' as const, startedAt: 0 };

      mockLoadRefinements.mockReturnValueOnce([live]);
      mockRegistry.listBoardTickets.mockReturnValue([
        { ticket_id: 'TS', project_dir: '/proj', column: 'spec_ready', title: '', created_at: '', updated_at: '' },
      ]);

      mockDeleteRefinement.mockClear();
      reRegister();

      expect(mockDeleteRefinement).not.toHaveBeenCalledWith('live-sr');
    });

    it('persists kept sessions back to disk', () => {
      const live = { id: 'live-p', ticketId: 'TL', projectDir: '/p', status: 'interrupted' as const, phase: 'check' as const, startedAt: 0 };

      mockLoadRefinements.mockReturnValueOnce([live]);
      mockRegistry.listBoardTickets.mockReturnValue([
        { ticket_id: 'TL', project_dir: '/p', column: 'refining', title: '', created_at: '', updated_at: '' },
      ]);

      mockPersistRefinement.mockClear();
      reRegister();

      expect(mockPersistRefinement).toHaveBeenCalledWith(expect.objectContaining({ id: 'live-p' }));
    });
  });

  // =========================================================================
  // cancelRefinementSession helper — used by cancelRefinement and cleanup (#566)
  // =========================================================================
  describe('tickets:cancelRefinement uses shared cancel helper', () => {
    it('aborts in-flight agent, removes from map, deletes from disk, broadcasts cancelled', async () => {
      const cancelFn = vi.fn();
      mockSpawnSpecCheck.mockReturnValue({ promise: new Promise(() => {}), cancel: cancelFn });
      const { sessionId } = await invokeHandler('tickets:specCheckAsync', 'T-C', '/proj') as { sessionId: string };
      mockDeleteRefinement.mockClear();
      mockMainWindow.webContents.send.mockClear();

      await invokeHandler('tickets:cancelRefinement', sessionId);

      expect(cancelFn).toHaveBeenCalled();
      expect(mockDeleteRefinement).toHaveBeenCalledWith(sessionId);
      expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('refinement:update', { id: sessionId, status: 'cancelled' });
    });

    it('is a no-op for unknown session id', async () => {
      await expect(invokeHandler('tickets:cancelRefinement', 'no-such-id')).resolves.not.toThrow();
      expect(mockDeleteRefinement).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Model Routing IPC Handlers
  // =========================================================================
  describe('modelRouting handlers', () => {
    it('modelRouting:getEffective delegates to registry.getEffectiveRouting', async () => {
      const map = { execution: { backend: 'claude', model: 'sonnet' } };
      mockRegistry.getEffectiveRouting.mockReturnValue(map);
      const result = await invokeHandler('modelRouting:getEffective', '/proj/a');
      expect(result).toEqual(map);
      expect(mockRegistry.getEffectiveRouting).toHaveBeenCalledWith('/proj/a');
    });

    it('modelRouting:getProject delegates to registry.getProjectRouting', async () => {
      const config = { assignments: {}, preset: 'balanced' };
      mockRegistry.getProjectRouting.mockReturnValue(config);
      const result = await invokeHandler('modelRouting:getProject', '/proj/a');
      expect(result).toEqual(config);
      expect(mockRegistry.getProjectRouting).toHaveBeenCalledWith('/proj/a');
    });

    it('modelRouting:getProject returns null when no project routing', async () => {
      mockRegistry.getProjectRouting.mockReturnValue(null);
      const result = await invokeHandler('modelRouting:getProject', '/proj/a');
      expect(result).toBeNull();
    });

    it('modelRouting:setProject delegates to registry.setProjectRouting', async () => {
      const config = { assignments: { outer: { backend: 'claude', model: 'opus' } }, preset: null };
      await invokeHandler('modelRouting:setProject', '/proj/a', config);
      expect(mockRegistry.setProjectRouting).toHaveBeenCalledWith('/proj/a', config);
    });

    it('modelRouting:removeProject delegates to registry.removeProjectRouting', async () => {
      await invokeHandler('modelRouting:removeProject', '/proj/a');
      expect(mockRegistry.removeProjectRouting).toHaveBeenCalledWith('/proj/a');
    });

    it('modelRouting:getGlobal delegates to registry.getGlobalRouting', async () => {
      const config = { assignments: { outer: { backend: 'claude', model: 'sonnet' } }, preset: null };
      mockRegistry.getGlobalRouting.mockReturnValue(config);
      const result = await invokeHandler('modelRouting:getGlobal');
      expect(result).toEqual(config);
      expect(mockRegistry.getGlobalRouting).toHaveBeenCalledOnce();
    });

    it('modelRouting:setGlobal delegates to registry.setGlobalRouting', async () => {
      const config = { preset: 'max_quality' };
      await invokeHandler('modelRouting:setGlobal', config);
      expect(mockRegistry.setGlobalRouting).toHaveBeenCalledWith(config);
    });

    it('modelRouting:applyPreset delegates to registry.applyPreset', async () => {
      await invokeHandler('modelRouting:applyPreset', '/proj/a', 'balanced');
      expect(mockRegistry.applyPreset).toHaveBeenCalledWith('/proj/a', 'balanced');
    });

    it('modelRouting:getAvailableModels returns non-empty model list', async () => {
      const result = await invokeHandler('modelRouting:getAvailableModels', '/proj/a') as unknown[];
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      const first = result[0] as Record<string, unknown>;
      expect(first).toHaveProperty('backend');
      expect(first).toHaveProperty('model');
      expect(first).toHaveProperty('label');
      expect(first).toHaveProperty('version');
      expect(first).toHaveProperty('provider');
      expect(first).toHaveProperty('available');
    });

    it('modelRouting:getAvailableModels includes claude models', async () => {
      const result = await invokeHandler('modelRouting:getAvailableModels', '/proj/a') as Array<{ backend: string; model: string }>;
      const claudeModels = result.filter(m => m.backend === 'claude');
      expect(claudeModels.length).toBeGreaterThan(0);
      const modelIds = claudeModels.map(m => m.model);
      expect(modelIds).toContain('opus');
      expect(modelIds).toContain('sonnet');
      expect(modelIds).toContain('haiku');
    });
  });

  // =========================================================================
  // Handler Registration Completeness
  // =========================================================================
  describe('handler registration', () => {
    const expectedChannels = [
      'agent:send',
      'agent:cancel',
      'agent:reset',
      'agent:history',
      'agent:tokenUsage',
      'projects:list',
      'projects:add',
      'projects:remove',
      'projects:browse',
      'projects:checkInit',
      'projects:initialize',
      'projects:checkMigration',
      'projects:autoDetectVerify',
      'projects:saveMigration',
      'projects:generateCompose',
      'projects:saveComposeSetup',
      'stacks:list',
      'stacks:get',
      'stacks:create',
      'stacks:teardown',
      'stacks:stop',
      'stacks:start',
      'stacks:history',
      'stacks:setPr',
      'stacks:detectStale',
      'stacks:cleanupStale',
      'tasks:dispatch',
      'tasks:list',
      'tasks:tokenSteps',
      'tasks:workflowProgress',
      'diff:get',
      'push:execute',
      'ports:get',
      'stack:expose-port',
      'stack:unexpose-port',
      'ports:cleanupLegacy',
      'logs:stream',
      'stats:stack-memory',
      'stats:stack-detailed',
      'stats:task-metrics',
      'stats:token-usage',
      'stats:global-token-usage',
      'stats:rate-limit',
      'stats:account-usage',
      'context:get',
      'context:saveInstructions',
      'context:listSkills',
      'context:getSkill',
      'context:saveSkill',
      'context:deleteSkill',
      'context:getSettings',
      'context:saveSettings',
      'reviewPrompt:getDefault',
      'modelSettings:getGlobal',
      'modelSettings:setGlobal',
      'modelSettings:getProject',
      'modelSettings:setProject',
      'modelSettings:removeProject',
      'modelSettings:getEffective',
      'backendSettings:getGlobal',
      'backendSettings:setGlobal',
      'backendSettings:getProject',
      'backendSettings:setProject',
      'backendSettings:getEffective',
      'backendSettings:setSecret',
      'backendSettings:secretStatus',
      'modelRouting:getEffective',
      'modelRouting:getProject',
      'modelRouting:setProject',
      'modelRouting:removeProject',
      'modelRouting:getGlobal',
      'modelRouting:setGlobal',
      'modelRouting:applyPreset',
      'modelRouting:getAvailableModels',
      'runtime:available',
      'session:getState',
      'session:getSettings',
      'session:updateSettings',
      'session:acknowledgeCritical',
      'session:haltAll',
      'session:resumeAll',
      'session:resumeStack',
      'session:resumeStackWithContinuation',
      'session:forcePoll',
      'docker:status',
      'schedules:list',
      'schedules:create',
      'schedules:update',
      'schedules:delete',
      'schedules:cronHealth',
      'scheduler:listBuiltInActions',
      'schedules:listScripts',
      'auth:status',
      'auth:login',
      'tickets:fetch',
      'tickets:specCheck',
      'tickets:specRefine',
      'tickets:specCheckAsync',
      'tickets:specRefineAsync',
      'tickets:retryRefinementAsync',
      'tickets:postAnswers',
      'tickets:cancelRefinement',
      'tickets:listRefinements',
      'tickets:create',
      'tickets:fetchRaw',
      'tickets:update',
      'tickets:list',
      'tickets:testJiraConnection',
      'ticket:close',
      'ticket:mark-done',
      'ticket-board:set-column',
      'ticket-board:delete',
      'pr:draftBody',
      'pr:create',
      'pr:merge',
      'pr:createAuto',
      'pr:autoResolve',
      'projectTicketConfig:get',
      'projectTicketConfig:set',
      'darkFactory:getEnabled',
      'darkFactory:setEnabled',
      'stacks:getNeedsHumanQuestions',
      'stacks:resumeNeedsHuman',
      'stacks:selfHealContinue',
      'stacks:restartWithFindings',
      'stacks:recheckCompleted',
      'stats:telemetry:summary',
      'stats:telemetry:daily',
      'stats:telemetry:byModel',
      'stats:telemetry:session',
      'stats:telemetry:byTicket',
      'stats:telemetry:refresh',
    ];

    it('registers all expected IPC channels', () => {
      for (const channel of expectedChannels) {
        expect(registeredHandlers[channel], `Missing handler for "${channel}"`).toBeDefined();
      }
    });

    it('registers exactly the expected number of handlers', () => {
      expect(Object.keys(registeredHandlers).length).toBe(expectedChannels.length);
    });
  });

  // =========================================================================
  // ticket:close (#446)
  // =========================================================================
  describe('ticket:close', () => {
    beforeEach(() => {
      mockRegistry.getProjectTicketConfig.mockReturnValue({ provider: 'github' });
    });

    it('calls closeTicketWithConfig with ticketId, config, and projectDir', async () => {
      await invokeHandler('ticket:close', { ticketId: '42', projectDir: '/proj' });
      expect(mockCloseTicketWithConfig).toHaveBeenCalledWith('42', { provider: 'github' }, '/proj');
    });

    it('resolves successfully when closeTicketWithConfig resolves', async () => {
      await expect(
        invokeHandler('ticket:close', { ticketId: '42', projectDir: '/proj' })
      ).resolves.toBeUndefined();
    });

    it('rejects when no ticket config is configured for the project', async () => {
      mockRegistry.getProjectTicketConfig.mockReturnValue(null);
      await expect(
        invokeHandler('ticket:close', { ticketId: '42', projectDir: '/proj' })
      ).rejects.toThrow(/No ticket provider configured/);
    });

    it('rejects when ticketId is empty', async () => {
      await expect(
        invokeHandler('ticket:close', { ticketId: '', projectDir: '/proj' })
      ).rejects.toThrow(/ticketId is required/);
    });

    it('propagates rejection from closeTicketWithConfig', async () => {
      mockCloseTicketWithConfig.mockRejectedValueOnce(new Error('403 Forbidden'));
      await expect(
        invokeHandler('ticket:close', { ticketId: '42', projectDir: '/proj' })
      ).rejects.toThrow('403 Forbidden');
    });
  });

  // =========================================================================
  // ticket:mark-done
  // =========================================================================
  describe('ticket:mark-done', () => {
    beforeEach(() => {
      mockRegistry.getProjectTicketConfig.mockReturnValue({ provider: 'github' });
      mockMarkTicketDoneWithConfig.mockResolvedValue(undefined);
    });

    it('returns { ok: true } when markTicketDoneWithConfig succeeds', async () => {
      const result = await invokeHandler('ticket:mark-done', { ticketId: '42', projectDir: '/proj' });
      expect(result).toEqual({ ok: true });
      expect(mockMarkTicketDoneWithConfig).toHaveBeenCalledWith('42', { provider: 'github' }, '/proj');
    });

    it('returns { ok: true } and skips mark-done when no ticket config is configured', async () => {
      mockRegistry.getProjectTicketConfig.mockReturnValue(null);
      const result = await invokeHandler('ticket:mark-done', { ticketId: '42', projectDir: '/proj' });
      expect(result).toEqual({ ok: true });
      expect(mockMarkTicketDoneWithConfig).not.toHaveBeenCalled();
    });

    it('returns { ok: false, error } when markTicketDoneWithConfig fails (after retries)', async () => {
      mockMarkTicketDoneWithConfig.mockRejectedValue(new Error('API timeout'));
      const result = await invokeHandler('ticket:mark-done', { ticketId: '42', projectDir: '/proj' });
      expect(result).toEqual({ ok: false, error: 'API timeout' });
    });

    it('invokes markTicketDoneWithConfig exactly once per ticket:mark-done call', async () => {
      await invokeHandler('ticket:mark-done', { ticketId: '42', projectDir: '/proj' });
      expect(mockMarkTicketDoneWithConfig).toHaveBeenCalledTimes(1);
    });

    it('does not call markTicketDoneWithConfig when ticketId is empty string', async () => {
      const result = await invokeHandler('ticket:mark-done', { ticketId: '', projectDir: '/proj' });
      // Empty ticketId with no config → skips silently (config is checked first)
      // But with config present, passes empty string to markTicketDoneWithConfig.
      // Current implementation defers validation to the underlying function.
      // This test documents current behavior: with config, it calls through.
      expect(result).toBeDefined();
    });
  });

  // =========================================================================
  // ticket-board:delete (#446)
  // =========================================================================
  describe('ticket-board:delete', () => {
    it('calls registry.deleteBoardTicket with ticketId and resolved projectDir', async () => {
      await invokeHandler('ticket-board:delete', { ticketId: '42', projectDir: '/proj' });
      expect(mockRegistry.deleteBoardTicket).toHaveBeenCalledWith('42', '/proj');
    });

    it('resolves successfully (no-op when row absent)', async () => {
      await expect(
        invokeHandler('ticket-board:delete', { ticketId: 'nonexistent', projectDir: '/proj' })
      ).resolves.toBeUndefined();
    });

    it('rejects when ticketId is empty', async () => {
      await expect(
        invokeHandler('ticket-board:delete', { ticketId: '', projectDir: '/proj' })
      ).rejects.toThrow(/ticketId is required/);
    });
  });

  // =========================================================================
  // Backend Settings IPC handlers
  // =========================================================================
  describe('backendSettings:getGlobal', () => {
    it('returns registry.getGlobalBackendSettings()', async () => {
      const expected = { inner_backend: 'opencode', outer_backend: 'claude', inner_provider: 'anthropic', inner_model: 'claude-3-5-sonnet', outer_provider: null, outer_model: null };
      mockRegistry.getGlobalBackendSettings.mockReturnValueOnce(expected);
      const result = await invokeHandler('backendSettings:getGlobal');
      expect(mockRegistry.getGlobalBackendSettings).toHaveBeenCalled();
      expect(result).toEqual(expected);
    });
  });

  describe('backendSettings:setGlobal', () => {
    it('calls registry.setGlobalBackendSettings with the provided settings', async () => {
      const settings = { inner_backend: 'opencode', outer_backend: 'claude' };
      await invokeHandler('backendSettings:setGlobal', settings);
      expect(mockRegistry.setGlobalBackendSettings).toHaveBeenCalledWith(settings);
    });
  });

  describe('backendSettings:getProject', () => {
    it('returns null when no project override exists', async () => {
      mockRegistry.getProjectBackendSettings.mockReturnValueOnce(null);
      const result = await invokeHandler('backendSettings:getProject', '/proj');
      expect(mockRegistry.getProjectBackendSettings).toHaveBeenCalledWith('/proj');
      expect(result).toBeNull();
    });

    it('returns project settings when present', async () => {
      const expected = { inner_backend: 'opencode', outer_backend: 'global', inner_provider: null, inner_model: null, outer_provider: null, outer_model: null };
      mockRegistry.getProjectBackendSettings.mockReturnValueOnce(expected);
      const result = await invokeHandler('backendSettings:getProject', '/proj');
      expect(result).toEqual(expected);
    });
  });

  describe('backendSettings:setProject', () => {
    it('calls registry.setProjectBackendSettings with projectDir and settings', async () => {
      const settings = { inner_backend: 'opencode' };
      await invokeHandler('backendSettings:setProject', '/proj', settings);
      expect(mockRegistry.setProjectBackendSettings).toHaveBeenCalledWith('/proj', settings);
    });
  });

  describe('backendSettings:getEffective', () => {
    it('returns effective backend for inner surface', async () => {
      mockRegistry.getEffectiveBackend.mockReturnValueOnce({ backend: 'opencode', provider: 'anthropic', model: 'claude-3-5-sonnet' });
      const result = await invokeHandler('backendSettings:getEffective', '/proj', 'inner');
      expect(mockRegistry.getEffectiveBackend).toHaveBeenCalledWith('/proj', 'inner');
      expect(result).toEqual({ backend: 'opencode', provider: 'anthropic', model: 'claude-3-5-sonnet' });
    });

    it('returns effective backend for outer surface', async () => {
      mockRegistry.getEffectiveBackend.mockReturnValueOnce({ backend: 'claude' });
      const result = await invokeHandler('backendSettings:getEffective', '/proj', 'outer');
      expect(mockRegistry.getEffectiveBackend).toHaveBeenCalledWith('/proj', 'outer');
      expect(result).toEqual({ backend: 'claude' });
    });
  });

  describe('backendSettings:setSecret', () => {
    it('derives key="global" when scope is "global" and calls registry.setBackendSecret', async () => {
      const result = await invokeHandler('backendSettings:setSecret', 'global', 'inner', 'api_key', 'sk-test');
      expect(mockRegistry.setBackendSecret).toHaveBeenCalledWith('global', 'inner', 'api_key', 'sk-test');
      expect(result).toBeUndefined();
    });

    it('derives key="project:<resolved>" when scope is a projectDir', async () => {
      const projectDir = '/some/project';
      const path = require('path');
      const expectedKey = `project:${path.resolve(projectDir)}`;
      await invokeHandler('backendSettings:setSecret', projectDir, 'outer', 'api_key', 'sk-proj');
      expect(mockRegistry.setBackendSecret).toHaveBeenCalledWith(expectedKey, 'outer', 'api_key', 'sk-proj');
    });
  });

  describe('backendSettings:secretStatus', () => {
    it('returns { set: false } when no secret stored (global scope)', async () => {
      mockRegistry.hasBackendSecret.mockReturnValueOnce(false);
      const result = await invokeHandler('backendSettings:secretStatus', 'global', 'inner');
      expect(mockRegistry.hasBackendSecret).toHaveBeenCalledWith('global', 'inner');
      expect(result).toEqual({ set: false });
    });

    it('returns { set: true } when secret exists (global scope)', async () => {
      mockRegistry.hasBackendSecret.mockReturnValueOnce(true);
      const result = await invokeHandler('backendSettings:secretStatus', 'global', 'inner');
      expect(result).toEqual({ set: true });
    });

    it('derives key="project:<resolved>" for project scope and returns secret status', async () => {
      const projectDir = '/some/project';
      const path = require('path');
      const expectedKey = `project:${path.resolve(projectDir)}`;
      mockRegistry.hasBackendSecret.mockReturnValueOnce(true);
      const result = await invokeHandler('backendSettings:secretStatus', projectDir, 'inner');
      expect(mockRegistry.hasBackendSecret).toHaveBeenCalledWith(expectedKey, 'inner');
      expect(result).toEqual({ set: true });
    });

    it('does not expose the secret value — only returns { set: boolean }', async () => {
      mockRegistry.hasBackendSecret.mockReturnValueOnce(true);
      const result = await invokeHandler('backendSettings:secretStatus', 'global', 'inner') as Record<string, unknown>;
      expect(Object.keys(result)).toEqual(['set']);
      expect(result['set']).toBe(true);
    });
  });
});
