import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';

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
} = vi.hoisted(() => {
  const registeredHandlers: Record<string, (...args: unknown[]) => unknown> = {};

  const mockRegistry = {
    listProjects: vi.fn(),
    addProject: vi.fn(),
    removeProject: vi.fn(),
    getPorts: vi.fn(),
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
  cliDir: '/tmp/sandstorm-cli',
}));

vi.mock('../../src/main/custom-context', () => mockCustomContext);

vi.mock('../../src/main/control-plane/account-usage', () => ({
  fetchAccountUsage: mockFetchAccountUsage,
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { registerIpcHandlers } from '../../src/main/ipc';
import { dialog, BrowserWindow } from 'electron';

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
      await invokeHandler('projects:remove', 1);
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
  // Handler Registration Completeness
  // =========================================================================
  describe('handler registration', () => {
    const expectedChannels = [
      'agent:send',
      'agent:cancel',
      'agent:reset',
      'agent:history',
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
      'diff:get',
      'push:execute',
      'ports:get',
      'logs:stream',
      'stats:stack-memory',
      'stats:stack-detailed',
      'stats:task-metrics',
      'stats:token-usage',
      'stats:global-token-usage',
      'stats:rate-limit',
      'stats:account-usage',
      'stats:outer-claude-tokens',
      'context:get',
      'context:saveInstructions',
      'context:listSkills',
      'context:getSkill',
      'context:saveSkill',
      'context:deleteSkill',
      'context:getSettings',
      'context:saveSettings',
      'specGate:get',
      'specGate:save',
      'specGate:getDefault',
      'specGate:ensure',
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
      'session:forcePoll',
      'docker:status',
      'auth:status',
      'auth:login',
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
});
