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
  mockTestJiraConnection,
  mockSessionMonitor,
  mockSpawnSpecCheck,
  mockSpawnSpecRefine,
  mockListTicketComments,
  mockDeleteRefinement,
  mockPersistRefinement,
  mockLoadRefinements,
} = vi.hoisted(() => {
  const registeredHandlers: Record<string, (...args: unknown[]) => unknown> = {};
  const mockSpawnSpecCheck = vi.fn();
  const mockSpawnSpecRefine = vi.fn();
  const mockListTicketComments = vi.fn().mockResolvedValue([]);
  const mockDeleteRefinement = vi.fn();
  const mockPersistRefinement = vi.fn();
  const mockLoadRefinements = vi.fn().mockReturnValue([]);

  const mockRegistry = {
    listProjects: vi.fn(),
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
    mockTestJiraConnection,
    mockSessionMonitor,
    mockSpawnSpecCheck,
    mockSpawnSpecRefine,
    mockListTicketComments,
    mockDeleteRefinement,
    mockPersistRefinement,
    mockLoadRefinements,
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
}));

vi.mock('../../src/main/custom-context', () => mockCustomContext);

vi.mock('../../src/main/control-plane/account-usage', () => ({
  fetchAccountUsage: mockFetchAccountUsage,
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
  testJiraConnection: (...args: unknown[]) => mockTestJiraConnection(...args),
}));

