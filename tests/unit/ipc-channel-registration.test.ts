/**
 * Asserts that registerIpcHandlers registers every channel defined in INVOKE_CHANNELS
 * and that the total count of registered channels is unchanged after the domain split.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { INVOKE_CHANNELS } from '../../src/main/ipc-channels';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const {
  handleChannels,
  onChannels,
  mockRegistry,
  mockStackManager,
  mockSessionMonitor,
  mockRollupStoreInstance,
} = vi.hoisted(() => {
  const handleChannels = new Set<string>();
  const onChannels = new Set<string>();

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
    listBoardTicketsInOrder: vi.fn().mockReturnValue([]),
    setBoardTicketColumn: vi.fn(),
    deleteClosedEarlyColumnTickets: vi.fn().mockReturnValue(0),
    deleteBoardTicket: vi.fn(),
    getDarkFactoryEnabled: vi.fn().mockReturnValue(false),
    setDarkFactoryEnabled: vi.fn(),
    getDarkFactoryConfig: vi.fn().mockReturnValue({ level: 'manual', merge_strategy: 'squash' }),
    setDarkFactoryConfig: vi.fn(),
    getDb: vi.fn().mockReturnValue({}),
    getStepWeightsByTicket: vi.fn().mockReturnValue([]),
    getTaskPhaseTokensByTicket: vi.fn().mockReturnValue([]),
    getAllEpicTasks: vi.fn().mockReturnValue([]),
    getGlobalBackendSettings: vi.fn().mockReturnValue({
      inner_backend: 'claude',
      outer_backend: 'claude',
      inner_provider: null,
      inner_model: null,
      outer_provider: null,
      outer_model: null,
    }),
    setGlobalBackendSettings: vi.fn(),
    getProjectBackendSettings: vi.fn().mockReturnValue(null),
    setProjectBackendSettings: vi.fn(),
    getEffectiveBackend: vi.fn().mockReturnValue({ backend: 'claude' }),
    setBackendSecret: vi.fn(),
    hasBackendSecret: vi.fn().mockReturnValue(false),
    hasProviderSecret: vi.fn().mockReturnValue(false),
    getProviderSecretBundle: vi.fn().mockReturnValue(null),
    setProviderSecretBundle: vi.fn(),
    removeProviderSecret: vi.fn(),
    getEffectiveRouting: vi.fn().mockReturnValue({}),
    getEffectiveRoutingFor: vi.fn().mockReturnValue({ backend: 'claude', provider: 'anthropic', model: 'haiku' }),
    getLegacyEffectiveModels: vi.fn().mockReturnValue({ inner_model: 'sonnet', outer_model: 'opus' }),
    getEffectiveTouchpointDescriptor: vi.fn().mockReturnValue({ backend: 'claude', provider: 'anthropic', model: 'haiku', credentials: {} }),
    getProjectRouting: vi.fn().mockReturnValue(null),
    setProjectRouting: vi.fn(),
    removeProjectRouting: vi.fn(),
    getGlobalRouting: vi.fn().mockReturnValue({ assignments: {}, preset: null }),
    setGlobalRouting: vi.fn(),
    applyPreset: vi.fn(),
    onBoardTicketMoved: vi.fn(),
    getSessionMonitorSettings: vi.fn().mockReturnValue({}),
    setSessionMonitorSettings: vi.fn(),
    getNeedsHumanQuestions: vi.fn().mockReturnValue([]),
    getStoredProviderKeys: vi.fn().mockReturnValue([]),
    setBackendSecretBundle: vi.fn(),
    getBackendSecretBundle: vi.fn().mockReturnValue(null),
    getTaskTokenSteps: vi.fn().mockReturnValue([]),
    getGlobalModelSettings: vi.fn().mockReturnValue({}),
    setGlobalModelSettings: vi.fn(),
    getProjectModelSettings: vi.fn().mockReturnValue(null),
    setProjectModelSettings: vi.fn(),
    removeProjectModelSettings: vi.fn(),
    getEffectiveModels: vi.fn().mockReturnValue({}),
    listStacks: vi.fn().mockReturnValue([]),
    getEpicTasks: vi.fn().mockReturnValue([]),
    upsertEpicRunState: vi.fn(),
    upsertEpicTask: vi.fn(),
    setEpicTaskDone: vi.fn(),
    getEpicRunState: vi.fn().mockReturnValue(null),
    getEpicMaxParallelStacks: vi.fn().mockReturnValue(1),
  };

  const mockStackManager = {
    setOnStackUpdate: vi.fn(),
    listStacksWithServices: vi.fn().mockResolvedValue([]),
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
    sessionPauseAllStacks: vi.fn(),
    sessionResumeAllStacks: vi.fn(),
    sessionResumeStack: vi.fn(),
    resumeNeedsHumanStack: vi.fn(),
    askClarifyingQuestions: vi.fn(),
    recheckCompletedStack: vi.fn(),
    reconcileStatus: vi.fn(),
    selfHealContinue: vi.fn(),
    restartWithFindings: vi.fn(),
    exposePort: vi.fn(),
    unexposePort: vi.fn(),
    getTaskOutput: vi.fn(),
    execInContainer: vi.fn(),
  };

  const mockSessionMonitor = {
    getState: vi.fn().mockReturnValue({ halted: false, usage: null }),
    acknowledgeCritical: vi.fn(),
    markResumed: vi.fn(),
    updateSettings: vi.fn(),
    forcePoll: vi.fn(),
    reportActivity: vi.fn(),
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
    handleChannels,
    onChannels,
    mockRegistry,
    mockStackManager,
    mockSessionMonitor,
    mockRollupStoreInstance,
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string) => { handleChannels.add(channel); }),
    on: vi.fn((channel: string) => { onChannels.add(channel); }),
  },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  app: { getPath: () => '/tmp' },
}));

vi.mock('../../src/main/index', () => ({
  registry: mockRegistry,
  stackManager: mockStackManager,
  dockerRuntime: { isAvailable: vi.fn(), logs: vi.fn() },
  podmanRuntime: { isAvailable: vi.fn(), logs: vi.fn() },
  agentBackend: {
    sendMessage: vi.fn(),
    cancelSession: vi.fn(),
    resetSession: vi.fn(),
    getHistory: vi.fn(),
    getAuthStatus: vi.fn(),
    login: vi.fn(),
    syncCredentials: vi.fn(),
    getEphemeralTimingPath: vi.fn().mockReturnValue('/tmp/mock-ephemeral-timing.jsonl'),
    runEphemeralAgent: vi.fn().mockResolvedValue(''),
    getSessionTokens: vi.fn(),
  },
  dockerConnectionManager: { isConnected: false },
  sessionMonitor: mockSessionMonitor,
  cliDir: '/tmp/sandstorm-cli',
  darkFactoryOrchestrator: null,
}));

vi.mock('../../src/main/control-plane/epic-runner', () => ({
  initEpicRunner: vi.fn().mockReturnValue({
    setOnStatusUpdate: vi.fn(),
    onAnyStackUpdated: vi.fn().mockResolvedValue(undefined),
    startEpic: vi.fn(),
    getRunPlan: vi.fn(),
  }),
  getEpicRunner: vi.fn().mockReturnValue({
    onAnyStackUpdated: vi.fn().mockResolvedValue(undefined),
    startEpic: vi.fn(),
    getRunPlan: vi.fn(),
  }),
}));

vi.mock('../../src/main/control-plane/ticket-config', () => ({
  createTicketWithConfig: vi.fn(),
  closeTicketWithConfig: vi.fn(),
  markTicketDoneWithConfig: vi.fn(),
  testJiraConnection: vi.fn(),
  fetchTicketWithConfig: vi.fn().mockResolvedValue(null),
  updateTicketWithConfig: vi.fn(),
  fetchRawBodyWithConfig: vi.fn(),
}));

vi.mock('../../src/main/control-plane/refinement-store', () => ({
  persistRefinement: vi.fn(),
  deleteRefinement: vi.fn(),
  loadRefinements: vi.fn().mockReturnValue([]),
  filterSessionsByBoardState: vi.fn().mockReturnValue({ keep: [], prune: [] }),
}));

vi.mock('../../src/main/telemetry/rollup-store', () => ({
  TicketRollupStore: vi.fn().mockImplementation(() => mockRollupStoreInstance),
}));

vi.mock('../../src/main/telemetry/usage-engine', () => ({
  createUsageEngine: vi.fn().mockReturnValue({
    getSummary: vi.fn().mockReturnValue({ monthCost: 0, ticketsShipped: null, costPerTicket: null }),
    getDaily: vi.fn().mockReturnValue([]),
    getByModel: vi.fn().mockReturnValue([]),
    getSessions: vi.fn().mockReturnValue([]),
    getByTicket: vi.fn().mockReturnValue([]),
    getByEpic: vi.fn().mockReturnValue([]),
  }),
  clearUsageCache: vi.fn(),
}));

vi.mock('../../src/main/agent/ephemeral-timing', () => ({
  readEphemeralTimingRecords: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/main/control-plane/account-usage', () => ({
  fetchAccountUsage: vi.fn(),
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
  projectIdFromDir: vi.fn().mockReturnValue('test-project'),
}));

vi.mock('../../src/main/scheduler/built-in-actions', () => ({
  BUILT_IN_ACTIONS: [],
}));

vi.mock('../../src/main/claude/tools', () => ({
  handleToolCall: vi.fn(),
  makeContractGateDeps: vi.fn().mockReturnValue({}),
  spawnSpecCheck: vi.fn().mockReturnValue({ promise: Promise.resolve({ passed: true, report: '' }), cancel: vi.fn() }),
  spawnSpecRefine: vi.fn().mockReturnValue({ promise: Promise.resolve({ passed: true, report: '' }), cancel: vi.fn() }),
}));

vi.mock('../../src/main/control-plane/ticket-spec', () => ({
  defaultSpecGateDeps: vi.fn().mockReturnValue({
    readTicketUrl: vi.fn().mockResolvedValue(null),
    fetchTicket: vi.fn().mockResolvedValue(null),
  }),
  fetchTicketForRenderer: vi.fn(),
  runSpecCheck: vi.fn(),
  runSpecRefine: vi.fn(),
  finalizeSpecGatePass: vi.fn(),
  extractQuestions: vi.fn().mockReturnValue([]),
  extractGateSummary: vi.fn().mockReturnValue(''),
  shortBodyHash: vi.fn().mockReturnValue('hash'),
  capReportText: vi.fn().mockReturnValue(''),
}));

vi.mock('../../src/main/control-plane/ticket-lister', () => ({
  listTicketsWithConfig: vi.fn().mockResolvedValue({ ok: false, error: { reason: 'network', message: 'mock' } }),
}));

vi.mock('../../src/main/control-plane/ticket-comments', () => ({
  listTicketComments: vi.fn().mockResolvedValue([]),
  postComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/main/scheduler/refine-to-comments', () => ({
  getLatestUserAnswers: vi.fn().mockReturnValue(null),
  ANSWER_COMMENT_MARKER: '[ANSWERS]',
  GATE_FAIL_REPORT_MARKER: '[GATE_FAIL]',
}));

vi.mock('../../src/main/control-plane/retry-with-backoff', () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../src/main/control-plane/pr-creator', () => ({
  draftPullRequest: vi.fn(),
  createPullRequest: vi.fn(),
  workspacePathFor: vi.fn().mockReturnValue('/tmp/workspace'),
}));

vi.mock('../../src/main/tray', () => ({
  showNotification: vi.fn(),
}));

vi.mock('../../src/main/control-plane/provider-catalog', () => ({
  fetchProviderCatalog: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/main/control-plane/routing', () => ({
  getAvailableModels: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/main/custom-context', () => ({
  getCustomContext: vi.fn(),
  saveCustomInstructions: vi.fn(),
  listCustomSkills: vi.fn().mockReturnValue([]),
  getCustomSkill: vi.fn(),
  saveCustomSkill: vi.fn(),
  deleteCustomSkill: vi.fn(),
  getCustomSettings: vi.fn(),
  saveCustomSettings: vi.fn(),
}));

vi.mock('../../src/main/review-prompt', () => ({
  getDefaultReviewPrompt: vi.fn().mockReturnValue(''),
}));

vi.mock('../../src/main/compose-generator', () => ({
  checkInitState: vi.fn().mockReturnValue('full'),
  findProjectComposeFile: vi.fn().mockReturnValue(null),
  readComposeFileFromConfig: vi.fn().mockReturnValue(null),
  generateSandstormCompose: vi.fn(),
  saveComposeSetup: vi.fn(),
  validateComposeYaml: vi.fn().mockReturnValue({ valid: true }),
  hasLegacyPortMappings: vi.fn().mockReturnValue(false),
  cleanupLegacyPorts: vi.fn(),
}));

vi.mock('../../src/main/network-migration', () => ({
  migrateNetworkOverrides: vi.fn().mockReturnValue(false),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  spawnSync: vi.fn().mockReturnValue({ status: 1 }),
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => '/mock-home' } };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { registerIpcHandlers } from '../../src/main/ipc';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('IPC channel registration coverage', () => {
  beforeEach(() => {
    handleChannels.clear();
    onChannels.clear();
    vi.clearAllMocks();
    registerIpcHandlers();
  });

  it('registers every INVOKE_CHANNELS value via handle or on', () => {
    const allChannels = Object.values(INVOKE_CHANNELS);
    const registered = new Set([...handleChannels, ...onChannels]);
    const missing = allChannels.filter((ch) => !registered.has(ch));
    expect(missing, `Missing channel registrations: ${missing.join(', ')}`).toEqual([]);
  });

  it('registers the expected total count of channels', () => {
    const totalDeclared = Object.values(INVOKE_CHANNELS).length;
    const totalRegistered = handleChannels.size + onChannels.size;
    expect(totalRegistered).toBe(totalDeclared);
  });

  it('SESSION_ACTIVITY is registered via ipcMain.on (fire-and-forget)', () => {
    expect(onChannels.has(INVOKE_CHANNELS.SESSION_ACTIVITY)).toBe(true);
    expect(handleChannels.has(INVOKE_CHANNELS.SESSION_ACTIVITY)).toBe(false);
  });

  it('all other INVOKE_CHANNELS are registered via ipcMain.handle', () => {
    const handleOnly = Object.values(INVOKE_CHANNELS).filter(
      (ch) => ch !== INVOKE_CHANNELS.SESSION_ACTIVITY,
    );
    const missing = handleOnly.filter((ch) => !handleChannels.has(ch));
    expect(missing, `Missing handle registrations: ${missing.join(', ')}`).toEqual([]);
  });
});
