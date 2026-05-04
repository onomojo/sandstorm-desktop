import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import {
  StackManager,
  sanitizeComposeName,
  referencesGitHubIssue,
  tailBytes,
  TASK_OUTPUT_MAX_BYTES,
  LOGS_PER_CONTAINER_MAX_BYTES,
  LOGS_TOTAL_MAX_BYTES,
} from '../../src/main/control-plane/stack-manager';
import { Registry } from '../../src/main/control-plane/registry';
import { PortAllocator } from '../../src/main/control-plane/port-allocator';
import { TaskWatcher } from '../../src/main/control-plane/task-watcher';
import { ContainerRuntime } from '../../src/main/runtime/types';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-mgr-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
    listContainers: vi.fn().mockResolvedValue([
      {
        id: 'claude-container-1',
        name: 'sandstorm-proj-test-stack-claude-1',
        image: 'sandstorm-claude',
        status: 'running' as const,
        state: 'running',
        ports: [],
        labels: {},
        created: new Date().toISOString(),
      },
    ]),
    inspect: vi.fn(),
    logs: vi.fn().mockReturnValue((async function* () {})()),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('Mock 1.0'),
  };
}

function makeStack(id: string = 'test-stack') {
  return {
    id,
    project: 'proj',
    project_dir: '/proj',
    ticket: null,
    branch: null,
    description: null,
    status: 'up' as const,
    runtime: 'docker' as const,
  };
}

describe('sanitizeComposeName', () => {
  it('passes through valid names unchanged', () => {
    expect(sanitizeComposeName('auth-refactor')).toBe('auth-refactor');
    expect(sanitizeComposeName('my_stack')).toBe('my_stack');
    expect(sanitizeComposeName('test123')).toBe('test123');
  });

  it('converts spaces to hyphens', () => {
    expect(sanitizeComposeName('my stack')).toBe('my-stack');
    expect(sanitizeComposeName('my  big  stack')).toBe('my-big-stack');
  });

  it('lowercases the input', () => {
    expect(sanitizeComposeName('MyStack')).toBe('mystack');
    expect(sanitizeComposeName('AUTH-REFACTOR')).toBe('auth-refactor');
  });

  it('strips special characters', () => {
    expect(sanitizeComposeName('my@stack!')).toBe('mystack');
    expect(sanitizeComposeName('stack#1$2%3')).toBe('stack123');
  });

  it('passes through names starting with digits unchanged', () => {
    // The "sandstorm-" prefix in compose project names ensures the full name
    // starts with a letter, so individual segments don't need the "s" prefix.
    // This matches the CLI behavior so container names stay consistent.
    expect(sanitizeComposeName('123stack')).toBe('123stack');
    expect(sanitizeComposeName('36-solid-queue')).toBe('36-solid-queue');
  });

  it('handles names starting with hyphens', () => {
    expect(sanitizeComposeName('--my-stack')).toBe('my-stack');
  });

  it('strips trailing hyphens', () => {
    expect(sanitizeComposeName('my-stack--')).toBe('my-stack');
  });

  it('collapses repeated hyphens', () => {
    expect(sanitizeComposeName('my---stack')).toBe('my-stack');
  });

  it('returns "stack" for empty or all-invalid input', () => {
    expect(sanitizeComposeName('')).toBe('stack');
    expect(sanitizeComposeName('!!!')).toBe('stack');
    expect(sanitizeComposeName('   ')).toBe('stack');
  });

  it('handles mixed problematic input', () => {
    expect(sanitizeComposeName('My Cool Stack!!')).toBe('my-cool-stack');
    expect(sanitizeComposeName('  --test@name-- ')).toBe('testname');
  });
});

