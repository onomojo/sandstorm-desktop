/**
 * Integration test for the refinement streaming chain:
 * startRefinementAsync → spawnSpecCheck(onChunk) → webContents.send('refinement:progress')
 *
 * This drives the real startRefinementAsync IPC handler with a mocked subprocess
 * (via a controlled spawnSpecCheck) and asserts that refinement:progress events
 * reach the renderer with the correct {sessionId, delta} payload.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — vi.mock factories are hoisted above all imports, so any
// variables they reference must also be hoisted via vi.hoisted().
// ---------------------------------------------------------------------------
const { registeredHandlers, mockSpawnSpecCheck, mockSpawnSpecRefine, mockListTicketComments } = vi.hoisted(() => {
  const registeredHandlers: Record<string, (...args: unknown[]) => unknown> = {};
  const mockSpawnSpecCheck = vi.fn();
  const mockSpawnSpecRefine = vi.fn();
  const mockListTicketComments = vi.fn().mockResolvedValue([]);
  return { registeredHandlers, mockSpawnSpecCheck, mockSpawnSpecRefine, mockListTicketComments };
});

// ---------------------------------------------------------------------------
// Module mocks (same pattern as ipc-handlers.test.ts)
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
  registry: {
    listProjects: vi.fn(),
    addProject: vi.fn(),
    removeProject: vi.fn(),
    getProject: vi.fn(),
    getPorts: vi.fn(),
  },
  stackManager: {
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
  },
  dockerRuntime: {
    isAvailable: vi.fn(),
    logs: vi.fn(),
  },
  podmanRuntime: {
    isAvailable: vi.fn(),
    logs: vi.fn(),
  },
  agentBackend: {
    sendMessage: vi.fn(),
    cancelSession: vi.fn(),
    resetSession: vi.fn(),
    getHistory: vi.fn(),
    getAuthStatus: vi.fn(),
    login: vi.fn(),
    syncCredentials: vi.fn(),
  },
  dockerConnectionManager: {
    isConnected: false,
  },
  sessionMonitor: {
    getState: vi.fn(),
    acknowledgeCritical: vi.fn(),
    markResumed: vi.fn(),
    updateSettings: vi.fn(),
    forcePoll: vi.fn(),
  },
  cliDir: '/tmp/sandstorm-cli',
}));

// Mock tools so spawnSpecCheck is controllable — the key seam under test.
vi.mock('../../src/main/claude/tools', () => ({
  handleToolCall: vi.fn(),
  spawnSpecCheck: mockSpawnSpecCheck,
  spawnSpecRefine: mockSpawnSpecRefine,
  validateProjectDir: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/main/control-plane/ticket-comments', () => ({
  listTicketComments: (...args: unknown[]) => mockListTicketComments(...args),
  postComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/main/custom-context', () => ({
  getCustomContext: vi.fn(),
  saveCustomInstructions: vi.fn(),
  listCustomSkills: vi.fn(),
  getCustomSkill: vi.fn(),
  saveCustomSkill: vi.fn(),
  deleteCustomSkill: vi.fn(),
  getCustomSettings: vi.fn(),
  saveCustomSettings: vi.fn(),
}));

vi.mock('../../src/main/control-plane/account-usage', () => ({
  fetchAccountUsage: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
}));

vi.mock('../../src/main/scheduler', () => ({
  createSchedule: vi.fn(),
  listSchedules: vi.fn().mockReturnValue([]),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  isCronRunning: vi.fn().mockReturnValue(true),
  removeProjectFromCrontab: vi.fn(),
}));

vi.mock('../../src/main/scheduler/scheduler-manager', () => ({
  syncAllProjectsCrontab: vi.fn().mockResolvedValue(undefined),
  projectIdFromDir: vi.fn().mockImplementation((dir: string) => {
    const parts = dir.split('/');
    return parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { registerIpcHandlers } from '../../src/main/ipc';
import type { EphemeralStreamEvent } from '../../src/main/agent/types';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = registeredHandlers[channel];
  if (!handler) throw new Error(`No handler registered for channel "${channel}"`);
  const fakeEvent = { sender: { id: 1 } };
  return handler(fakeEvent, ...args);
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------
describe('refinement streaming — IPC chain', () => {
  let mockMainWindow: { webContents: { send: Mock } };

  beforeEach(() => {
    for (const key of Object.keys(registeredHandlers)) {
      delete registeredHandlers[key];
    }
    vi.clearAllMocks();

    mockMainWindow = { webContents: { send: vi.fn() } };
    registerIpcHandlers(mockMainWindow as unknown as import('electron').BrowserWindow);
  });

  it('forwards text onChunk events to the renderer via refinement:progress', async () => {
    let capturedOnChunk: ((event: EphemeralStreamEvent) => void) | undefined;

    // Simulate a subprocess that is still running (promise never resolves here).
    // We capture the onChunk callback so we can fire it manually.
    mockSpawnSpecCheck.mockImplementation(
      (_ticketId: unknown, _projectDir: unknown, onChunk: (event: EphemeralStreamEvent) => void) => {
        capturedOnChunk = onChunk;
        return {
          promise: new Promise<Record<string, unknown>>(() => {}),
          cancel: vi.fn(),
        };
      },
    );

    // Invoke the async handler — returns {sessionId} immediately while the
    // ephemeral subprocess runs in the background.
    const result = (await invokeHandler(
      'tickets:specCheckAsync',
      'TICKET-123',
      '/tmp/my-project',
    )) as { sessionId: string };

    expect(result).toHaveProperty('sessionId');
    expect(typeof result.sessionId).toBe('string');
    const { sessionId } = result;

    // The IPC handler must have called spawnSpecCheck and wired up onChunk.
    expect(capturedOnChunk).toBeDefined();

    // Fire two scripted text events, just as the real Claude CLI subprocess
    // would emit them from its stdout parse loop.
    capturedOnChunk!({ kind: 'text', delta: 'Evaluating Problem Statement...' });
    capturedOnChunk!({ kind: 'text', delta: ' Checking Scope Boundaries...' });

    // Both deltas must have been forwarded to the renderer on the correct channel
    // with the session's ID so the store can route them to the right session.
    expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
      'refinement:progress',
      { sessionId, delta: 'Evaluating Problem Statement...' },
    );
    expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
      'refinement:progress',
      { sessionId, delta: ' Checking Scope Boundaries...' },
    );
  });

  it('formats tool_use events as → indicator lines in refinement:progress', async () => {
    let capturedOnChunk: ((event: EphemeralStreamEvent) => void) | undefined;

    mockSpawnSpecCheck.mockImplementation(
      (_ticketId: unknown, _projectDir: unknown, onChunk: (event: EphemeralStreamEvent) => void) => {
        capturedOnChunk = onChunk;
        return {
          promise: new Promise<Record<string, unknown>>(() => {}),
          cancel: vi.fn(),
        };
      },
    );

    const result = (await invokeHandler(
      'tickets:specCheckAsync',
      'TICKET-123',
      '/tmp/my-project',
    )) as { sessionId: string };
    const { sessionId } = result;

    capturedOnChunk!({ kind: 'tool_use', name: 'Read', summary: 'Read(src/main/foo.ts)' });

    expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
      'refinement:progress',
      { sessionId, delta: '→ Read(src/main/foo.ts)\n' },
    );
  });

  it('scopes refinement:progress events to the originating session ID', async () => {
    const onChunks: Array<(event: EphemeralStreamEvent) => void> = [];

    mockSpawnSpecCheck.mockImplementation(
      (_ticketId: unknown, _projectDir: unknown, onChunk: (event: EphemeralStreamEvent) => void) => {
        onChunks.push(onChunk);
        return {
          promise: new Promise<Record<string, unknown>>(() => {}),
          cancel: vi.fn(),
        };
      },
    );

    const r1 = (await invokeHandler('tickets:specCheckAsync', 'T-1', '/tmp/proj1')) as {
      sessionId: string;
    };
    const r2 = (await invokeHandler('tickets:specCheckAsync', 'T-2', '/tmp/proj2')) as {
      sessionId: string;
    };

    expect(onChunks).toHaveLength(2);
    expect(r1.sessionId).not.toBe(r2.sessionId);

    onChunks[0]({ kind: 'text', delta: 'delta for session 1' });
    onChunks[1]({ kind: 'text', delta: 'delta for session 2' });

    const progressCalls = mockMainWindow.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'refinement:progress',
    );

    const s1Calls = progressCalls.filter(([, payload]) => (payload as { sessionId: string }).sessionId === r1.sessionId);
    const s2Calls = progressCalls.filter(([, payload]) => (payload as { sessionId: string }).sessionId === r2.sessionId);

    expect(s1Calls).toHaveLength(1);
    expect(s1Calls[0][1]).toEqual({ sessionId: r1.sessionId, delta: 'delta for session 1' });

    expect(s2Calls).toHaveLength(1);
    expect(s2Calls[0][1]).toEqual({ sessionId: r2.sessionId, delta: 'delta for session 2' });
  });

  it('sends a refinement:update event when the session starts', async () => {
    mockSpawnSpecCheck.mockReturnValue({
      promise: new Promise<Record<string, unknown>>(() => {}),
      cancel: vi.fn(),
    });

    await invokeHandler('tickets:specCheckAsync', 'TICKET-1', '/tmp/proj');

    expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
      'refinement:update',
      expect.objectContaining({ status: 'running', ticketId: 'TICKET-1' }),
    );
  });
});

// ---------------------------------------------------------------------------
// retryRefinementAsync — phase-aware retry
// ---------------------------------------------------------------------------
describe('retryRefinementAsync — phase-aware retry', () => {
  let mockMainWindow: { webContents: { send: Mock } };

  beforeEach(() => {
    for (const key of Object.keys(registeredHandlers)) {
      delete registeredHandlers[key];
    }
    vi.clearAllMocks();
    mockListTicketComments.mockResolvedValue([]);

    mockMainWindow = { webContents: { send: vi.fn() } };
    registerIpcHandlers(mockMainWindow as unknown as import('electron').BrowserWindow);
  });

  it('falls back to check phase when no session ID is provided', async () => {
    mockSpawnSpecCheck.mockReturnValue({
      promise: new Promise<Record<string, unknown>>(() => {}),
      cancel: vi.fn(),
    });

    const result = (await invokeHandler(
      'tickets:retryRefinementAsync',
      '',
      'TICKET-1',
      '/tmp/proj',
    )) as { sessionId: string };

    expect(result).toHaveProperty('sessionId');
    expect(mockSpawnSpecCheck).toHaveBeenCalledWith('TICKET-1', '/tmp/proj', expect.any(Function));
    expect(mockSpawnSpecRefine).not.toHaveBeenCalled();
  });

  it('uses check phase when existing session has phase=check', async () => {
    // First create a session in check phase
    mockSpawnSpecCheck.mockReturnValue({
      promise: new Promise<Record<string, unknown>>(() => {}),
      cancel: vi.fn(),
    });
    const r1 = (await invokeHandler('tickets:specCheckAsync', 'TICKET-1', '/tmp/proj')) as { sessionId: string };

    vi.clearAllMocks();
    mockSpawnSpecCheck.mockReturnValue({
      promise: new Promise<Record<string, unknown>>(() => {}),
      cancel: vi.fn(),
    });

    await invokeHandler('tickets:retryRefinementAsync', r1.sessionId, 'TICKET-1', '/tmp/proj');

    expect(mockSpawnSpecCheck).toHaveBeenCalledWith('TICKET-1', '/tmp/proj', expect.any(Function));
    expect(mockSpawnSpecRefine).not.toHaveBeenCalled();
  });

  it('uses refine phase and passes answer comments when session has phase=refine and answers exist', async () => {
    // Create a session in refine phase by calling specRefineAsync
    mockSpawnSpecRefine.mockReturnValue({
      promise: new Promise<Record<string, unknown>>(() => {}),
      cancel: vi.fn(),
    });
    const fakeSessionId = 'refine-session-1';
    // Manually invoke the specRefineAsync handler, which creates a 'refine' phase session
    await invokeHandler('tickets:specRefineAsync', fakeSessionId, 'TICKET-2', '/tmp/proj2', 'some answers');

    // Set up answer comments for retrieval
    const ANSWER_MARKER = '<!-- sandstorm:user-answers -->';
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

    const result = (await invokeHandler(
      'tickets:retryRefinementAsync',
      fakeSessionId,
      'TICKET-2',
      '/tmp/proj2',
    )) as { sessionId: string };

    expect(result).toHaveProperty('sessionId');
    expect(mockSpawnSpecRefine).toHaveBeenCalledWith(
      'TICKET-2',
      '/tmp/proj2',
      'Q1: Answer A\nQ2: Answer B',
      expect.any(Function),
    );
    expect(mockSpawnSpecCheck).not.toHaveBeenCalled();
  });

  it('falls back to check phase when session has phase=refine but no answer comments', async () => {
    // Create a session in refine phase
    mockSpawnSpecRefine.mockReturnValue({
      promise: new Promise<Record<string, unknown>>(() => {}),
      cancel: vi.fn(),
    });
    const fakeSessionId = 'refine-session-2';
    await invokeHandler('tickets:specRefineAsync', fakeSessionId, 'TICKET-3', '/tmp/proj3', 'answers');

    // No answer comments
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

  it('sends running update event for the new session', async () => {
    mockSpawnSpecCheck.mockReturnValue({
      promise: new Promise<Record<string, unknown>>(() => {}),
      cancel: vi.fn(),
    });

    await invokeHandler('tickets:retryRefinementAsync', '', 'TICKET-4', '/tmp/proj4');

    expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
      'refinement:update',
      expect.objectContaining({ status: 'running', ticketId: 'TICKET-4' }),
    );
  });
});