vi.mock('../../src/main/claude/tools', () => ({
  handleToolCall: vi.fn(),
  spawnSpecCheck: (...args: unknown[]) => mockSpawnSpecCheck(...args),
  spawnSpecRefine: (...args: unknown[]) => mockSpawnSpecRefine(...args),
  validateProjectDir: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/main/control-plane/ticket-comments', () => ({
  listTicketComments: (...args: unknown[]) => mockListTicketComments(...args),
  postComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/main/control-plane/refinement-store', () => ({
  persistRefinement: (...args: unknown[]) => mockPersistRefinement(...args),
  deleteRefinement: (...args: unknown[]) => mockDeleteRefinement(...args),
  loadRefinements: () => mockLoadRefinements(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { registerIpcHandlers } from '../../src/main/ipc';
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
        jql: { ok: true, count: 7 },
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
    it('invokes gh pr merge with --merge and no --delete-branch, cwd set to stack workspace', async () => {
      const stack = { id: 'stack-1', project_dir: '/proj', pr_number: 99, status: 'pr_created', services: [] };
      mockStackManager.getStackWithServices.mockResolvedValue(stack);
      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: (...a: unknown[]) => void) => {
          callback(null, '', '');
        },
      );

      await invokeHandler('pr:merge', 'stack-1', 99);

      expect(execFile).toHaveBeenCalledWith(
        'gh',
        ['pr', 'merge', '99', '--merge'],
        expect.objectContaining({ cwd: '/proj/.sandstorm/workspaces/stack-1' }),
        expect.any(Function),
      );
      const callArgs = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1) as unknown[];
      const ghArgs = callArgs[1] as string[];
      expect(ghArgs).not.toContain('--delete-branch');
    });

    it('throws when stack is not found', async () => {
      mockStackManager.getStackWithServices.mockResolvedValue(null);
      await expect(invokeHandler('pr:merge', 'missing-stack', 1)).rejects.toThrow('Stack "missing-stack" not found');
    });

    it('propagates gh CLI error to caller', async () => {
      const stack = { id: 'stack-1', project_dir: '/proj', pr_number: 42, status: 'pr_created', services: [] };
      mockStackManager.getStackWithServices.mockResolvedValue(stack);
      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: (...a: unknown[]) => void) => {
          callback(new Error('branch protection rule'), '', '');
        },
      );

      await expect(invokeHandler('pr:merge', 'stack-1', 42)).rejects.toThrow('branch protection rule');
    });

    it('treats an already-merged PR as success (does not throw) — error message form', async () => {
      const stack = { id: 'stack-1', project_dir: '/proj', pr_number: 99, status: 'pr_created', services: [] };
      mockStackManager.getStackWithServices.mockResolvedValue(stack);
      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: (...a: unknown[]) => void) => {
          callback(new Error('Pull request #99 is already merged'), '', '');
        },
      );

      await expect(invokeHandler('pr:merge', 'stack-1', 99)).resolves.toBeUndefined();
    });

    it('treats an already-merged PR as success when the detail is on stderr', async () => {
      const stack = { id: 'stack-1', project_dir: '/proj', pr_number: 99, status: 'pr_created', services: [] };
      mockStackManager.getStackWithServices.mockResolvedValue(stack);
      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_cmd: unknown, _args: unknown, _opts: unknown, callback: (...a: unknown[]) => void) => {
          const err = Object.assign(new Error('Command failed: gh pr merge 99 --merge'), {
            stderr: 'GraphQL: Pull request is already merged (mergePullRequest)',
          });
          callback(err, '', err.stderr);
        },
      );

      await expect(invokeHandler('pr:merge', 'stack-1', 99)).resolves.toBeUndefined();
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
  // tickets:discardRefinement
  // =========================================================================
  describe('tickets:discardRefinement', () => {
    beforeEach(() => {
      mockSpawnSpecCheck.mockReturnValue({
        promise: new Promise<Record<string, unknown>>(() => {}),
        cancel: vi.fn(),
      });
    });

    it('removes the activeRefinements entry and calls deleteRefinement', async () => {
      const { sessionId } = await invokeHandler('tickets:specCheckAsync', 'TICKET-D1', '/tmp/proj-d') as { sessionId: string };
      mockDeleteRefinement.mockClear();

      await invokeHandler('tickets:discardRefinement', sessionId);

      expect(mockDeleteRefinement).toHaveBeenCalledWith(sessionId);

      // The session should no longer appear in listRefinements
      const list = await invokeHandler('tickets:listRefinements') as unknown[];
      expect(list.find((s: unknown) => (s as { id: string }).id === sessionId)).toBeUndefined();
    });

    it('does NOT call entry.cancel for a running session', async () => {
      const cancelSpy = vi.fn();
      mockSpawnSpecCheck.mockReturnValue({
        promise: new Promise<Record<string, unknown>>(() => {}),
        cancel: cancelSpy,
      });

      const { sessionId } = await invokeHandler('tickets:specCheckAsync', 'TICKET-D2', '/tmp/proj-d2') as { sessionId: string };

      await invokeHandler('tickets:discardRefinement', sessionId);

      expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('is a no-op for an unknown session id', async () => {
      mockDeleteRefinement.mockClear();
      await invokeHandler('tickets:discardRefinement', 'no-such-id');
      expect(mockDeleteRefinement).not.toHaveBeenCalled();
    });

    it('removes an errored (terminal-state) session — regression for original bug', async () => {
      // Register a session and let it error out
      let rejectFn!: (err: Error) => void;
      mockSpawnSpecCheck.mockReturnValue({
        promise: new Promise<Record<string, unknown>>((_resolve, reject) => {
          rejectFn = reject;
        }),
        cancel: vi.fn(),
      });

      const { sessionId } = await invokeHandler('tickets:specCheckAsync', 'TICKET-D3', '/tmp/proj-d3') as { sessionId: string };
      rejectFn(new Error('gate failed'));
      // Allow the rejection handler to settle
      await new Promise((r) => setTimeout(r, 0));

      mockDeleteRefinement.mockClear();
      await invokeHandler('tickets:discardRefinement', sessionId);

      expect(mockDeleteRefinement).toHaveBeenCalledWith(sessionId);
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
      'tickets:discardRefinement',
      'tickets:listRefinements',
      'tickets:create',
      'tickets:fetchRaw',
      'tickets:update',
      'tickets:list',
      'tickets:testJiraConnection',
      'ticket:close',
      'ticket-board:set-column',
      'ticket-board:delete',
      'pr:draftBody',
      'pr:create',
      'pr:merge',
      'pr:createAuto',
      'projectTicketConfig:get',
      'projectTicketConfig:set',
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
});