describe('StackManager', () => {
  let registry: Registry;
  let portAllocator: PortAllocator;
  let taskWatcher: TaskWatcher;
  let runtime: ContainerRuntime;
  let manager: StackManager;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    runtime = createMockRuntime();
    portAllocator = new PortAllocator(registry, [40000, 40099]);
    taskWatcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 100 });
    manager = new StackManager(registry, portAllocator, taskWatcher, runtime, runtime, '/fake/cli');
  });

  afterEach(() => {
    taskWatcher.unwatchAll();
    registry.close();
    cleanupDb(dbPath);
  });

  describe('createStack', () => {
    let tmpDir: string;

    beforeAll(() => {
      const result = spawnSync('git', ['--version'], { encoding: 'utf-8' });
      if (result.status !== 0) {
        throw new Error(
          'git binary not found on PATH. createStack tests require git to set up bare repos and clones.'
        );
      }
    });

    beforeEach(() => {
      const { execSync } = require('child_process');

      // Create a bare repo to serve as a local "remote"
      const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-bare-'));
      execSync('git init --bare', { cwd: bareDir, stdio: 'ignore' });

      // Create the project dir as a clone of the bare repo
      tmpDir = path.join(os.tmpdir(), `sandstorm-proj-${Date.now()}`);
      execSync(`git clone "${bareDir}" "${tmpDir}"`, { stdio: 'ignore' });

      // Create sandstorm config and make an initial commit so the branch exists
      const sandstormDir = path.join(tmpDir, '.sandstorm');
      fs.mkdirSync(sandstormDir, { recursive: true });
      fs.writeFileSync(path.join(sandstormDir, 'config'), 'PORT_MAP="app:8080:3000:0"\n');
      execSync('git add -A && git commit -m "init" && git push origin HEAD', {
        cwd: tmpDir,
        stdio: 'ignore',
        env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
      });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns stack immediately with building status', () => {
      // Mock runCli so it doesn't actually call the CLI
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const stack = manager.createStack({
        name: 'imm-test',
        projectDir: tmpDir,
        runtime: 'docker',
      });

      expect(stack).toBeDefined();
      expect(stack.id).toBe('imm-test');
      expect(stack.status).toBe('building');
    });

    it('transitions to up status after background build completes', async () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      manager.createStack({
        name: 'fk-test',
        projectDir: tmpDir,
        runtime: 'docker',
      });

      // Wait for the background build to finish
      await vi.waitFor(() => {
        const stack = registry.getStack('fk-test');
        expect(stack!.status).toBe('up');
      }, { timeout: 5000 });

      // Ports are now allocated on-demand via proxy containers, not at stack creation
      const ports = registry.getPorts('fk-test');
      expect(ports).toHaveLength(0);
    });

    it('creates a stack with optional fields', () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      fs.writeFileSync(path.join(tmpDir, '.sandstorm', 'config'), '# no ports\n');

      const stack = manager.createStack({
        name: 'opts-test',
        projectDir: tmpDir,
        ticket: 'JIRA-123',
        description: 'testing options',
        runtime: 'docker',
        gateApproved: true,
      });

      expect(stack.ticket).toBe('JIRA-123');
      expect(stack.branch).toBeNull();
      expect(stack.description).toBe('testing options');
    });

    it('marks stack as failed with error message when CLI returns non-zero', async () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: 'compose failed',
        exitCode: 1,
      });

      fs.writeFileSync(path.join(tmpDir, '.sandstorm', 'config'), '# empty\n');

      manager.createStack({ name: 'fail-test', projectDir: tmpDir, runtime: 'docker' });

      // Wait for background build to fail
      await vi.waitFor(() => {
        const stack = registry.getStack('fail-test');
        expect(stack!.status).toBe('failed');
        expect(stack!.error).toBe('compose failed');
      }, { timeout: 5000 });
    });

    it('passes port env vars and stack args to CLI', async () => {
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      manager.createStack({
        name: 'env-test',
        projectDir: tmpDir,
        ticket: 'PROJ-1',
        branch: 'feature/test',
        runtime: 'docker',
        gateApproved: true,
      });

      await vi.waitFor(() => {
        const stack = registry.getStack('env-test');
        expect(stack!.status).toBe('up');
      }, { timeout: 5000 });

      expect(runCliSpy).toHaveBeenCalled();
      const [dir, args, env] = runCliSpy.mock.calls[0];
      expect(dir).toBe(tmpDir);
      expect(args).toContain('up');
      expect(args).toContain('env-test');
      expect(args).toContain('--ticket');
      expect(args).toContain('PROJ-1');
      expect(args).toContain('--branch');
      expect(args).toContain('feature/test');
      // Port env vars are no longer set at stack creation (on-demand proxy model)
      expect(env).not.toHaveProperty('SANDSTORM_PORT_app_0');
      expect(env).toHaveProperty('SANDSTORM_APP_VERSION');
    });

    it('calls onStackUpdate callback when build completes', async () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      const updateCallback = vi.fn();
      manager.setOnStackUpdate(updateCallback);

      manager.createStack({
        name: 'cb-test',
        projectDir: tmpDir,
        runtime: 'docker',
      });

      await vi.waitFor(() => {
        expect(updateCallback).toHaveBeenCalled();
      }, { timeout: 5000 });
    });
  });

  describe('dispatchTask', () => {
    it('dispatches a task via CLI to a stack', async () => {
      registry.createStack(makeStack('dispatch-test'));
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: 'Task dispatched.',
        stderr: '',
        exitCode: 0,
      });

      const result = await manager.dispatchTask('dispatch-test', 'Fix the bug');
      expect(result.status).toBe('running');
      expect(result.stack_id).toBe('dispatch-test');
      expect(typeof result.id).toBe('number');
      // Verify trimmed shape — prompt is NOT echoed in the MCP response (#255)
      expect(result).not.toHaveProperty('prompt');
      // The prompt is still persisted in the registry
      const persisted = registry.getTasksForStack('dispatch-test');
      expect(persisted[0].prompt).toBe('Fix the bug');

      // Should delegate to CLI `task` command (handles cred sync + user perms)
      // When no model is specified, the effective default (sonnet) is used
      expect(runCliSpy).toHaveBeenCalledWith(
        '/proj',
        ['task', 'dispatch-test', '--model', 'sonnet', 'Fix the bug']
      );
    });

    it('throws when dispatching to non-existent stack', async () => {
      await expect(
        manager.dispatchTask('nonexistent', 'task')
      ).rejects.toThrow('not found');
    });

    it('throws when CLI task dispatch fails', async () => {
      registry.createStack(makeStack('cli-fail'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: 'credential sync failed',
        exitCode: 1,
      });

      await expect(
        manager.dispatchTask('cli-fail', 'task')
      ).rejects.toThrow('credential sync failed');
    });

    it('throws when no agent container found', async () => {
      registry.createStack(makeStack('no-claude'));
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      await expect(
        manager.dispatchTask('no-claude', 'task')
      ).rejects.toThrow('Agent container not found');
    });

    it('passes model to CLI args when provided', async () => {
      registry.createStack(makeStack('model-test'));
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: 'Task dispatched.',
        stderr: '',
        exitCode: 0,
      });

      const result = await manager.dispatchTask('model-test', 'Complex task', 'opus');
      expect(result.status).toBe('running');
      // The model is persisted on the Task in the registry even though the MCP
      // response no longer echoes it.
      const persisted = registry.getTasksForStack('model-test');
      expect(persisted[0].model).toBe('opus');
      expect(runCliSpy).toHaveBeenCalledWith(
        '/proj',
        ['task', 'model-test', '--model', 'opus', 'Complex task']
      );
    });

    it('resolves "auto" model to undefined and omits from CLI args', async () => {
      registry.createStack(makeStack('auto-model'));
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: 'Task dispatched.',
        stderr: '',
        exitCode: 0,
      });

      const result = await manager.dispatchTask('auto-model', 'Simple task', 'auto');
      expect(result.status).toBe('running');
      // "auto" should resolve to null in the DB (undefined → null via registry)
      const persisted = registry.getTasksForStack('auto-model');
      expect(persisted[0].model).toBeNull();
      // CLI args should NOT contain --model
      expect(runCliSpy).toHaveBeenCalledWith(
        '/proj',
        ['task', 'auto-model', 'Simple task']
      );
    });

    it('uses effective default model when not provided', async () => {
      registry.createStack(makeStack('no-model'));
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: 'Task dispatched.',
        stderr: '',
        exitCode: 0,
      });

      const result = await manager.dispatchTask('no-model', 'Simple task');
      expect(result.status).toBe('running');
      // Effective default is 'sonnet' from global model settings — persisted
      // on the registry Task, not echoed in the MCP response.
      const persisted = registry.getTasksForStack('no-model');
      expect(persisted[0].model).toBe('sonnet');
      expect(runCliSpy).toHaveBeenCalledWith(
        '/proj',
        ['task', 'no-model', '--model', 'sonnet', 'Simple task']
      );
    });
  });

  describe('dispatchTask env-friction fixes (spec-gate resume exemption + container auto-start)', () => {
    function makeTicketStack(id: string, ticket = '250') {
      return {
        ...makeStack(id),
        ticket,
      };
    }

    it('enforces the spec gate on the FIRST dispatch when the stack has a ticket and no approval', async () => {
      registry.createStack(makeTicketStack('gate-first'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      await expect(
        manager.dispatchTask('gate-first', 'Continue work')
      ).rejects.toThrow(/gateApproved|spec.?check/i);
    });

    it('SKIPS the spec gate on subsequent dispatches when the stack has prior task history (resume)', async () => {
      registry.createStack(makeTicketStack('gate-resume'));
      // Seed a prior task → stack has been dispatched to before.
      registry.createTask('gate-resume', 'initial prompt', 'sonnet');

      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
      });

      // No gateApproved, no forceBypass — but should succeed because it's a resume.
      await expect(
        manager.dispatchTask('gate-resume', 'Continue from where you left off')
      ).resolves.toEqual(expect.objectContaining({ stack_id: 'gate-resume' }));

      // Verify we reached the CLI dispatch, i.e. we didn't bail early on the gate.
      expect(runCliSpy).toHaveBeenCalledWith(
        '/proj',
        expect.arrayContaining(['task', 'gate-resume'])
      );
    });

    it('still honors forceBypass on the first dispatch when gate is not approved', async () => {
      registry.createStack(makeTicketStack('gate-bypass'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      await expect(
        manager.dispatchTask('gate-bypass', 'New work', undefined, { forceBypass: true })
      ).resolves.toBeDefined();
    });

    it('starts the stack containers via the CLI when the claude container is not running at dispatch time', async () => {
      registry.createStack(makeStack('autostart'));

      // First listContainers call returns a STOPPED claude container. After
      // the auto-start runs, listContainers returns a running one.
      let call = 0;
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        call++;
        return [
          {
            id: 'claude-container-1',
            name: 'sandstorm-proj-autostart-claude-1',
            image: 'sandstorm-claude',
            status: call === 1 ? 'exited' : ('running' as const),
            state: call === 1 ? 'exited' : 'running',
            ports: [],
            labels: {},
            created: new Date().toISOString(),
          },
        ];
      });

      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      await manager.dispatchTask('autostart', 'resume');

      // The CLI should have been invoked to start the stack BEFORE the dispatch call.
      const startCall = runCliSpy.mock.calls.find(
        ([, args]) => Array.isArray(args) && args[0] === 'up'
      );
      expect(startCall).toBeDefined();
      expect(startCall![1]).toEqual(['up', 'autostart']);

      // Dispatch itself still runs after the start.
      const taskCall = runCliSpy.mock.calls.find(
        ([, args]) => Array.isArray(args) && args[0] === 'task'
      );
      expect(taskCall).toBeDefined();
    });

    it('does NOT run the start CLI when the claude container is already running', async () => {
      registry.createStack(makeStack('already-up'));
      // Default mock returns status: 'running' already.
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      await manager.dispatchTask('already-up', 'go');

      const startCall = runCliSpy.mock.calls.find(
        ([, args]) => Array.isArray(args) && args[0] === 'up'
      );
      expect(startCall).toBeUndefined();
    });

    it('surfaces a COMPOSE_FAILED error when the auto-start CLI call fails', async () => {
      registry.createStack(makeStack('autostart-fail'));
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'claude-container-1',
          name: 'sandstorm-proj-autostart-fail-claude-1',
          image: 'sandstorm-claude',
          status: 'exited' as const,
          state: 'exited',
          ports: [],
          labels: {},
          created: new Date().toISOString(),
        },
      ]);

      vi.spyOn(manager, 'runCli').mockImplementation(async (_dir, args) => {
        if (args[0] === 'up') {
          return { stdout: '', stderr: 'start failed: docker daemon unavailable', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      await expect(
        manager.dispatchTask('autostart-fail', 'resume')
      ).rejects.toThrow(/start failed|docker daemon/);
    });
  });

  describe('waitForClaudeReady', () => {
    it('resolves immediately when readiness file exists', async () => {
      registry.createStack(makeStack('ready-test'));
      // Default mock exec returns exitCode: 0, so test -f succeeds
      await expect(
        manager.waitForClaudeReady('claude-container-1', runtime, 5000, 100)
      ).resolves.toBeUndefined();
    });

    it('resolves when pgrep finds claude process (readiness file missing)', async () => {
      let callCount = 0;
      (runtime.exec as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: string, cmd: string[]) => {
          if (cmd.includes('test')) {
            // readiness file not found
            return { exitCode: 1, stdout: '', stderr: '' };
          }
          if (cmd.includes('pgrep')) {
            callCount++;
            if (callCount >= 2) {
              return { exitCode: 0, stdout: '1234', stderr: '' };
            }
            return { exitCode: 1, stdout: '', stderr: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        }
      );

      await expect(
        manager.waitForClaudeReady('claude-container-1', runtime, 5000, 50)
      ).resolves.toBeUndefined();
    });

    it('throws after timeout when container never becomes ready', async () => {
      (runtime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: '',
      });

      await expect(
        manager.waitForClaudeReady('claude-container-1', runtime, 200, 50)
      ).rejects.toThrow('not ready after');
    });

    it('handles exec failures gracefully during readiness check', async () => {
      let calls = 0;
      (runtime.exec as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        calls++;
        if (calls < 4) throw new Error('container not started');
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      await expect(
        manager.waitForClaudeReady('claude-container-1', runtime, 5000, 50)
      ).resolves.toBeUndefined();
    });
  });

  describe('dispatchTask with readiness', () => {
    it('waits for readiness before dispatching', async () => {
      registry.createStack(makeStack('ready-dispatch'));
      const waitSpy = vi.spyOn(manager, 'waitForClaudeReady').mockResolvedValue();
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: 'ok', stderr: '', exitCode: 0,
      });

      await manager.dispatchTask('ready-dispatch', 'do stuff');
      expect(waitSpy).toHaveBeenCalledWith('claude-container-1', runtime);
    });

    it('fails task when readiness check times out', async () => {
      registry.createStack(makeStack('ready-timeout'));
      vi.spyOn(manager, 'waitForClaudeReady').mockRejectedValue(
        new Error('not ready after 60s')
      );

      await expect(
        manager.dispatchTask('ready-timeout', 'do stuff')
      ).rejects.toThrow('not ready after 60s');

      // Task should be marked as failed
      const tasks = registry.getTasksForStack('ready-timeout');
      expect(tasks[0].status).toBe('failed');
    });
  });

  describe('buildStackInBackground task retry', () => {
    let tmpDir: string;

    beforeAll(() => {
      const result = spawnSync('git', ['--version'], { encoding: 'utf-8' });
      if (result.status !== 0) {
        throw new Error(
          'git binary not found on PATH. buildStackInBackground task retry tests require git to set up bare repos and clones.'
        );
      }
    });

    beforeEach(() => {
      const { execSync } = require('child_process');
      const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-bare-'));
      execSync('git init --bare', { cwd: bareDir, stdio: 'ignore' });
      tmpDir = path.join(os.tmpdir(), `sandstorm-proj-${Date.now()}`);
      execSync(`git clone "${bareDir}" "${tmpDir}"`, { stdio: 'ignore' });
      const sandstormDir = path.join(tmpDir, '.sandstorm');
      fs.mkdirSync(sandstormDir, { recursive: true });
      fs.writeFileSync(path.join(sandstormDir, 'config'), '# empty\n');
      execSync('git add -A && git commit -m "init" && git push origin HEAD', {
        cwd: tmpDir, stdio: 'ignore',
        env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
      });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('retries task dispatch once on failure then succeeds', async () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      let dispatchCalls = 0;
      vi.spyOn(manager, 'dispatchTask').mockImplementation(async () => {
        dispatchCalls++;
        if (dispatchCalls === 1) throw new Error('not ready');
        return { id: 1, stack_id: 'retry-test', status: 'running' };
      });

      manager.createStack({ name: 'retry-test', projectDir: tmpDir, runtime: 'docker', task: 'do work' });

      await vi.waitFor(() => {
        expect(dispatchCalls).toBe(2);
      }, { timeout: 20000 });

      // Stack should NOT be failed — retry succeeded
      const stack = registry.getStack('retry-test');
      expect(stack!.status).not.toBe('failed');
    }, 25000);

    it('marks stack as failed when task dispatch fails after retry', async () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      vi.spyOn(manager, 'dispatchTask').mockRejectedValue(new Error('container gone'));

      manager.createStack({ name: 'retry-fail', projectDir: tmpDir, runtime: 'docker', task: 'do work' });

      await vi.waitFor(() => {
        const stack = registry.getStack('retry-fail');
        expect(stack!.status).toBe('failed');
        expect(stack!.error).toContain('Task dispatch failed after retry');
      }, { timeout: 25000 });
    }, 30000);

    it('propagates forceBypass to internal dispatchTask call (regression #186)', async () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const dispatchSpy = vi.spyOn(manager, 'dispatchTask').mockResolvedValue({
        id: 1, stack_id: 'bypass-prop', status: 'running',
      });

      manager.createStack({
        name: 'bypass-prop',
        projectDir: tmpDir,
        runtime: 'docker',
        task: 'Fix issue #99',
        forceBypass: true,
      });

      await vi.waitFor(() => {
        expect(dispatchSpy).toHaveBeenCalled();
      }, { timeout: 5000 });

      const [, , , opts] = dispatchSpy.mock.calls[0];
      expect(opts?.forceBypass).toBe(true);
    });

    it('propagates gateApproved to internal dispatchTask call', async () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const dispatchSpy = vi.spyOn(manager, 'dispatchTask').mockResolvedValue({
        id: 1, stack_id: 'gate-prop', prompt: 'Fix issue #99', model: null,
        status: 'running', exit_code: null, warnings: null, started_at: '', finished_at: null,
      });

      manager.createStack({
        name: 'gate-prop',
        projectDir: tmpDir,
        runtime: 'docker',
        task: 'Fix issue #99',
        gateApproved: true,
      });

      await vi.waitFor(() => {
        expect(dispatchSpy).toHaveBeenCalled();
      }, { timeout: 5000 });

      const [, , , opts] = dispatchSpy.mock.calls[0];
      expect(opts?.gateApproved).toBe(true);
    });
  });

  describe('stopStack', () => {
    it('sets stack status to stopped', () => {
      registry.createStack(makeStack('stop-test'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      manager.stopStack('stop-test');
      const stack = registry.getStack('stop-test');
      expect(stack).toBeDefined();
      expect(stack!.status).toBe('stopped');
    });

    it('calls CLI stop in background', async () => {
      registry.createStack(makeStack('stop-bg'));
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '', stderr: '', exitCode: 0,
      });

      manager.stopStack('stop-bg');

      await vi.waitFor(() => {
        expect(runCliSpy).toHaveBeenCalledWith('/proj', ['stop', 'stop-bg']);
      }, { timeout: 5000 });
    });

    it('keeps stack in registry (not deleted)', () => {
      registry.createStack(makeStack('stop-keep'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      manager.stopStack('stop-keep');
      expect(registry.getStack('stop-keep')).toBeDefined();
    });

    it('throws when stopping non-existent stack', () => {
      expect(() => manager.stopStack('ghost')).toThrow('not found');
    });

    it('calls onStackUpdate callback', () => {
      const updateCallback = vi.fn();
      manager.setOnStackUpdate(updateCallback);
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      registry.createStack(makeStack('stop-cb'));
      manager.stopStack('stop-cb');
      expect(updateCallback).toHaveBeenCalled();
    });
  });

  describe('startStack', () => {
    it('sets stack status to building then up after CLI succeeds', async () => {
      registry.createStack(makeStack('start-test'));
      registry.updateStackStatus('start-test', 'stopped');
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      manager.startStack('start-test');
      // Immediately should be 'building'
      expect(registry.getStack('start-test')!.status).toBe('building');

      // After background completes, should be 'up'
      await vi.waitFor(() => {
        expect(registry.getStack('start-test')!.status).toBe('up');
      }, { timeout: 5000 });
    });

    it('calls CLI start in background', async () => {
      registry.createStack(makeStack('start-bg'));
      registry.updateStackStatus('start-bg', 'stopped');
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '', stderr: '', exitCode: 0,
      });

      manager.startStack('start-bg');

      await vi.waitFor(() => {
        expect(runCliSpy).toHaveBeenCalledWith('/proj', ['up', 'start-bg']);
      }, { timeout: 5000 });
    });

    it('marks stack as failed when CLI returns non-zero', async () => {
      registry.createStack(makeStack('start-fail'));
      registry.updateStackStatus('start-fail', 'stopped');
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '', stderr: 'containers not found', exitCode: 1,
      });

      manager.startStack('start-fail');

      await vi.waitFor(() => {
        const stack = registry.getStack('start-fail');
        expect(stack!.status).toBe('failed');
        expect(stack!.error).toBe('containers not found');
      }, { timeout: 5000 });
    });

    it('throws when starting non-existent stack', () => {
      expect(() => manager.startStack('ghost')).toThrow('not found');
    });
  });

  describe('teardownStack', () => {
    it('deletes stack from registry immediately', async () => {
      registry.createStack(makeStack('teardown-test'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      await manager.teardownStack('teardown-test');
      // Stack should be gone immediately (not just marked as stopped)
      expect(registry.getStack('teardown-test')).toBeUndefined();
    });

    it('calls CLI down in background for Docker cleanup', async () => {
      registry.createStack(makeStack('teardown-bg'));
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });

      await manager.teardownStack('teardown-bg');

      await vi.waitFor(() => {
        expect(runCliSpy).toHaveBeenCalledWith(
          '/proj',
          ['down', 'teardown-bg']
        );
      }, { timeout: 5000 });
    });

    it('throws when tearing down non-existent stack', async () => {
      await expect(manager.teardownStack('ghost')).rejects.toThrow('not found');
    });

    it('best-effort teardown even if CLI fails', async () => {
      registry.createStack(makeStack('compose-fail'));
      vi.spyOn(manager, 'runCli').mockRejectedValueOnce(new Error('cli error'));

      // Should not throw — best effort
      await manager.teardownStack('compose-fail');
      expect(registry.getStack('compose-fail')).toBeUndefined();
    });

    it('archives stack to history before deleting', async () => {
      registry.createStack(makeStack('archive-test'));
      registry.updateStackStatus('archive-test', 'completed');
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      await manager.teardownStack('archive-test');
      expect(registry.getStack('archive-test')).toBeUndefined();

      const history = registry.listStackHistory();
      expect(history).toHaveLength(1);
      expect(history[0].stack_id).toBe('archive-test');
      expect(history[0].final_status).toBe('completed');
    });

    it('archives failed stack with failed status', async () => {
      registry.createStack(makeStack('fail-archive'));
      registry.updateStackStatus('fail-archive', 'failed', 'build error');
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      await manager.teardownStack('fail-archive');

      const history = registry.listStackHistory();
      expect(history).toHaveLength(1);
      expect(history[0].final_status).toBe('failed');
      expect(history[0].error).toBe('build error');
    });

    it('archives running stack as torn_down', async () => {
      registry.createStack(makeStack('running-archive'));
      registry.updateStackStatus('running-archive', 'running');
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      await manager.teardownStack('running-archive');

      const history = registry.listStackHistory();
      expect(history).toHaveLength(1);
      expect(history[0].final_status).toBe('torn_down');
    });

    it('calls onStackUpdate callback during teardown', async () => {
      const updateCallback = vi.fn();
      manager.setOnStackUpdate(updateCallback);
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      registry.createStack(makeStack('cb-teardown'));
      await manager.teardownStack('cb-teardown');

      // Should be called when stack is deleted
      expect(updateCallback).toHaveBeenCalled();
    });
  });

  describe('getTasksForStack', () => {
    it('retrieves tasks for a stack', () => {
      registry.createStack(makeStack('task-test'));
      registry.createTask('task-test', 'Task 1');
      registry.createTask('task-test', 'Task 2');

      const tasks = manager.getTasksForStack('task-test');
      expect(tasks).toHaveLength(2);
    });

    it('returns empty array for stack with no tasks', () => {
      registry.createStack(makeStack('empty-tasks'));
      expect(manager.getTasksForStack('empty-tasks')).toEqual([]);
    });
  });

  describe('getDiff', () => {
    it('gets diff via CLI', async () => {
      registry.createStack(makeStack('diff-test'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: 'diff --git a/file.txt b/file.txt\n+new line',
        stderr: '',
        exitCode: 0,
      });

      const diff = await manager.getDiff('diff-test');
      expect(diff).toContain('+new line');
    });

    it('throws for non-existent stack', async () => {
      await expect(manager.getDiff('ghost')).rejects.toThrow('not found');
    });
  });

  describe('getStackWithServices', () => {
    it('returns stack with services', async () => {
      registry.createStack(makeStack('svc-test'));

      const result = await manager.getStackWithServices('svc-test');
      expect(result).toBeDefined();
      expect(result!.id).toBe('svc-test');
      expect(result!.services).toBeDefined();
      expect(Array.isArray(result!.services)).toBe(true);
    });

    it('returns undefined for non-existent stack', async () => {
      const result = await manager.getStackWithServices('ghost');
      expect(result).toBeUndefined();
    });
  });

  describe('listStacksWithServices', () => {
    it('returns all stacks with services', async () => {
      registry.createStack(makeStack('list-1'));
      registry.createStack(makeStack('list-2'));

      const results = await manager.listStacksWithServices();
      expect(results).toHaveLength(2);
      expect(results[0].services).toBeDefined();
    });

    it('returns empty array when no stacks', async () => {
      const results = await manager.listStacksWithServices();
      expect(results).toEqual([]);
    });
  });

  describe('listStackHistory', () => {
    it('returns history records', () => {
      registry.createStack(makeStack('hist-test'));
      registry.archiveStack('hist-test', 'completed');

      const history = manager.listStackHistory();
      expect(history).toHaveLength(1);
      expect(history[0].stack_id).toBe('hist-test');
    });

    it('returns empty array when no history', () => {
      expect(manager.listStackHistory()).toEqual([]);
    });
  });

  describe('push', () => {
    it('throws for non-existent stack', async () => {
      await expect(manager.push('ghost')).rejects.toThrow('not found');
    });

    it('calls CLI push with stack ID', async () => {
      registry.createStack(makeStack('push-test'));
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: 'Done!',
        stderr: '',
        exitCode: 0,
      });

      await manager.push('push-test', 'my commit message');

      expect(runCliSpy).toHaveBeenCalledWith(
        '/proj',
        ['push', 'push-test', 'my commit message']
      );
    });

    it('throws when CLI push fails', async () => {
      registry.createStack(makeStack('push-fail'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: 'push failed: no remote',
        exitCode: 1,
      });

      await expect(manager.push('push-fail')).rejects.toThrow('push failed: no remote');
    });

    it('sets stack status to pushed after successful push', async () => {
      registry.createStack(makeStack('push-status'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: 'Done!',
        stderr: '',
        exitCode: 0,
      });

      await manager.push('push-status');
      const stack = registry.getStack('push-status');
      expect(stack!.status).toBe('pushed');
    });

    it('calls onStackUpdate after successful push', async () => {
      registry.createStack(makeStack('push-notify'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      const updateCallback = vi.fn();
      manager.setOnStackUpdate(updateCallback);

      await manager.push('push-notify');
      expect(updateCallback).toHaveBeenCalled();
    });

    it('does not set pushed status when push fails', async () => {
      registry.createStack(makeStack('push-no-status'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '',
        stderr: 'push failed',
        exitCode: 1,
      });

      await expect(manager.push('push-no-status')).rejects.toThrow();
      const stack = registry.getStack('push-no-status');
      expect(stack!.status).toBe('up');
    });

    // #320 — Make-PR flow passes a refined title + body file through to
    // the unified create-pr.sh path inside the container.
    it('appends --pr-title and --pr-body-file after the message', async () => {
      registry.createStack(makeStack('push-pr-flags'));
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '', stderr: '', exitCode: 0,
      });

      await manager.push('push-pr-flags', 'feat: thing', {
        prTitle: 'feat: refined title',
        prBodyFile: '/app/.sandstorm/pr-body.md',
      });

      expect(runCliSpy).toHaveBeenCalledWith(
        '/proj',
        [
          'push', 'push-pr-flags', 'feat: thing',
          '--pr-title', 'feat: refined title',
          '--pr-body-file', '/app/.sandstorm/pr-body.md',
        ],
      );
    });

    it('synthesizes a default commit message so flags do not collide with positional args', async () => {
      registry.createStack(makeStack('push-default-msg'));
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '', stderr: '', exitCode: 0,
      });

      await manager.push('push-default-msg', undefined, { prTitle: 't' });

      // Message is always present positionally so the bash arg parser sees
      // the flags at position 4 (or later), not position 3.
      expect(runCliSpy).toHaveBeenCalledWith(
        '/proj',
        ['push', 'push-default-msg', 'Changes from Sandstorm stack push-default-msg', '--pr-title', 't'],
      );
    });

    it('returns stdout/stderr so callers can parse the PR URL emitted by create-pr.sh', async () => {
      registry.createStack(makeStack('push-stdout'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: 'pushed\nhttps://github.com/o/r/pull/77\nDone!\n',
        stderr: '',
        exitCode: 0,
      });

      const result = await manager.push('push-stdout', 't', { prTitle: 't' });
      expect(result.stdout).toContain('pull/77');
    });
  });

  describe('setPullRequest', () => {
    it('sets pr_created status and stores PR info', () => {
      registry.createStack(makeStack('pr-test'));
      registry.updateStackStatus('pr-test', 'pushed');

      manager.setPullRequest('pr-test', 'https://github.com/org/repo/pull/42', 42);

      const stack = registry.getStack('pr-test');
      expect(stack!.status).toBe('pr_created');
      expect(stack!.pr_url).toBe('https://github.com/org/repo/pull/42');
      expect(stack!.pr_number).toBe(42);
    });

    it('throws for non-existent stack', () => {
      expect(() => manager.setPullRequest('ghost', 'url', 1)).toThrow('not found');
    });

    it('calls onStackUpdate callback', () => {
      registry.createStack(makeStack('pr-notify'));
      const updateCallback = vi.fn();
      manager.setOnStackUpdate(updateCallback);

      manager.setPullRequest('pr-notify', 'https://github.com/org/repo/pull/1', 1);
      expect(updateCallback).toHaveBeenCalled();
    });
  });

  describe('no global rate limit gate', () => {
    it('does not block dispatch — each stack dispatches independently', async () => {
      registry.createStack(makeStack('no-gate'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: 'ok', stderr: '', exitCode: 0,
      });

      // Dispatch should succeed — no global rate limit gate exists
      const task = await manager.dispatchTask('no-gate', 'do work');
      expect(task.status).toBe('running');
    });

    it('does not listen for rate limit events from task watcher', () => {
      // The task watcher should have no listeners for rate_limited events
      expect(taskWatcher.listenerCount('task:rate_limited')).toBe(0);
      expect(taskWatcher.listenerCount('task:auth_required')).toBe(0);
      expect(taskWatcher.listenerCount('task:server_error')).toBe(0);
    });
  });

  describe('token usage', () => {
    it('getStackTokenUsage returns zeros for stack with no tokens', () => {
      registry.createStack(makeStack('token-test'));
      const usage = manager.getStackTokenUsage('token-test');
      expect(usage.input_tokens).toBe(0);
      expect(usage.output_tokens).toBe(0);
      expect(usage.total_tokens).toBe(0);
    });

    it('getGlobalTokenUsage aggregates across stacks', () => {
      registry.createStack(makeStack('tok-1'));
      registry.createStack(makeStack('tok-2'));

      // Create tasks and update tokens to populate aggregates
      const task1 = registry.createTask('tok-1', 'task 1');
      registry.updateTaskTokens(task1.id, 100, 50);
      const task2 = registry.createTask('tok-2', 'task 2');
      registry.updateTaskTokens(task2.id, 200, 100);

      const global = manager.getGlobalTokenUsage();
      expect(global.total_input_tokens).toBe(300);
      expect(global.total_output_tokens).toBe(150);
      expect(global.total_tokens).toBe(450);
      expect(global.per_stack).toHaveLength(2);
    });

    it('getGlobalTokenUsage groups per_project across multiple projects', () => {
      // Create stacks in two different projects
      registry.createStack({
        ...makeStack('proj-a-1'),
        project: 'alpha',
        project_dir: '/projects/alpha',
      });
      registry.createStack({
        ...makeStack('proj-a-2'),
        project: 'alpha',
        project_dir: '/projects/alpha',
      });
      registry.createStack({
        ...makeStack('proj-b-1'),
        project: 'beta',
        project_dir: '/projects/beta',
      });

      // Assign token usage via tasks
      const t1 = registry.createTask('proj-a-1', 'task a1');
      registry.updateTaskTokens(t1.id, 100, 50);
      const t2 = registry.createTask('proj-a-2', 'task a2');
      registry.updateTaskTokens(t2.id, 200, 80);
      const t3 = registry.createTask('proj-b-1', 'task b1');
      registry.updateTaskTokens(t3.id, 300, 120);

      const global = manager.getGlobalTokenUsage();

      // Total across all stacks
      expect(global.total_input_tokens).toBe(600);
      expect(global.total_output_tokens).toBe(250);
      expect(global.total_tokens).toBe(850);

      // Two distinct projects
      expect(global.per_project).toHaveLength(2);

      // Sorted by total_tokens descending: beta (420) > alpha (430)
      // alpha: 100+200 input, 50+80 output = 430 total
      // beta: 300 input, 120 output = 420 total
      const alpha = global.per_project.find(p => p.project === 'alpha');
      const beta = global.per_project.find(p => p.project === 'beta');

      expect(alpha).toBeDefined();
      expect(alpha!.input_tokens).toBe(300);
      expect(alpha!.output_tokens).toBe(130);
      expect(alpha!.total_tokens).toBe(430);
      expect(alpha!.project_dir).toBe('/projects/alpha');

      expect(beta).toBeDefined();
      expect(beta!.input_tokens).toBe(300);
      expect(beta!.output_tokens).toBe(120);
      expect(beta!.total_tokens).toBe(420);
      expect(beta!.project_dir).toBe('/projects/beta');
    });

    it('getGlobalTokenUsage omits projects with zero tokens from per_project', () => {
      registry.createStack({
        ...makeStack('zero-tok'),
        project: 'empty-proj',
        project_dir: '/projects/empty',
      });
      registry.createStack(makeStack('has-tok'));
      const t = registry.createTask('has-tok', 'work');
      registry.updateTaskTokens(t.id, 50, 25);

      const global = manager.getGlobalTokenUsage();
      // Only the project with tokens should appear
      expect(global.per_project).toHaveLength(1);
      expect(global.per_project[0].project).toBe('proj');
    });
  });

  describe('getTaskStatus', () => {
    it('returns running status with task metadata when a task is running', () => {
      registry.createStack(makeStack('status-test'));
      const task = registry.createTask('status-test', 'do work');

      const result = manager.getTaskStatus('status-test');
      expect(result.status).toBe('running');
      expect(result.id).toBe(task.id);
      expect(typeof result.started_at).toBe('string');
      // Trimmed response does NOT echo the prompt back to outer Claude (#255)
      expect(result).not.toHaveProperty('prompt');
      expect(result).not.toHaveProperty('task');
    });

    it('returns latest completed task status when no running task', () => {
      registry.createStack(makeStack('status-done'));
      const task = registry.createTask('status-done', 'done work');
      registry.completeTask(task.id, 0);

      const result = manager.getTaskStatus('status-done');
      expect(result.status).toBe('completed');
      expect(result.id).toBe(task.id);
      expect(result.exit_code).toBe(0);
      expect(result).not.toHaveProperty('prompt');
    });

    it('returns idle when stack has no tasks', () => {
      registry.createStack(makeStack('status-idle'));

      const result = manager.getTaskStatus('status-idle');
      expect(result.status).toBe('idle');
      expect(result.id).toBeUndefined();
      expect(result).not.toHaveProperty('prompt');
    });

    it('throws for non-existent stack', () => {
      expect(() => manager.getTaskStatus('ghost')).toThrow('not found');
    });
  });

  describe('getTaskOutput', () => {
    it('returns task log output from container', async () => {
      registry.createStack(makeStack('output-test'));
      (runtime.exec as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: string, cmd: string[]) => {
          if (cmd.includes('/tmp/claude-task.log')) {
            return { exitCode: 0, stdout: 'line 1\nline 2\nline 3', stderr: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        }
      );

      const output = await manager.getTaskOutput('output-test');
      expect(output).toBe('line 1\nline 2\nline 3');
    });

    it('passes line count to tail command', async () => {
      registry.createStack(makeStack('output-lines'));
      const execSpy = (runtime.exec as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: string, cmd: string[]) => {
          if (cmd.includes('/tmp/claude-task.log')) {
            return { exitCode: 0, stdout: 'output', stderr: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        }
      );

      await manager.getTaskOutput('output-lines', 100);

      const tailCall = execSpy.mock.calls.find(
        (c: unknown[]) => Array.isArray(c[1]) && c[1].includes('/tmp/claude-task.log')
      );
      expect(tailCall).toBeDefined();
      expect(tailCall![1]).toContain('100');
    });

    it('returns fallback message when exec fails', async () => {
      registry.createStack(makeStack('output-fail'));
      (runtime.exec as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: string, cmd: string[]) => {
          if (cmd.includes('/tmp/claude-task.log')) {
            throw new Error('container stopped');
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        }
      );

      const output = await manager.getTaskOutput('output-fail');
      expect(output).toBe('(no task output available)');
    });

    it('throws when no agent container found', async () => {
      registry.createStack(makeStack('output-no-claude'));
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      await expect(manager.getTaskOutput('output-no-claude')).rejects.toThrow(
        'Agent container not found'
      );
    });

    it('throws for non-existent stack', async () => {
      await expect(manager.getTaskOutput('ghost')).rejects.toThrow('not found');
    });

    it('caps output at TASK_OUTPUT_MAX_BYTES with a truncation marker (#255)', async () => {
      registry.createStack(makeStack('output-huge'));
      const huge = 'x'.repeat(TASK_OUTPUT_MAX_BYTES * 3); // 12 KB
      (runtime.exec as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: string, cmd: string[]) => {
          if (cmd.includes('/tmp/claude-task.log')) {
            return { exitCode: 0, stdout: huge, stderr: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        }
      );

      const output = await manager.getTaskOutput('output-huge');
      expect(output).toContain('...[truncated');
      // Marker adds a bit of overhead, but total is bounded
      expect(Buffer.byteLength(output, 'utf8')).toBeLessThan(TASK_OUTPUT_MAX_BYTES + 100);
    });
  });

  describe('getLogs', () => {
    it('returns logs from all containers in a stack', async () => {
      registry.createStack(makeStack('logs-test'));
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 'c1', name: 'sandstorm-proj-logs-test-claude-1',
          image: 'img', status: 'running', state: 'running', ports: [], labels: {}, created: '',
        },
        {
          id: 'c2', name: 'sandstorm-proj-logs-test-api-1',
          image: 'img', status: 'running', state: 'running', ports: [], labels: {}, created: '',
        },
      ]);
      (runtime.logs as ReturnType<typeof vi.fn>).mockImplementation(async function* (_id: string) {
        yield `logs from ${_id}\n`;
      });

      const logs = await manager.getLogs('logs-test');
      expect(logs).toContain('=== claude ===');
      expect(logs).toContain('=== api ===');
      expect(logs).toContain('logs from c1');
      expect(logs).toContain('logs from c2');
    });

    it('filters by service name when provided', async () => {
      registry.createStack(makeStack('logs-svc'));
      const listSpy = (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 'c1', name: 'sandstorm-proj-logs-svc-claude-1',
          image: 'img', status: 'running', state: 'running', ports: [], labels: {}, created: '',
        },
      ]);
      (runtime.logs as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
        yield 'data\n';
      });

      await manager.getLogs('logs-svc', 'claude');

      // Should filter by service name in the container name filter
      const filterArg = listSpy.mock.calls[0][0];
      expect(filterArg.name).toBe('sandstorm-proj-logs-svc-claude');
    });

    it('throws when no containers found', async () => {
      registry.createStack(makeStack('logs-empty'));
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      await expect(manager.getLogs('logs-empty')).rejects.toThrow('No containers found');
    });

    it('throws for non-existent stack', async () => {
      await expect(manager.getLogs('ghost')).rejects.toThrow('not found');
    });

    it('caps per-container output at LOGS_PER_CONTAINER_MAX_BYTES (#255)', async () => {
      registry.createStack(makeStack('logs-huge'));
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 'c1', name: 'sandstorm-proj-logs-huge-claude-1',
          image: 'img', status: 'running', state: 'running', ports: [], labels: {}, created: '',
        },
      ]);
      const bigChunk = 'y'.repeat(LOGS_PER_CONTAINER_MAX_BYTES * 3); // 24 KB from the container
      (runtime.logs as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
        yield bigChunk;
      });

      const logs = await manager.getLogs('logs-huge');
      expect(logs).toContain('=== claude ===');
      expect(logs).toContain('...[truncated');
      // Overall result is bounded: header + per-container cap + marker, still < 32 KB.
      expect(Buffer.byteLength(logs, 'utf8')).toBeLessThan(LOGS_TOTAL_MAX_BYTES + 200);
    });

    it('caps total size across many containers at LOGS_TOTAL_MAX_BYTES (#255)', async () => {
      registry.createStack(makeStack('logs-many'));
      // Eight containers, each producing exactly the per-container cap after trimming.
      const containers = Array.from({ length: 8 }).map((_, i) => ({
        id: `c${i}`, name: `sandstorm-proj-logs-many-svc${i}-1`,
        image: 'img', status: 'running', state: 'running', ports: [], labels: {}, created: '',
      }));
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValueOnce(containers);
      const bigChunk = 'z'.repeat(LOGS_PER_CONTAINER_MAX_BYTES);
      (runtime.logs as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
        yield bigChunk;
      });

      const logs = await manager.getLogs('logs-many');
      // 8 × 8 KB per-container = 64 KB of raw content; must be capped below 32 KB + overhead.
      expect(Buffer.byteLength(logs, 'utf8')).toBeLessThan(LOGS_TOTAL_MAX_BYTES + 200);
      expect(logs).toContain('...[truncated');
    });
  });

  describe('getStackDetailedStats', () => {
    it('returns stats for running containers', async () => {
      registry.createStack(makeStack('stats-test'));
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 'c1', name: 'sandstorm-proj-stats-test-claude-1',
          image: 'img', status: 'running', state: 'running', ports: [], labels: {}, created: '',
        },
        {
          id: 'c2', name: 'sandstorm-proj-stats-test-api-1',
          image: 'img', status: 'running', state: 'running', ports: [], labels: {}, created: '',
        },
      ]);
      (runtime as any).containerStats = vi.fn().mockImplementation(async (id: string) => ({
        memoryUsage: id === 'c1' ? 100_000_000 : 50_000_000,
        memoryLimit: 500_000_000,
        cpuPercent: 25,
      }));

      const stats = await manager.getStackDetailedStats('stats-test');
      expect(stats.stackId).toBe('stats-test');
      expect(stats.totalMemory).toBe(150_000_000);
      expect(stats.containers).toHaveLength(2);
      expect(stats.containers[0].name).toBe('claude');
      expect(stats.containers[0].memoryUsage).toBe(100_000_000);
      expect(stats.containers[1].name).toBe('api');
    });

    it('skips non-running containers', async () => {
      registry.createStack(makeStack('stats-skip'));
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 'c1', name: 'sandstorm-proj-stats-skip-claude-1',
          image: 'img', status: 'exited', state: 'exited', ports: [], labels: {}, created: '',
        },
      ]);

      const stats = await manager.getStackDetailedStats('stats-skip');
      expect(stats.containers).toHaveLength(0);
      expect(stats.totalMemory).toBe(0);
    });

    it('returns empty stats for non-existent stack', async () => {
      const stats = await manager.getStackDetailedStats('ghost');
      expect(stats.totalMemory).toBe(0);
      expect(stats.containers).toEqual([]);
    });

    it('handles containerStats failure gracefully', async () => {
      registry.createStack(makeStack('stats-err'));
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 'c1', name: 'sandstorm-proj-stats-err-claude-1',
          image: 'img', status: 'running', state: 'running', ports: [], labels: {}, created: '',
        },
      ]);
      (runtime as any).containerStats = vi.fn().mockRejectedValue(new Error('stats unavailable'));

      const stats = await manager.getStackDetailedStats('stats-err');
      // Should not throw, just skip the container
      expect(stats.containers).toHaveLength(0);
      expect(stats.totalMemory).toBe(0);
    });
  });

  describe('getStackMemoryUsage', () => {
    it('returns total memory from detailed stats', async () => {
      registry.createStack(makeStack('mem-test'));
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 'c1', name: 'sandstorm-proj-mem-test-claude-1',
          image: 'img', status: 'running', state: 'running', ports: [], labels: {}, created: '',
        },
      ]);
      (runtime as any).containerStats = vi.fn().mockResolvedValue({
        memoryUsage: 200_000_000,
        memoryLimit: 500_000_000,
        cpuPercent: 10,
      });

      const mem = await manager.getStackMemoryUsage('mem-test');
      expect(mem).toBe(200_000_000);
    });
  });

  describe('getStackTaskMetrics', () => {
    it('returns correct metrics for mixed task states', () => {
      registry.createStack(makeStack('metrics-test'));

      // Create tasks with various states
      const t1 = registry.createTask('metrics-test', 'task 1');
      registry.completeTask(t1.id, 0); // completed

      const t2 = registry.createTask('metrics-test', 'task 2');
      registry.completeTask(t2.id, 1); // failed

      registry.createTask('metrics-test', 'task 3'); // running

      const metrics = manager.getStackTaskMetrics('metrics-test');
      expect(metrics.stackId).toBe('metrics-test');
      expect(metrics.totalTasks).toBe(3);
      expect(metrics.completedTasks).toBe(1);
      expect(metrics.failedTasks).toBe(1);
      expect(metrics.runningTasks).toBe(1);
    });

    it('calculates average duration for completed tasks', () => {
      registry.createStack(makeStack('metrics-dur'));

      // We need tasks with finished_at to calculate duration
      const t1 = registry.createTask('metrics-dur', 'task 1');
      registry.completeTask(t1.id, 0);
      const t2 = registry.createTask('metrics-dur', 'task 2');
      registry.completeTask(t2.id, 0);

      const metrics = manager.getStackTaskMetrics('metrics-dur');
      expect(metrics.completedTasks).toBe(2);
      // Duration should be calculated (both tasks completed very quickly in tests)
      expect(metrics.avgTaskDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns zero metrics for stack with no tasks', () => {
      registry.createStack(makeStack('metrics-empty'));

      const metrics = manager.getStackTaskMetrics('metrics-empty');
      expect(metrics.totalTasks).toBe(0);
      expect(metrics.completedTasks).toBe(0);
      expect(metrics.failedTasks).toBe(0);
      expect(metrics.runningTasks).toBe(0);
      expect(metrics.avgTaskDurationMs).toBe(0);
    });
  });

  describe('getServices and findClaudeContainer', () => {
    it('getStackWithServices maps containers to service info', async () => {
      registry.createStack(makeStack('svc-map'));
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'c1', name: 'sandstorm-proj-svc-map-claude-1',
          image: 'img', status: 'running', state: 'running', ports: [], labels: {}, created: '',
        },
        {
          id: 'c2', name: 'sandstorm-proj-svc-map-api-1',
          image: 'img', status: 'running', state: 'running', ports: [], labels: {}, created: '',
        },
      ]);

      const result = await manager.getStackWithServices('svc-map');
      expect(result!.services).toHaveLength(2);
      expect(result!.services.map(s => s.name).sort()).toEqual(['api', 'claude']);
      expect(result!.services[0].containerId).toBeDefined();
    });

    it('findClaudeContainer is used by dispatchTask', async () => {
      registry.createStack(makeStack('find-claude'));
      // Return a container matching the claude naming convention
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockImplementation(
        async (filter?: { name?: string }) => {
          if (filter?.name?.includes('claude')) {
            return [{
              id: 'claude-abc', name: 'sandstorm-proj-find-claude-claude-1',
              image: 'img', status: 'running', state: 'running', ports: [], labels: {}, created: '',
            }];
          }
          return [];
        }
      );
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      const task = await manager.dispatchTask('find-claude', 'do work');
      expect(task).toBeDefined();

      // Verify listContainers was called with claude filter
      const listCalls = (runtime.listContainers as ReturnType<typeof vi.fn>).mock.calls;
      const claudeFilter = listCalls.find(
        (c: unknown[]) => typeof c[0] === 'object' && (c[0] as any).name?.includes('claude')
      );
      expect(claudeFilter).toBeDefined();
    });

    it('uses raw stack ID for container lookup when ID starts with a digit', async () => {
      // Regression test: stack IDs starting with a digit (e.g. "36-solid-queue")
      // must NOT get an "s" prefix when constructing the compose project name.
      // The CLI creates containers without the prefix, so adding one causes
      // a naming mismatch that prevents container discovery.
      registry.createStack({ ...makeStack('36-solid-queue') });

      const capturedFilters: string[] = [];
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockImplementation(
        async (filter?: { name?: string }) => {
          if (filter?.name) capturedFilters.push(filter.name);
          if (filter?.name?.includes('claude')) {
            return [{
              id: 'claude-digit', name: 'sandstorm-proj-36-solid-queue-claude-1',
              image: 'img', status: 'running', state: 'running', ports: [], labels: {}, created: '',
            }];
          }
          return [];
        }
      );
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });

      await manager.dispatchTask('36-solid-queue', 'do work');

      const claudeFilter = capturedFilters.find(n => n.includes('claude'));
      expect(claudeFilter).toBeDefined();
      // Must NOT contain the "s" prefix — container names match what the CLI creates
      expect(claudeFilter).toContain('sandstorm-proj-36-solid-queue-claude');
      expect(claudeFilter).not.toContain('s36-solid-queue');
    });

    it('returns empty services when no containers found', async () => {
      registry.createStack(makeStack('svc-empty'));
      (runtime.listContainers as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await manager.getStackWithServices('svc-empty');
      expect(result!.services).toEqual([]);
    });
  });

  describe('getRateLimitState', () => {
    function makeRateLimitedStack(id: string, reset_at: string | null, error: string | null) {
      return {
        ...makeStack(id),
        status: 'rate_limited' as const,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_execution_input_tokens: 0,
        total_execution_output_tokens: 0,
        total_review_input_tokens: 0,
        total_review_output_tokens: 0,
        rate_limit_reset_at: reset_at,
        error,
        pr_url: null,
        pr_number: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    }

    it('returns inactive state when no stacks are rate limited', () => {
      vi.spyOn(registry, 'listStacks').mockReturnValue([]);

      const state = manager.getRateLimitState();
      expect(state.active).toBe(false);
      expect(state.reset_at).toBeNull();
      expect(state.affected_stacks).toEqual([]);
      expect(state.reason).toBeNull();
    });

    it('returns active state with reset_at when one stack is rate limited', () => {
      const resetTime = '2026-03-27T20:00:00.000Z';
      vi.spyOn(registry, 'listStacks').mockReturnValue([
        makeRateLimitedStack('rl-1', resetTime, 'Rate limit exceeded'),
      ]);

      const state = manager.getRateLimitState();
      expect(state.active).toBe(true);
      expect(state.reset_at).toBe(resetTime);
      expect(state.affected_stacks).toEqual(['rl-1']);
      expect(state.reason).toBe('Rate limit exceeded');
    });

    it('picks the latest reset_at when multiple stacks are rate limited', () => {
      const earlier = '2026-03-27T19:00:00.000Z';
      const later   = '2026-03-27T21:00:00.000Z';
      vi.spyOn(registry, 'listStacks').mockReturnValue([
        makeRateLimitedStack('rl-a', earlier, 'first error'),
        makeRateLimitedStack('rl-b', later, 'second error'),
      ]);

      const state = manager.getRateLimitState();
      expect(state.active).toBe(true);
      expect(state.reset_at).toBe(later);
      expect(state.affected_stacks).toEqual(expect.arrayContaining(['rl-a', 'rl-b']));
    });

    it('uses the first rate-limited stack error as the reason', () => {
      vi.spyOn(registry, 'listStacks').mockReturnValue([
        makeRateLimitedStack('rl-first', '2026-03-27T20:00:00.000Z', 'first error'),
        makeRateLimitedStack('rl-second', '2026-03-27T20:30:00.000Z', 'second error'),
      ]);

      const state = manager.getRateLimitState();
      expect(state.reason).toBe('first error');
    });

    it('returns null reset_at when rate-limited stacks have no reset time', () => {
      vi.spyOn(registry, 'listStacks').mockReturnValue([
        makeRateLimitedStack('rl-no-time', null, 'some reason'),
      ]);

      const state = manager.getRateLimitState();
      expect(state.active).toBe(true);
      expect(state.reset_at).toBeNull();
    });

    it('returns null reason when rate-limited stacks have no error', () => {
      vi.spyOn(registry, 'listStacks').mockReturnValue([
        makeRateLimitedStack('rl-no-err', '2026-03-27T20:00:00.000Z', null),
      ]);

      const state = manager.getRateLimitState();
      expect(state.active).toBe(true);
      expect(state.reason).toBeNull();
    });

    it('ignores non-rate-limited stacks', () => {
      vi.spyOn(registry, 'listStacks').mockReturnValue([
        { ...makeStack('up-stack'), total_input_tokens: 0, total_output_tokens: 0, total_execution_input_tokens: 0, total_execution_output_tokens: 0, total_review_input_tokens: 0, total_review_output_tokens: 0, rate_limit_reset_at: null, pr_url: null, pr_number: null, created_at: '', updated_at: '' },
        makeRateLimitedStack('rl-only', '2026-03-27T20:00:00.000Z', null),
      ]);

      const state = manager.getRateLimitState();
      expect(state.active).toBe(true);
      expect(state.affected_stacks).toEqual(['rl-only']);
    });
  });

  describe('resumeStackWithContinuation', () => {
    it('Case A: dispatches with --resume flag when running task has session_id', async () => {
      registry.createStack(makeStack('resume-a'));
      const task = registry.createTask('resume-a', 'do work', 'sonnet');
      registry.setTaskSessionId(task.id, 'sess-abc123');
      // Must set session_paused AFTER createTask — createTask calls updateStackStatus('running')
      registry.updateStackStatus('resume-a', 'session_paused');

      vi.spyOn(manager, 'waitForClaudeReady').mockResolvedValue(undefined);
      vi.spyOn(taskWatcher, 'watch').mockImplementation(() => {});
      vi.spyOn(taskWatcher, 'streamOutput').mockResolvedValue(undefined);
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '', stderr: '', exitCode: 0,
      });

      const result = await manager.resumeStackWithContinuation('resume-a');
      expect(result.outcome).toBe('resuming_with_session');

      // CLI should include --resume and the session ID
      const resumeCall = runCliSpy.mock.calls.find(
        ([, args]) => Array.isArray(args) && args.includes('--resume')
      );
      expect(resumeCall).toBeDefined();
      expect(resumeCall![1]).toContain('sess-abc123');

      // resumed_at should be stamped on the task
      const tasks = registry.getTasksForStack('resume-a');
      expect(tasks[0].resumed_at).toBeTruthy();

      expect(registry.getStack('resume-a')!.status).toBe('running');
    });

    it('Case B: interrupts old task and redispatches fresh when session_id is null', async () => {
      registry.createStack(makeStack('resume-b'));
      const task = registry.createTask('resume-b', 'original prompt', 'sonnet');
      // session_id is null by default; set session_paused after createTask
      registry.updateStackStatus('resume-b', 'session_paused');

      vi.spyOn(manager, 'waitForClaudeReady').mockResolvedValue(undefined);
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '', stderr: '', exitCode: 0,
      });

      const result = await manager.resumeStackWithContinuation('resume-b');
      expect(result.outcome).toBe('resumed_fresh');

      // Old task must be interrupted
      const allTasks = registry.getTasksForStack('resume-b');
      const oldTask = allTasks.find(t => t.id === task.id);
      expect(oldTask!.status).toBe('interrupted');

      // A new task was created for the fresh dispatch
      expect(allTasks.length).toBeGreaterThan(1);

      // CLI task call must NOT carry --resume
      const taskCall = runCliSpy.mock.calls.find(
        ([, args]) => Array.isArray(args) && args[0] === 'task'
      );
      expect(taskCall).toBeDefined();
      expect(taskCall![1]).not.toContain('--resume');
    });

    it('Case C: marks stack idle when no running task exists', async () => {
      registry.createStack(makeStack('resume-c'));
      // Stack has no tasks; set session_paused directly
      registry.updateStackStatus('resume-c', 'session_paused');

      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const result = await manager.resumeStackWithContinuation('resume-c');
      expect(result.outcome).toBe('idle');
      expect(registry.getStack('resume-c')!.status).toBe('idle');
    });

    it('returns idle immediately and skips CLI when stack is not session_paused', async () => {
      registry.createStack(makeStack('resume-up'));
      // default status is 'up'

      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '', stderr: '', exitCode: 0,
      });

      const result = await manager.resumeStackWithContinuation('resume-up');
      expect(result.outcome).toBe('idle');
      expect(runCliSpy).not.toHaveBeenCalled();
      expect(registry.getStack('resume-up')!.status).toBe('up');
    });

    it('Pre-flight: throws without touching containers when isHalted returns true', async () => {
      registry.createStack(makeStack('resume-halted'));
      registry.updateStackStatus('resume-halted', 'session_paused');

      const runCliSpy = vi.spyOn(manager, 'runCli');

      await expect(
        manager.resumeStackWithContinuation('resume-halted', () => true)
      ).rejects.toThrow('Session token limit has not refreshed yet');

      expect(runCliSpy).not.toHaveBeenCalled();
      expect(registry.getStack('resume-halted')!.status).toBe('session_paused');
    });

    it('reverts to session_paused when container start fails', async () => {
      registry.createStack(makeStack('resume-fail'));
      registry.updateStackStatus('resume-fail', 'session_paused');

      vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: '', stderr: 'docker daemon unavailable', exitCode: 1,
      });

      await expect(
        manager.resumeStackWithContinuation('resume-fail')
      ).rejects.toThrow();

      expect(registry.getStack('resume-fail')!.status).toBe('session_paused');
    });
  });

  describe('getRuntimeForStack (per-stack runtime resolution)', () => {
    it('returns docker runtime for stacks with runtime=docker', () => {
      const dockerRt = createMockRuntime();
      dockerRt.name = 'docker';
      const podmanRt = createMockRuntime();
      podmanRt.name = 'podman';

      const mgr = new StackManager(registry, portAllocator, taskWatcher, dockerRt, podmanRt, '/fake/cli');

      registry.createStack({
        id: 'docker-stack',
        project: 'proj',
        project_dir: '/proj',
        ticket: null,
        branch: null,
        description: null,
        status: 'up',
        runtime: 'docker',
      });

      const stack = registry.getStack('docker-stack')!;
      const resolved = mgr.getRuntimeForStack(stack);
      expect(resolved.name).toBe('docker');
    });

    it('returns podman runtime for stacks with runtime=podman', () => {
      const dockerRt = createMockRuntime();
      dockerRt.name = 'docker';
      const podmanRt = createMockRuntime();
      podmanRt.name = 'podman';

      const mgr = new StackManager(registry, portAllocator, taskWatcher, dockerRt, podmanRt, '/fake/cli');

      registry.createStack({
        id: 'podman-stack',
        project: 'proj',
        project_dir: '/proj',
        ticket: null,
        branch: null,
        description: null,
        status: 'up',
        runtime: 'podman',
      });

      const stack = registry.getStack('podman-stack')!;
      const resolved = mgr.getRuntimeForStack(stack);
      expect(resolved.name).toBe('podman');
    });

    it('uses per-stack runtime for getLogs instead of global default', async () => {
      const dockerRt = createMockRuntime();
      dockerRt.name = 'docker';
      const podmanRt = createMockRuntime();
      podmanRt.name = 'podman';

      const mgr = new StackManager(registry, portAllocator, taskWatcher, dockerRt, podmanRt, '/fake/cli');

      registry.createStack({
        id: 'logs-stack',
        project: 'proj',
        project_dir: '/proj',
        ticket: null,
        branch: null,
        description: null,
        status: 'up',
        runtime: 'docker',
      });

      // Docker runtime returns containers; podman should never be called
      (dockerRt.listContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'c1',
          name: 'sandstorm-proj-logs-stack-app-1',
          image: 'app',
          status: 'running' as const,
          state: 'running',
          ports: [],
          labels: {},
          created: new Date().toISOString(),
        },
      ]);
      (dockerRt.logs as ReturnType<typeof vi.fn>).mockReturnValue(
        (async function* () { yield 'log line'; })()
      );

      await mgr.getLogs('logs-stack');

      expect(dockerRt.listContainers).toHaveBeenCalled();
      expect(podmanRt.listContainers).not.toHaveBeenCalled();
    });

    it('uses per-stack runtime for getTaskOutput instead of global default', async () => {
      const dockerRt = createMockRuntime();
      dockerRt.name = 'docker';
      const podmanRt = createMockRuntime();
      podmanRt.name = 'podman';

      const mgr = new StackManager(registry, portAllocator, taskWatcher, dockerRt, podmanRt, '/fake/cli');

      registry.createStack({
        id: 'output-stack',
        project: 'proj',
        project_dir: '/proj',
        ticket: null,
        branch: null,
        description: null,
        status: 'up',
        runtime: 'docker',
      });

      // findClaudeContainer needs to return a container
      (dockerRt.listContainers as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'claude-1',
          name: 'sandstorm-proj-output-stack-claude-1',
          image: 'claude',
          status: 'running' as const,
          state: 'running',
          ports: [],
          labels: {},
          created: new Date().toISOString(),
        },
      ]);
      (dockerRt.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        exitCode: 0,
        stdout: 'task output',
        stderr: '',
      });

      const output = await mgr.getTaskOutput('output-stack');

      expect(output).toBe('task output');
      expect(dockerRt.exec).toHaveBeenCalled();
      expect(podmanRt.exec).not.toHaveBeenCalled();
      expect(podmanRt.listContainers).not.toHaveBeenCalled();
    });
  });

});

