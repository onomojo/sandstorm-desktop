import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StackManager, sanitizeComposeName } from '../../src/main/control-plane/stack-manager';
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
    taskWatcher = new TaskWatcher(registry, runtime, { pollInterval: 100 });
    manager = new StackManager(registry, portAllocator, taskWatcher, runtime, '/fake/cli');
  });

  afterEach(() => {
    taskWatcher.unwatchAll();
    registry.close();
    cleanupDb(dbPath);
  });

  describe('createStack', () => {
    let tmpDir: string;

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

      // Ports should have been allocated after stack creation (FK: stack exists first)
      const ports = registry.getPorts('fk-test');
      expect(ports).toHaveLength(1);
      expect(ports[0].container_port).toBe(3000);
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
      expect(env).toHaveProperty('SANDSTORM_PORT_app_0');
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

      const task = await manager.dispatchTask('dispatch-test', 'Fix the bug');
      expect(task.prompt).toBe('Fix the bug');
      expect(task.status).toBe('running');

      // Should delegate to CLI `task` command (handles cred sync + user perms)
      expect(runCliSpy).toHaveBeenCalledWith(
        '/proj',
        ['task', 'dispatch-test', 'Fix the bug']
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

      const task = await manager.dispatchTask('model-test', 'Complex task', 'opus');
      expect(task.model).toBe('opus');
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

      const task = await manager.dispatchTask('auto-model', 'Simple task', 'auto');
      // "auto" should resolve to null in the DB (undefined → null via registry)
      expect(task.model).toBeNull();
      // CLI args should NOT contain --model
      expect(runCliSpy).toHaveBeenCalledWith(
        '/proj',
        ['task', 'auto-model', 'Simple task']
      );
    });

    it('omits model from CLI args when not provided', async () => {
      registry.createStack(makeStack('no-model'));
      const runCliSpy = vi.spyOn(manager, 'runCli').mockResolvedValue({
        stdout: 'Task dispatched.',
        stderr: '',
        exitCode: 0,
      });

      const task = await manager.dispatchTask('no-model', 'Simple task');
      expect(task.model).toBeNull();
      expect(runCliSpy).toHaveBeenCalledWith(
        '/proj',
        ['task', 'no-model', 'Simple task']
      );
    });
  });

  describe('waitForClaudeReady', () => {
    it('resolves immediately when readiness file exists', async () => {
      registry.createStack(makeStack('ready-test'));
      // Default mock exec returns exitCode: 0, so test -f succeeds
      await expect(
        manager.waitForClaudeReady('claude-container-1', 5000, 100)
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
        manager.waitForClaudeReady('claude-container-1', 5000, 50)
      ).resolves.toBeUndefined();
    });

    it('throws after timeout when container never becomes ready', async () => {
      (runtime.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: '',
      });

      await expect(
        manager.waitForClaudeReady('claude-container-1', 200, 50)
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
        manager.waitForClaudeReady('claude-container-1', 5000, 50)
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
      expect(waitSpy).toHaveBeenCalledWith('claude-container-1');
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
        return { id: 1, stack_id: 'retry-test', prompt: 'task', model: null, status: 'running', exit_code: null, warnings: null, started_at: '', finished_at: null };
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
        expect(runCliSpy).toHaveBeenCalledWith('/proj', ['start', 'start-bg']);
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
    it('deletes stack from registry immediately', () => {
      registry.createStack(makeStack('teardown-test'));
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      manager.teardownStack('teardown-test');
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

      manager.teardownStack('teardown-bg');

      await vi.waitFor(() => {
        expect(runCliSpy).toHaveBeenCalledWith(
          '/proj',
          ['down', 'teardown-bg']
        );
      }, { timeout: 5000 });
    });

    it('throws when tearing down non-existent stack', () => {
      expect(() => manager.teardownStack('ghost')).toThrow('not found');
    });

    it('best-effort teardown even if CLI fails', async () => {
      registry.createStack(makeStack('compose-fail'));
      vi.spyOn(manager, 'runCli').mockRejectedValueOnce(new Error('cli error'));

      // Should not throw — best effort
      manager.teardownStack('compose-fail');
      expect(registry.getStack('compose-fail')).toBeUndefined();
    });

    it('archives stack to history before deleting', () => {
      registry.createStack(makeStack('archive-test'));
      registry.updateStackStatus('archive-test', 'completed');
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      manager.teardownStack('archive-test');
      expect(registry.getStack('archive-test')).toBeUndefined();

      const history = registry.listStackHistory();
      expect(history).toHaveLength(1);
      expect(history[0].stack_id).toBe('archive-test');
      expect(history[0].final_status).toBe('completed');
    });

    it('archives failed stack with failed status', () => {
      registry.createStack(makeStack('fail-archive'));
      registry.updateStackStatus('fail-archive', 'failed', 'build error');
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      manager.teardownStack('fail-archive');

      const history = registry.listStackHistory();
      expect(history).toHaveLength(1);
      expect(history[0].final_status).toBe('failed');
      expect(history[0].error).toBe('build error');
    });

    it('archives running stack as torn_down', () => {
      registry.createStack(makeStack('running-archive'));
      registry.updateStackStatus('running-archive', 'running');
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      manager.teardownStack('running-archive');

      const history = registry.listStackHistory();
      expect(history).toHaveLength(1);
      expect(history[0].final_status).toBe('torn_down');
    });

    it('calls onStackUpdate callback during teardown', () => {
      const updateCallback = vi.fn();
      manager.setOnStackUpdate(updateCallback);
      vi.spyOn(manager, 'runCli').mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      registry.createStack(makeStack('cb-teardown'));
      manager.teardownStack('cb-teardown');

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
    it('returns running status with task when a task is running', () => {
      registry.createStack(makeStack('status-test'));
      registry.createTask('status-test', 'do work');

      const result = manager.getTaskStatus('status-test');
      expect(result.status).toBe('running');
      expect(result.task).toBeDefined();
      expect(result.task!.prompt).toBe('do work');
    });

    it('returns latest completed task status when no running task', () => {
      registry.createStack(makeStack('status-done'));
      const task = registry.createTask('status-done', 'done work');
      registry.completeTask(task.id, 0);

      const result = manager.getTaskStatus('status-done');
      expect(result.status).toBe('completed');
      expect(result.task).toBeDefined();
    });

    it('returns idle when stack has no tasks', () => {
      registry.createStack(makeStack('status-idle'));

      const result = manager.getTaskStatus('status-idle');
      expect(result.status).toBe('idle');
      expect(result.task).toBeUndefined();
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

});