describe('referencesGitHubIssue', () => {
  it('detects standalone issue references like #123', () => {
    expect(referencesGitHubIssue('Fix #123')).toBe(true);
    expect(referencesGitHubIssue('#42 needs work')).toBe(true);
    expect(referencesGitHubIssue('See issue #99 for details')).toBe(true);
  });

  it('detects owner/repo#123 references', () => {
    expect(referencesGitHubIssue('See onomojo/sandstorm#27')).toBe(true);
  });

  it('detects GitHub issue URLs', () => {
    expect(referencesGitHubIssue('https://github.com/onomojo/sandstorm/issues/27')).toBe(true);
  });

  it('returns false for plain text without issue references', () => {
    expect(referencesGitHubIssue('Fix the auth bug')).toBe(false);
    expect(referencesGitHubIssue('Refactor the login flow')).toBe(false);
  });

  it('returns false for hash in non-issue contexts', () => {
    expect(referencesGitHubIssue('color: #fff')).toBe(false);
  });
});

describe('spec quality gate enforcement', () => {
  let registry: Registry;
  let portAllocator: PortAllocator;
  let taskWatcher: TaskWatcher;
  let runtime: ContainerRuntime;
  let manager: StackManager;
  let dbPath: string;
  let tmpDir: string;

  beforeAll(() => {
    const result = spawnSync('git', ['--version'], { encoding: 'utf-8' });
    if (result.status !== 0) {
      throw new Error(
        'git binary not found on PATH. spec quality gate enforcement tests require git to set up bare repos and clones.'
      );
    }
  });

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    runtime = createMockRuntime();
    portAllocator = new PortAllocator(registry, [40000, 40099]);
    taskWatcher = new TaskWatcher(registry, runtime, runtime, { pollInterval: 100 });
    manager = new StackManager(registry, portAllocator, taskWatcher, runtime, runtime, '/fake/cli');

    // Create a temp project dir with sandstorm config
    const { execSync } = require('child_process');
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-bare-'));
    execSync('git init --bare', { cwd: bareDir, stdio: 'ignore' });
    tmpDir = path.join(os.tmpdir(), `sandstorm-gate-${Date.now()}`);
    execSync(`git clone "${bareDir}" "${tmpDir}"`, { stdio: 'ignore' });
    const sandstormDir = path.join(tmpDir, '.sandstorm');
    fs.mkdirSync(sandstormDir, { recursive: true });
    fs.writeFileSync(path.join(sandstormDir, 'config'), '# no ports\n');
    execSync('git add -A && git commit -m "init" && git push origin HEAD', {
      cwd: tmpDir,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
    });
  });

  afterEach(() => {
    taskWatcher.unwatchAll();
    registry.close();
    cleanupDb(dbPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createStack gate enforcement', () => {
    it('throws GATE_CHECK_REQUIRED when ticket is set and gateApproved is not', () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      expect(() =>
        manager.createStack({
          name: 'gate-ticket',
          projectDir: tmpDir,
          ticket: '123',
          runtime: 'docker',
        })
      ).toThrow('gateApproved was not set');
    });

    it('proceeds when ticket is set and gateApproved is true', () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const stack = manager.createStack({
        name: 'gate-approved',
        projectDir: tmpDir,
        ticket: '123',
        gateApproved: true,
        runtime: 'docker',
      });

      expect(stack).toBeDefined();
      expect(stack.id).toBe('gate-approved');
    });

    it('proceeds when ticket is set and forceBypass is true', () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const stack = manager.createStack({
        name: 'gate-bypass',
        projectDir: tmpDir,
        ticket: '123',
        forceBypass: true,
        runtime: 'docker',
      });

      expect(stack).toBeDefined();
      expect(stack.id).toBe('gate-bypass');
    });

    it('proceeds without gate check for ad-hoc prompts (no ticket, no issue reference)', () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const stack = manager.createStack({
        name: 'adhoc-test',
        projectDir: tmpDir,
        task: 'Refactor the login flow',
        runtime: 'docker',
      });

      expect(stack).toBeDefined();
      expect(stack.id).toBe('adhoc-test');
    });

    it('throws GATE_CHECK_REQUIRED when task contains issue reference', () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      expect(() =>
        manager.createStack({
          name: 'gate-ref',
          projectDir: tmpDir,
          task: 'Fix the bug described in #42',
          runtime: 'docker',
        })
      ).toThrow('gateApproved was not set');
    });

    it('GATE_CHECK_REQUIRED error message contains instruction to run /spec-check', () => {
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      try {
        manager.createStack({
          name: 'gate-msg',
          projectDir: tmpDir,
          ticket: '99',
          runtime: 'docker',
        });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('GATE_CHECK_REQUIRED');
        expect(err.message).toContain('/spec-check');
        expect(err.message).toContain('gateApproved');
      }
    });
  });

  describe('dispatchTask gate enforcement', () => {
    it('throws GATE_CHECK_REQUIRED when stack has ticket and gateApproved is not set', async () => {
      const stackWithTicket = { ...makeStack('dispatch-gate'), ticket: '55' };
      registry.createStack(stackWithTicket);
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      await expect(
        manager.dispatchTask('dispatch-gate', 'Do the work')
      ).rejects.toThrow('gateApproved was not set');
    });

    it('proceeds when stack has ticket and gateApproved is true', async () => {
      const stackWithTicket = { ...makeStack('dispatch-approved'), ticket: '55' };
      registry.createStack(stackWithTicket);
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const result = await manager.dispatchTask('dispatch-approved', 'Do the work', undefined, {
        gateApproved: true,
      });

      expect(result).toBeDefined();
      expect(result.status).toBe('running');
      // Trimmed MCP response does not echo the prompt; verify via registry
      const persisted = registry.getTasksForStack('dispatch-approved');
      expect(persisted[0].prompt).toContain('Do the work');
    });

    it('throws GATE_CHECK_REQUIRED when prompt contains issue reference', async () => {
      registry.createStack(makeStack('dispatch-ref'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      await expect(
        manager.dispatchTask('dispatch-ref', 'Fix issue #42')
      ).rejects.toThrow('gateApproved was not set');
    });

    it('allows ad-hoc dispatch without gate check', async () => {
      registry.createStack(makeStack('dispatch-adhoc'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const result = await manager.dispatchTask('dispatch-adhoc', 'Refactor the login flow');
      expect(result).toBeDefined();
      expect(result.status).toBe('running');
    });

    it('allows dispatch with forceBypass', async () => {
      const stackWithTicket = { ...makeStack('dispatch-force'), ticket: '55' };
      registry.createStack(stackWithTicket);
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      const result = await manager.dispatchTask('dispatch-force', 'Do the work', undefined, {
        forceBypass: true,
      });

      expect(result).toBeDefined();
      expect(result.status).toBe('running');
    });
  });
});

describe('tailBytes', () => {
  it('returns the string unchanged when under the cap', () => {
    expect(tailBytes('hello', 100)).toBe('hello');
  });

  it('returns the string unchanged when at the cap exactly', () => {
    const s = 'a'.repeat(10);
    expect(tailBytes(s, 10)).toBe(s);
  });

  it('truncates to last N bytes with a marker when over the cap', () => {
    const s = 'a'.repeat(1000);
    const out = tailBytes(s, 100);
    // Last 100 bytes of "a"s are preserved
    expect(out.endsWith('a'.repeat(100))).toBe(true);
    // Marker records the 900 dropped bytes
    expect(out).toContain('...[truncated 900 earlier bytes]...');
    // The marker itself adds a bit of overhead, but the body is exactly 100 bytes
    expect(Buffer.byteLength(out, 'utf8')).toBeGreaterThan(100);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(200);
  });

  it('preserves UTF-8 decodability when cutting mid-codepoint', () => {
    // Multi-byte characters intentionally placed around the byte boundary
    const s = '€'.repeat(100); // 3 bytes each → 300 bytes
    const out = tailBytes(s, 50);
    // Decodes without throwing; any invalid leading bytes become U+FFFD
    expect(typeof out).toBe('string');
    expect(out).toContain('...[truncated');
  });

  it('exports sane default cap constants', () => {
    expect(TASK_OUTPUT_MAX_BYTES).toBe(4096);
    expect(LOGS_PER_CONTAINER_MAX_BYTES).toBe(8192);
    expect(LOGS_TOTAL_MAX_BYTES).toBe(32768);
  });
});
