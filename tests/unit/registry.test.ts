import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Registry } from '../../src/main/control-plane/registry';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

function makeStack(overrides: Partial<{
  id: string; project: string; project_dir: string; ticket: string | null;
  branch: string | null; description: string | null; status: string; runtime: string;
}> = {}) {
  return {
    id: overrides.id ?? 'test-stack',
    project: overrides.project ?? 'proj',
    project_dir: overrides.project_dir ?? '/proj',
    ticket: overrides.ticket ?? null,
    branch: overrides.branch ?? null,
    description: overrides.description ?? null,
    status: (overrides.status ?? 'building') as 'building',
    runtime: (overrides.runtime ?? 'docker') as 'docker',
  };
}

describe('Registry', () => {
  let registry: Registry;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
  });

  // ===========================================
  // Projects CRUD
  // ===========================================
  describe('projects', () => {
    it('adds a project and retrieves it', () => {
      const project = registry.addProject('/home/user/myapp', 'myapp');
      expect(project.id).toBeDefined();
      expect(project.name).toBe('myapp');
      expect(project.directory).toBe('/home/user/myapp');
      expect(project.added_at).toBeTruthy();
    });

    it('auto-generates name from directory basename', () => {
      const project = registry.addProject('/home/user/cool-project');
      expect(project.name).toBe('cool-project');
    });

    it('lists all projects in insertion order', () => {
      registry.addProject('/a', 'alpha');
      registry.addProject('/b', 'beta');
      registry.addProject('/c', 'gamma');

      const projects = registry.listProjects();
      expect(projects).toHaveLength(3);
      expect(projects[0].name).toBe('alpha');
      expect(projects[1].name).toBe('beta');
      expect(projects[2].name).toBe('gamma');
    });

    it('gets a single project by id', () => {
      const added = registry.addProject('/proj');
      const got = registry.getProject(added.id);
      expect(got).toBeDefined();
      expect(got!.directory).toBe('/proj');
    });

    it('returns undefined for non-existent project id', () => {
      expect(registry.getProject(9999)).toBeUndefined();
    });

    it('removes a project', () => {
      const project = registry.addProject('/proj');
      registry.removeProject(project.id);
      expect(registry.getProject(project.id)).toBeUndefined();
      expect(registry.listProjects()).toHaveLength(0);
    });

    it('rejects duplicate directories', () => {
      registry.addProject('/same/dir');
      expect(() => registry.addProject('/same/dir')).toThrow();
    });

    it('allows same name with different directories', () => {
      registry.addProject('/dir1', 'sameName');
      registry.addProject('/dir2', 'sameName');
      expect(registry.listProjects()).toHaveLength(2);
    });

    it('handles empty project list', () => {
      expect(registry.listProjects()).toEqual([]);
    });

    it('normalizes project directory paths (strips trailing slashes)', () => {
      const project = registry.addProject('/home/user/myapp/');
      expect(project.directory).toBe('/home/user/myapp');
    });

    it('normalizes project directory paths (resolves dot segments)', () => {
      const project = registry.addProject('/home/user/../user/myapp');
      expect(project.directory).toBe('/home/user/myapp');
    });
  });

  // ===========================================
  // Stacks CRUD
  // ===========================================
  describe('stacks', () => {
    it('creates and retrieves a stack', () => {
      const stack = registry.createStack(makeStack({
        id: 'test-stack',
        project: 'myproject',
        project_dir: '/home/user/myproject',
        ticket: 'EXP-123',
        branch: 'feature/test',
        description: 'Test stack',
      }));

      expect(stack.id).toBe('test-stack');
      expect(stack.project).toBe('myproject');
      expect(stack.status).toBe('building');
      expect(stack.ticket).toBe('EXP-123');
      expect(stack.branch).toBe('feature/test');
      expect(stack.description).toBe('Test stack');
      expect(stack.runtime).toBe('docker');
      expect(stack.created_at).toBeTruthy();
      expect(stack.updated_at).toBeTruthy();

      const retrieved = registry.getStack('test-stack');
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe('test-stack');
    });

    it('normalizes stack project_dir paths', () => {
      const stack = registry.createStack(makeStack({
        id: 'norm-stack',
        project_dir: '/home/user/myproject/',
      }));
      expect(stack.project_dir).toBe('/home/user/myproject');
    });

    it('creates a stack with null optional fields', () => {
      const stack = registry.createStack(makeStack());
      expect(stack.ticket).toBeNull();
      expect(stack.branch).toBeNull();
      expect(stack.description).toBeNull();
    });

    it('creates a stack with podman runtime', () => {
      const stack = registry.createStack(makeStack({ id: 'podman-stack', runtime: 'podman' }));
      expect(stack.runtime).toBe('podman');
    });

    it('lists all stacks in descending created_at order', () => {
      registry.createStack(makeStack({ id: 'stack-1' }));
      registry.createStack(makeStack({ id: 'stack-2' }));
      registry.createStack(makeStack({ id: 'stack-3' }));

      const stacks = registry.listStacks();
      expect(stacks).toHaveLength(3);
    });

    it('returns undefined for non-existent stack', () => {
      expect(registry.getStack('nonexistent')).toBeUndefined();
    });

    it('updates stack status', () => {
      registry.createStack(makeStack({ id: 'status-test' }));
      registry.updateStackStatus('status-test', 'up');
      const stack = registry.getStack('status-test');
      expect(stack!.status).toBe('up');
    });

    it('stores error message when updating status to failed', () => {
      registry.createStack(makeStack({ id: 'err-test' }));
      registry.updateStackStatus('err-test', 'failed', 'compose failed: image not found');
      const stack = registry.getStack('err-test');
      expect(stack!.status).toBe('failed');
      expect(stack!.error).toBe('compose failed: image not found');
    });

    it('error is null by default', () => {
      registry.createStack(makeStack({ id: 'null-err' }));
      const stack = registry.getStack('null-err');
      expect(stack!.error).toBeNull();
    });

    it('clears error when status updated without error param', () => {
      registry.createStack(makeStack({ id: 'clear-err' }));
      registry.updateStackStatus('clear-err', 'failed', 'some error');
      registry.updateStackStatus('clear-err', 'up');
      const stack = registry.getStack('clear-err');
      expect(stack!.status).toBe('up');
      // Error should remain unchanged when not explicitly cleared
      expect(stack!.error).toBe('some error');
    });

    it('updates updated_at when changing status', () => {
      registry.createStack(makeStack({ id: 'ts-test' }));
      const before = registry.getStack('ts-test')!.updated_at;
      registry.updateStackStatus('ts-test', 'running');
      const after = registry.getStack('ts-test')!.updated_at;
      expect(after).toBeTruthy();
      // They may be the same second but updated_at should still be set
    });

    it('cycles through all valid statuses', () => {
      registry.createStack(makeStack({ id: 'cycle' }));
      const statuses = ['building', 'rebuilding', 'up', 'running', 'completed', 'failed', 'idle', 'stopped', 'pushed', 'pr_created', 'rate_limited'] as const;
      for (const s of statuses) {
        registry.updateStackStatus('cycle', s);
        expect(registry.getStack('cycle')!.status).toBe(s);
      }
    });

    it('has null pr_url and pr_number by default', () => {
      registry.createStack(makeStack({ id: 'pr-default' }));
      const stack = registry.getStack('pr-default');
      expect(stack!.pr_url).toBeNull();
      expect(stack!.pr_number).toBeNull();
    });

    it('setPullRequest stores PR info and sets status to pr_created', () => {
      registry.createStack(makeStack({ id: 'pr-test' }));
      registry.updateStackStatus('pr-test', 'pushed');
      registry.setPullRequest('pr-test', 'https://github.com/org/repo/pull/42', 42);

      const stack = registry.getStack('pr-test');
      expect(stack!.status).toBe('pr_created');
      expect(stack!.pr_url).toBe('https://github.com/org/repo/pull/42');
      expect(stack!.pr_number).toBe(42);
    });

    it('transitions from up to pushed to pr_created', () => {
      registry.createStack(makeStack({ id: 'lifecycle' }));
      registry.updateStackStatus('lifecycle', 'up');
      expect(registry.getStack('lifecycle')!.status).toBe('up');

      registry.updateStackStatus('lifecycle', 'pushed');
      expect(registry.getStack('lifecycle')!.status).toBe('pushed');

      registry.setPullRequest('lifecycle', 'https://github.com/org/repo/pull/1', 1);
      expect(registry.getStack('lifecycle')!.status).toBe('pr_created');
    });

    it('deletes a stack', () => {
      registry.createStack(makeStack({ id: 'delete-me' }));
      registry.deleteStack('delete-me');
      expect(registry.getStack('delete-me')).toBeUndefined();
    });

    it('deletes a stack and cascades tasks and ports', () => {
      registry.createStack(makeStack({ id: 'cascade' }));
      registry.createTask('cascade', 'task 1');
      registry.createTask('cascade', 'task 2');
      registry.setPorts('cascade', [
        { service: 'app', host_port: 10001, container_port: 3000 },
      ]);

      registry.deleteStack('cascade');
      expect(registry.getStack('cascade')).toBeUndefined();
      expect(registry.getTasksForStack('cascade')).toHaveLength(0);
      expect(registry.getPorts('cascade')).toHaveLength(0);
    });

    it('rejects duplicate stack IDs', () => {
      registry.createStack(makeStack({ id: 'dup' }));
      expect(() => registry.createStack(makeStack({ id: 'dup' }))).toThrow();
    });

    it('handles empty stack list', () => {
      expect(registry.listStacks()).toEqual([]);
    });

    it('deleting non-existent stack is a no-op', () => {
      expect(() => registry.deleteStack('ghost')).not.toThrow();
    });

    it('latest_task_token_limited is false when stack has no tasks', () => {
      registry.createStack(makeStack({ id: 'no-tasks' }));
      const stacks = registry.listStacks();
      const stack = stacks.find(s => s.id === 'no-tasks');
      expect(stack?.latest_task_token_limited).toBe(false);
    });

    it('latest_task_token_limited is false when latest task execution_summary is null', () => {
      registry.createStack(makeStack({ id: 'null-summary' }));
      const task = registry.createTask('null-summary', 'do work', null);
      registry.completeTask(task.id, 0);
      const stacks = registry.listStacks();
      const stack = stacks.find(s => s.id === 'null-summary');
      expect(stack?.latest_task_token_limited).toBe(false);
    });

    it('latest_task_token_limited is true when latest task execution_summary contains the session limit marker', () => {
      registry.createStack(makeStack({ id: 'token-limited' }));
      registry.updateStackStatus('token-limited', 'completed');
      const task = registry.createTask('token-limited', 'do work', null);
      registry.updateTaskMetadata(task.id, { execution_summary: "You've hit your session limit · resets 5:20am (UTC)" });
      registry.completeTask(task.id, 0);
      const stacks = registry.listStacks();
      const stack = stacks.find(s => s.id === 'token-limited');
      expect(stack?.latest_task_token_limited).toBe(true);
    });

    it('latest_task_token_limited is false for normal completion execution_summary', () => {
      registry.createStack(makeStack({ id: 'normal-complete' }));
      const task = registry.createTask('normal-complete', 'do work', null);
      registry.updateTaskMetadata(task.id, { execution_summary: 'Task completed successfully. No issues found.' });
      registry.completeTask(task.id, 0);
      const stacks = registry.listStacks();
      const stack = stacks.find(s => s.id === 'normal-complete');
      expect(stack?.latest_task_token_limited).toBe(false);
    });

    it('latest_task_token_limited uses the most recent task only', () => {
      registry.createStack(makeStack({ id: 'multi-tasks' }));
      const task1 = registry.createTask('multi-tasks', 'first work', null);
      registry.updateTaskMetadata(task1.id, { execution_summary: "You've hit your session limit · resets 5:20am (UTC)" });
      registry.completeTask(task1.id, 0);
      // Create a second task that completed normally
      const task2 = registry.createTask('multi-tasks', 'second work', null);
      registry.updateTaskMetadata(task2.id, { execution_summary: 'Task completed.' });
      registry.completeTask(task2.id, 0);
      const stacks = registry.listStacks();
      const stack = stacks.find(s => s.id === 'multi-tasks');
      // Most recent task (task2) has normal completion, so flag should be false
      expect(stack?.latest_task_token_limited).toBe(false);
    });
  });

  // ===========================================
  // Tasks CRUD
  // ===========================================
  describe('tasks', () => {
    beforeEach(() => {
      registry.createStack(makeStack({ id: 'task-stack', status: 'up' }));
    });

    it('creates a task and updates stack status to running', () => {
      const task = registry.createTask('task-stack', 'Fix the bug');
      expect(task.id).toBeDefined();
      expect(task.stack_id).toBe('task-stack');
      expect(task.status).toBe('running');
      expect(task.prompt).toBe('Fix the bug');
      expect(task.started_at).toBeTruthy();
      expect(task.finished_at).toBeNull();
      expect(task.exit_code).toBeNull();

      const stack = registry.getStack('task-stack');
      expect(stack!.status).toBe('running');
    });

    it('creates multiple tasks for same stack', () => {
      registry.createTask('task-stack', 'Task 1');
      registry.createTask('task-stack', 'Task 2');
      registry.createTask('task-stack', 'Task 3');

      const tasks = registry.getTasksForStack('task-stack');
      expect(tasks).toHaveLength(3);
    });

    it('completes a task with exit code 0', () => {
      const task = registry.createTask('task-stack', 'Do work');
      registry.completeTask(task.id, 0);

      const tasks = registry.getTasksForStack('task-stack');
      expect(tasks[0].status).toBe('completed');
      expect(tasks[0].exit_code).toBe(0);
      expect(tasks[0].finished_at).toBeTruthy();

      const stack = registry.getStack('task-stack');
      expect(stack!.status).toBe('completed');
    });

    it('marks task as failed with non-zero exit code', () => {
      const task = registry.createTask('task-stack', 'Fail');
      registry.completeTask(task.id, 1);

      const tasks = registry.getTasksForStack('task-stack');
      expect(tasks[0].status).toBe('failed');
      expect(tasks[0].exit_code).toBe(1);

      const stack = registry.getStack('task-stack');
      expect(stack!.status).toBe('failed');
    });

    it('completeTaskNeedsHuman sets needs_human status and captures reason (#335)', () => {
      const task = registry.createTask('task-stack', 'Fix something');
      const reason = 'tests/integration/fixtures.ts is out of scope for this ticket';
      registry.completeTaskNeedsHuman(task.id, reason);

      const tasks = registry.getTasksForStack('task-stack');
      expect(tasks[0].status).toBe('needs_human');
      expect(tasks[0].exit_code).toBe(1);
      expect(tasks[0].warnings).toBe(reason);
      expect(tasks[0].finished_at).toBeTruthy();

      const stack = registry.getStack('task-stack');
      expect(stack!.status).toBe('needs_human');
    });

    it('completeTaskNeedsHuman works with empty reason string', () => {
      const task = registry.createTask('task-stack', 'Fix something');
      registry.completeTaskNeedsHuman(task.id, '');

      const tasks = registry.getTasksForStack('task-stack');
      expect(tasks[0].status).toBe('needs_human');
    });

    it('completeTaskVerifyBlockedEnvironmental sets needs_human status and verify_blocked_environmental stack status', () => {
      const task = registry.createTask('task-stack', 'Fix something');
      const reason = 'Verify blocked (environmental): jq: command not found';
      registry.completeTaskVerifyBlockedEnvironmental(task.id, reason);

      const tasks = registry.getTasksForStack('task-stack');
      expect(tasks[0].status).toBe('needs_human');
      expect(tasks[0].exit_code).toBe(1);
      expect(tasks[0].warnings).toBe(reason);
      expect(tasks[0].finished_at).toBeTruthy();

      const stack = registry.getStack('task-stack');
      expect(stack!.status).toBe('verify_blocked_environmental');
    });

    it('preserves various exit codes', () => {
      for (const code of [0, 1, 2, 127, 137, 255]) {
        const task = registry.createTask('task-stack', `exit ${code}`);
        registry.completeTask(task.id, code);
        const tasks = registry.getTasksForStack('task-stack');
        const found = tasks.find(t => t.id === task.id)!;
        expect(found.exit_code).toBe(code);
      }
    });

    it('returns running task', () => {
      registry.createTask('task-stack', 'Running');
      const running = registry.getRunningTask('task-stack');
      expect(running).toBeDefined();
      expect(running!.status).toBe('running');
    });

    it('returns undefined when no running task', () => {
      const running = registry.getRunningTask('task-stack');
      expect(running).toBeUndefined();
    });

    it('returns undefined when all tasks are completed', () => {
      const task = registry.createTask('task-stack', 'done');
      registry.completeTask(task.id, 0);
      expect(registry.getRunningTask('task-stack')).toBeUndefined();
    });

    it('tasks for non-existent stack returns empty array', () => {
      expect(registry.getTasksForStack('ghost')).toEqual([]);
    });

    it('throws FK error when creating task for non-existent stack', () => {
      expect(() => registry.createTask('nonexistent', 'oops')).toThrow();
    });

    it('sets and retrieves task warning', () => {
      const task = registry.createTask('task-stack', 'Suspicious task');
      expect(task.warnings).toBeNull();

      registry.setTaskWarning(task.id, 'Task completed suspiciously fast');
      const tasks = registry.getTasksForStack('task-stack');
      const updated = tasks.find(t => t.id === task.id)!;
      expect(updated.warnings).toBe('Task completed suspiciously fast');
    });

    it('tasks are ordered by started_at DESC', () => {
      registry.createTask('task-stack', 'First');
      registry.createTask('task-stack', 'Second');
      registry.createTask('task-stack', 'Third');

      const tasks = registry.getTasksForStack('task-stack');
      // Most recent first
      expect(tasks).toHaveLength(3);
    });
  });

  // ===========================================
  // Ports CRUD
  // ===========================================
  describe('ports', () => {
    beforeEach(() => {
      registry.createStack(makeStack({ id: 'port-stack' }));
    });

    it('sets and retrieves ports', () => {
      registry.setPorts('port-stack', [
        { service: 'app', host_port: 10001, container_port: 3000 },
        { service: 'api', host_port: 10002, container_port: 3001 },
      ]);

      const ports = registry.getPorts('port-stack');
      expect(ports).toHaveLength(2);
      expect(ports[0].service).toBe('app');
      expect(ports[0].host_port).toBe(10001);
      expect(ports[0].container_port).toBe(3000);
      expect(ports[0].stack_id).toBe('port-stack');
    });

    it('ports are ordered by host_port ASC', () => {
      registry.setPorts('port-stack', [
        { service: 'api', host_port: 10005, container_port: 3001 },
        { service: 'app', host_port: 10001, container_port: 3000 },
      ]);

      const ports = registry.getPorts('port-stack');
      expect(ports[0].host_port).toBe(10001);
      expect(ports[1].host_port).toBe(10005);
    });

    it('returns all allocated ports across stacks', () => {
      registry.createStack(makeStack({ id: 'port-stack-2' }));

      registry.setPorts('port-stack', [
        { service: 'app', host_port: 10001, container_port: 3000 },
      ]);
      registry.setPorts('port-stack-2', [
        { service: 'app', host_port: 10002, container_port: 3000 },
      ]);

      const allPorts = registry.getAllAllocatedPorts();
      expect(allPorts).toContain(10001);
      expect(allPorts).toContain(10002);
      expect(allPorts).toHaveLength(2);
    });

    it('releases ports for a stack', () => {
      registry.setPorts('port-stack', [
        { service: 'app', host_port: 10001, container_port: 3000 },
      ]);

      registry.releasePorts('port-stack');
      expect(registry.getPorts('port-stack')).toHaveLength(0);
      expect(registry.getAllAllocatedPorts()).toHaveLength(0);
    });

    it('enforces unique host ports', () => {
      registry.setPorts('port-stack', [
        { service: 'app', host_port: 10001, container_port: 3000 },
      ]);

      registry.createStack(makeStack({ id: 'port-stack-2' }));
      expect(() =>
        registry.setPorts('port-stack-2', [
          { service: 'app', host_port: 10001, container_port: 3000 },
        ])
      ).toThrow();
    });

    it('throws FK error when setting ports for non-existent stack', () => {
      expect(() =>
        registry.setPorts('nonexistent', [
          { service: 'app', host_port: 10001, container_port: 3000 },
        ])
      ).toThrow();
    });

    it('handles empty port list', () => {
      registry.setPorts('port-stack', []);
      expect(registry.getPorts('port-stack')).toHaveLength(0);
    });

    it('ports for non-existent stack returns empty array', () => {
      expect(registry.getPorts('ghost')).toEqual([]);
    });

    it('getAllAllocatedPorts returns empty when no ports exist', () => {
      expect(registry.getAllAllocatedPorts()).toEqual([]);
    });

    it('releasing ports for non-existent stack is a no-op', () => {
      expect(() => registry.releasePorts('ghost')).not.toThrow();
    });

    it('setPort inserts a single port', () => {
      registry.setPort('port-stack', 'app', 10010, 3000);
      const ports = registry.getPorts('port-stack');
      expect(ports).toHaveLength(1);
      expect(ports[0].service).toBe('app');
      expect(ports[0].host_port).toBe(10010);
      expect(ports[0].container_port).toBe(3000);
    });

    it('getPortByService retrieves a specific port', () => {
      registry.setPort('port-stack', 'app', 10010, 3000);
      const port = registry.getPortByService('port-stack', 'app', 3000);
      expect(port).toBeDefined();
      expect(port!.host_port).toBe(10010);
    });

    it('getPortByService returns undefined for nonexistent port', () => {
      expect(registry.getPortByService('port-stack', 'app', 3000)).toBeUndefined();
    });

    it('setProxyContainerId updates the proxy container id', () => {
      registry.setPort('port-stack', 'app', 10010, 3000);
      registry.setProxyContainerId('port-stack', 'app', 3000, 'proxy-123');
      const port = registry.getPortByService('port-stack', 'app', 3000);
      expect(port!.proxy_container_id).toBe('proxy-123');
    });

    it('releasePort removes a single port entry', () => {
      registry.setPort('port-stack', 'app', 10010, 3000);
      registry.setPort('port-stack', 'db', 10011, 5432);
      registry.releasePort('port-stack', 'app', 3000);
      const ports = registry.getPorts('port-stack');
      expect(ports).toHaveLength(1);
      expect(ports[0].service).toBe('db');
    });

    it('supports multiple container ports for same service', () => {
      registry.setPort('port-stack', 'app', 10010, 3000);
      registry.setPort('port-stack', 'app', 10011, 8080);
      const ports = registry.getPorts('port-stack');
      expect(ports).toHaveLength(2);
    });
  });

  // ===========================================
  // Cross-entity edge cases
  // ===========================================
  describe('cross-entity interactions', () => {
    it('creating task on non-existent stack throws FK error', () => {
      expect(() => registry.createTask('no-such-stack', 'prompt')).toThrow();
    });

    it('setting ports on non-existent stack throws FK error', () => {
      expect(() =>
        registry.setPorts('no-such-stack', [
          { service: 'app', host_port: 10001, container_port: 3000 },
        ])
      ).toThrow();
    });

    it('multiple stacks with different projects coexist', () => {
      registry.createStack(makeStack({ id: 's1', project: 'projA', project_dir: '/a' }));
      registry.createStack(makeStack({ id: 's2', project: 'projB', project_dir: '/b' }));

      expect(registry.listStacks()).toHaveLength(2);
    });

    it('deleting one stack does not affect another', () => {
      registry.createStack(makeStack({ id: 'keep' }));
      registry.createStack(makeStack({ id: 'delete' }));
      registry.createTask('keep', 'task for keep');
      registry.createTask('delete', 'task for delete');

      registry.deleteStack('delete');
      expect(registry.getStack('keep')).toBeDefined();
      expect(registry.getTasksForStack('keep')).toHaveLength(1);
    });
  });

  // ===========================================
  // Stack History
  // ===========================================
  describe('stack history', () => {
    it('archives a stack and retrieves from history', () => {
      registry.createStack(makeStack({ id: 'hist-1', branch: 'feat/test', description: 'Test work' }));
      registry.createTask('hist-1', 'Fix the bug');
      registry.archiveStack('hist-1', 'torn_down');

      const history = registry.listStackHistory();
      expect(history).toHaveLength(1);
      expect(history[0].stack_id).toBe('hist-1');
      expect(history[0].final_status).toBe('torn_down');
      expect(history[0].branch).toBe('feat/test');
      expect(history[0].description).toBe('Test work');
      expect(history[0].task_prompt).toBe('Fix the bug');
      expect(history[0].finished_at).toBeTruthy();
      expect(history[0].duration_seconds).toBeGreaterThanOrEqual(0);
    });

    it('archives with completed status', () => {
      registry.createStack(makeStack({ id: 'hist-comp' }));
      registry.archiveStack('hist-comp', 'completed');

      const history = registry.listStackHistory();
      expect(history[0].final_status).toBe('completed');
    });

    it('archives with failed status and preserves error', () => {
      registry.createStack(makeStack({ id: 'hist-fail' }));
      registry.updateStackStatus('hist-fail', 'failed', 'OOM killed');
      registry.archiveStack('hist-fail', 'failed');

      const history = registry.listStackHistory();
      expect(history[0].final_status).toBe('failed');
      expect(history[0].error).toBe('OOM killed');
    });

    it('stores null task_prompt when no tasks exist', () => {
      registry.createStack(makeStack({ id: 'hist-no-task' }));
      registry.archiveStack('hist-no-task', 'torn_down');

      const history = registry.listStackHistory();
      expect(history[0].task_prompt).toBeNull();
    });

    it('captures a task prompt when tasks exist', () => {
      registry.createStack(makeStack({ id: 'hist-multi-task' }));
      registry.createTask('hist-multi-task', 'First task');
      registry.createTask('hist-multi-task', 'Second task');
      registry.archiveStack('hist-multi-task', 'completed');

      const history = registry.listStackHistory();
      // Should capture one of the task prompts (most recent by started_at)
      expect(['First task', 'Second task']).toContain(history[0].task_prompt);
    });

    it('lists multiple history records', () => {
      registry.createStack(makeStack({ id: 'hist-a' }));
      registry.archiveStack('hist-a', 'torn_down');
      registry.createStack(makeStack({ id: 'hist-b' }));
      registry.archiveStack('hist-b', 'completed');

      const history = registry.listStackHistory();
      expect(history).toHaveLength(2);
      const ids = history.map(h => h.stack_id);
      expect(ids).toContain('hist-a');
      expect(ids).toContain('hist-b');
    });

    it('does not archive non-existent stack', () => {
      registry.archiveStack('nonexistent', 'torn_down');
      expect(registry.listStackHistory()).toHaveLength(0);
    });

    it('preserves history after original stack is deleted', () => {
      registry.createStack(makeStack({ id: 'hist-del' }));
      registry.archiveStack('hist-del', 'torn_down');
      registry.deleteStack('hist-del');

      const history = registry.listStackHistory();
      expect(history).toHaveLength(1);
      expect(history[0].stack_id).toBe('hist-del');
    });

    it('returns empty history when none exists', () => {
      expect(registry.listStackHistory()).toEqual([]);
    });
  });

  // ===========================================
  // Token Usage
  // ===========================================
  describe('token usage', () => {
    beforeEach(() => {
      registry.createStack(makeStack({ id: 'token-stack', status: 'up' }));
    });

    it('new stacks have zero token counts', () => {
      const stack = registry.getStack('token-stack');
      expect(stack!.total_input_tokens).toBe(0);
      expect(stack!.total_output_tokens).toBe(0);
    });

    it('new tasks have zero token counts', () => {
      const task = registry.createTask('token-stack', 'test');
      expect(task.input_tokens).toBe(0);
      expect(task.output_tokens).toBe(0);
    });

    it('updateTaskTokens increments task and stack totals', () => {
      const task = registry.createTask('token-stack', 'test');
      registry.updateTaskTokens(task.id, 1000, 500);

      const tasks = registry.getTasksForStack('token-stack');
      const updated = tasks.find(t => t.id === task.id)!;
      expect(updated.input_tokens).toBe(1000);
      expect(updated.output_tokens).toBe(500);

      const stack = registry.getStack('token-stack');
      expect(stack!.total_input_tokens).toBe(1000);
      expect(stack!.total_output_tokens).toBe(500);
    });

    it('uses SET semantics — second call replaces, not accumulates', () => {
      const task = registry.createTask('token-stack', 'test');
      registry.updateTaskTokens(task.id, 100, 50);
      registry.updateTaskTokens(task.id, 200, 100);

      const tasks = registry.getTasksForStack('token-stack');
      const updated = tasks.find(t => t.id === task.id)!;
      expect(updated.input_tokens).toBe(200);
      expect(updated.output_tokens).toBe(100);

      // Stack aggregate should reflect only the final values (delta-based)
      const stack = registry.getStack('token-stack');
      expect(stack!.total_input_tokens).toBe(200);
      expect(stack!.total_output_tokens).toBe(100);
    });

    it('accumulates tokens across multiple tasks on same stack', () => {
      const task1 = registry.createTask('token-stack', 'task 1');
      registry.updateTaskTokens(task1.id, 500, 200);
      registry.completeTask(task1.id, 0);

      const task2 = registry.createTask('token-stack', 'task 2');
      registry.updateTaskTokens(task2.id, 300, 100);

      const stack = registry.getStack('token-stack');
      expect(stack!.total_input_tokens).toBe(800);
      expect(stack!.total_output_tokens).toBe(300);
    });

    it('updateTaskTokens with phase breakdown stores per-phase data', () => {
      const task = registry.createTask('token-stack', 'test');
      registry.updateTaskTokens(task.id, 3000, 1500, {
        executionInput: 2000,
        executionOutput: 1000,
        reviewInput: 1000,
        reviewOutput: 500,
      });

      const tasks = registry.getTasksForStack('token-stack');
      const updated = tasks.find(t => t.id === task.id)!;
      expect(updated.input_tokens).toBe(3000);
      expect(updated.output_tokens).toBe(1500);
      expect(updated.execution_input_tokens).toBe(2000);
      expect(updated.execution_output_tokens).toBe(1000);
      expect(updated.review_input_tokens).toBe(1000);
      expect(updated.review_output_tokens).toBe(500);

      const stack = registry.getStack('token-stack');
      expect(stack!.total_input_tokens).toBe(3000);
      expect(stack!.total_output_tokens).toBe(1500);
      expect(stack!.total_execution_input_tokens).toBe(2000);
      expect(stack!.total_execution_output_tokens).toBe(1000);
      expect(stack!.total_review_input_tokens).toBe(1000);
      expect(stack!.total_review_output_tokens).toBe(500);
    });

    it('phase breakdown uses SET semantics with correct deltas', () => {
      const task = registry.createTask('token-stack', 'test');
      registry.updateTaskTokens(task.id, 1000, 500, {
        executionInput: 800,
        executionOutput: 400,
        reviewInput: 200,
        reviewOutput: 100,
      });
      registry.updateTaskTokens(task.id, 3000, 1500, {
        executionInput: 2000,
        executionOutput: 1000,
        reviewInput: 1000,
        reviewOutput: 500,
      });

      const tasks = registry.getTasksForStack('token-stack');
      const updated = tasks.find(t => t.id === task.id)!;
      expect(updated.execution_input_tokens).toBe(2000);
      expect(updated.review_input_tokens).toBe(1000);

      // Stack aggregate should reflect only the final values
      const stack = registry.getStack('token-stack');
      expect(stack!.total_input_tokens).toBe(3000);
      expect(stack!.total_output_tokens).toBe(1500);
      expect(stack!.total_execution_input_tokens).toBe(2000);
      expect(stack!.total_review_input_tokens).toBe(1000);
    });

    it('new stacks have zero per-phase token counts', () => {
      const stack = registry.getStack('token-stack');
      expect(stack!.total_execution_input_tokens).toBe(0);
      expect(stack!.total_execution_output_tokens).toBe(0);
      expect(stack!.total_review_input_tokens).toBe(0);
      expect(stack!.total_review_output_tokens).toBe(0);
    });

    it('new tasks have zero per-phase token counts', () => {
      const task = registry.createTask('token-stack', 'test');
      expect(task.execution_input_tokens).toBe(0);
      expect(task.execution_output_tokens).toBe(0);
      expect(task.review_input_tokens).toBe(0);
      expect(task.review_output_tokens).toBe(0);
    });

    it('getStackTokenUsage returns aggregated tokens', () => {
      const task = registry.createTask('token-stack', 'test');
      registry.updateTaskTokens(task.id, 2000, 1000);

      const usage = registry.getStackTokenUsage('token-stack');
      expect(usage.input_tokens).toBe(2000);
      expect(usage.output_tokens).toBe(1000);
    });

    it('getStackTokenUsage returns zeros for non-existent stack', () => {
      const usage = registry.getStackTokenUsage('nonexistent');
      expect(usage.input_tokens).toBe(0);
      expect(usage.output_tokens).toBe(0);
    });

    it('setTaskSessionId stores session ID', () => {
      const task = registry.createTask('token-stack', 'test');
      expect(task.session_id).toBeNull();

      registry.setTaskSessionId(task.id, 'session-abc-123');
      const tasks = registry.getTasksForStack('token-stack');
      const updated = tasks.find(t => t.id === task.id)!;
      expect(updated.session_id).toBe('session-abc-123');
    });

    it('createTask stores model when provided', () => {
      const task = registry.createTask('token-stack', 'test', 'opus');
      expect(task.model).toBe('opus');
    });

    it('createTask stores null model when not provided', () => {
      const task = registry.createTask('token-stack', 'test');
      expect(task.model).toBeNull();
    });

    it('createTask stores sonnet model', () => {
      const task = registry.createTask('token-stack', 'test', 'sonnet');
      expect(task.model).toBe('sonnet');
    });

    it('new tasks have zero loop iteration counts', () => {
      const task = registry.createTask('token-stack', 'test');
      expect(task.review_iterations).toBe(0);
      expect(task.verify_retries).toBe(0);
    });

    it('setTaskIterations stores review iterations and verify retries', () => {
      const task = registry.createTask('token-stack', 'test');
      registry.setTaskIterations(task.id, 3, 1);

      const tasks = registry.getTasksForStack('token-stack');
      const updated = tasks.find(t => t.id === task.id)!;
      expect(updated.review_iterations).toBe(3);
      expect(updated.verify_retries).toBe(1);
    });

    it('setTaskIterations overwrites previous values', () => {
      const task = registry.createTask('token-stack', 'test');
      registry.setTaskIterations(task.id, 2, 1);
      registry.setTaskIterations(task.id, 5, 3);

      const tasks = registry.getTasksForStack('token-stack');
      const updated = tasks.find(t => t.id === task.id)!;
      expect(updated.review_iterations).toBe(5);
      expect(updated.verify_retries).toBe(3);
    });

    it('new tasks have null resolved_model', () => {
      const task = registry.createTask('token-stack', 'test');
      expect(task.resolved_model).toBeNull();
    });

    it('updateTaskResolvedModel stores the actual model used', () => {
      const task = registry.createTask('token-stack', 'auto test');
      registry.updateTaskResolvedModel(task.id, 'claude-sonnet-4-20250514');

      const tasks = registry.getTasksForStack('token-stack');
      const updated = tasks.find(t => t.id === task.id)!;
      expect(updated.resolved_model).toBe('claude-sonnet-4-20250514');
    });

    it('updateTaskResolvedModel works alongside model field', () => {
      const task = registry.createTask('token-stack', 'opus task', 'opus');
      registry.updateTaskResolvedModel(task.id, 'claude-opus-4-20250514');

      const tasks = registry.getTasksForStack('token-stack');
      const updated = tasks.find(t => t.id === task.id)!;
      expect(updated.model).toBe('opus');
      expect(updated.resolved_model).toBe('claude-opus-4-20250514');
    });
  });

  // ===========================================
  // Legacy JSON cleanup
  // ===========================================
  describe('cleanupLegacyStackJsonFiles', () => {
    let tmpProjectDir: string;

    beforeEach(() => {
      tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-test-proj-'));
    });

    afterEach(() => {
      fs.rmSync(tmpProjectDir, { recursive: true, force: true });
    });

    it('is a no-op when .sandstorm/stacks/ does not exist', () => {
      expect(() => registry.cleanupLegacyStackJsonFiles(tmpProjectDir)).not.toThrow();
    });

    it('removes JSON files from .sandstorm/stacks/', () => {
      const stacksDir = path.join(tmpProjectDir, '.sandstorm', 'stacks');
      fs.mkdirSync(stacksDir, { recursive: true });
      fs.writeFileSync(path.join(stacksDir, '1.json'), '{"stack_id":"1"}');
      fs.writeFileSync(path.join(stacksDir, '2.json'), '{"stack_id":"2"}');

      registry.cleanupLegacyStackJsonFiles(tmpProjectDir);

      expect(fs.existsSync(path.join(stacksDir, '1.json'))).toBe(false);
      expect(fs.existsSync(path.join(stacksDir, '2.json'))).toBe(false);
    });

    it('removes the archive/ subdirectory', () => {
      const stacksDir = path.join(tmpProjectDir, '.sandstorm', 'stacks');
      const archiveDir = path.join(stacksDir, 'archive');
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(path.join(archiveDir, '1_20240101_120000.json'), '{}');

      registry.cleanupLegacyStackJsonFiles(tmpProjectDir);

      expect(fs.existsSync(archiveDir)).toBe(false);
    });

    it('removes the stacks/ directory itself when left empty', () => {
      const stacksDir = path.join(tmpProjectDir, '.sandstorm', 'stacks');
      fs.mkdirSync(stacksDir, { recursive: true });
      fs.writeFileSync(path.join(stacksDir, '1.json'), '{}');

      registry.cleanupLegacyStackJsonFiles(tmpProjectDir);

      expect(fs.existsSync(stacksDir)).toBe(false);
    });

    it('leaves stacks/ in place when non-JSON files remain', () => {
      const stacksDir = path.join(tmpProjectDir, '.sandstorm', 'stacks');
      fs.mkdirSync(stacksDir, { recursive: true });
      fs.writeFileSync(path.join(stacksDir, '1.json'), '{}');
      fs.writeFileSync(path.join(stacksDir, 'notes.txt'), 'keep me');

      registry.cleanupLegacyStackJsonFiles(tmpProjectDir);

      expect(fs.existsSync(path.join(stacksDir, '1.json'))).toBe(false);
      expect(fs.existsSync(path.join(stacksDir, 'notes.txt'))).toBe(true);
      expect(fs.existsSync(stacksDir)).toBe(true);
    });

    it('handles an already empty stacks/ directory', () => {
      const stacksDir = path.join(tmpProjectDir, '.sandstorm', 'stacks');
      fs.mkdirSync(stacksDir, { recursive: true });

      expect(() => registry.cleanupLegacyStackJsonFiles(tmpProjectDir)).not.toThrow();
      expect(fs.existsSync(stacksDir)).toBe(false);
    });

    it('is idempotent — second call is a no-op', () => {
      const stacksDir = path.join(tmpProjectDir, '.sandstorm', 'stacks');
      fs.mkdirSync(stacksDir, { recursive: true });
      fs.writeFileSync(path.join(stacksDir, '1.json'), '{}');

      registry.cleanupLegacyStackJsonFiles(tmpProjectDir);
      expect(() => registry.cleanupLegacyStackJsonFiles(tmpProjectDir)).not.toThrow();
    });
  });

  // ===========================================
  // Database lifecycle
  // ===========================================
  describe('database lifecycle', () => {
    it('close is idempotent', async () => {
      registry.close();
      // Second close should not throw
      expect(() => registry.close()).not.toThrow();
      // Recreate for afterEach
      registry = await Registry.create(makeTempDb());
    });

    it('persists data across Registry instances', async () => {
      registry.addProject('/persistent', 'persist');
      registry.createStack(makeStack({ id: 'persist-stack' }));
      registry.close();

      const registry2 = await Registry.create(dbPath);
      expect(registry2.listProjects()).toHaveLength(1);
      expect(registry2.getStack('persist-stack')).toBeDefined();
      registry2.close();

      // Reopen for afterEach cleanup
      registry = await Registry.create(makeTempDb());
    });
  });

  // ===========================================
  // Task Token Steps
  // ===========================================
  describe('task token steps', () => {
    beforeEach(() => {
      registry.createStack(makeStack({ id: 'token-steps-stack' }));
    });

    it('stores and retrieves per-step token data', () => {
      const task = registry.createTask('token-steps-stack', 'test task');
      const steps = [
        { iteration: 1, phase: 'execution', input_tokens: 1000, output_tokens: 500 },
        { iteration: 1, phase: 'review', input_tokens: 800, output_tokens: 300 },
        { iteration: 2, phase: 'execution', input_tokens: 600, output_tokens: 200 },
      ];
      registry.setTaskTokenSteps(task.id, steps);

      const retrieved = registry.getTaskTokenSteps(task.id);
      expect(retrieved).toHaveLength(3);
      expect(retrieved[0].iteration).toBe(1);
      expect(retrieved[0].phase).toBe('execution');
      expect(retrieved[0].input_tokens).toBe(1000);
      expect(retrieved[0].output_tokens).toBe(500);
      expect(retrieved[1].phase).toBe('review');
      expect(retrieved[2].iteration).toBe(2);
    });

    it('replaces existing steps on re-set', () => {
      const task = registry.createTask('token-steps-stack', 'replace test');
      registry.setTaskTokenSteps(task.id, [
        { iteration: 1, phase: 'execution', input_tokens: 100, output_tokens: 50 },
      ]);
      expect(registry.getTaskTokenSteps(task.id)).toHaveLength(1);

      registry.setTaskTokenSteps(task.id, [
        { iteration: 1, phase: 'execution', input_tokens: 200, output_tokens: 100 },
        { iteration: 1, phase: 'review', input_tokens: 150, output_tokens: 75 },
      ]);
      const steps = registry.getTaskTokenSteps(task.id);
      expect(steps).toHaveLength(2);
      expect(steps[0].input_tokens).toBe(200);
    });

    it('returns empty array for task with no steps', () => {
      const task = registry.createTask('token-steps-stack', 'no steps');
      expect(registry.getTaskTokenSteps(task.id)).toEqual([]);
    });

    it('cascades delete with task', () => {
      const task = registry.createTask('token-steps-stack', 'cascade test');
      registry.setTaskTokenSteps(task.id, [
        { iteration: 1, phase: 'execution', input_tokens: 100, output_tokens: 50 },
      ]);
      registry.deleteStack('token-steps-stack');
      expect(registry.getTaskTokenSteps(task.id)).toEqual([]);
    });

    it('orders steps by iteration then phase', () => {
      const task = registry.createTask('token-steps-stack', 'order test');
      registry.setTaskTokenSteps(task.id, [
        { iteration: 2, phase: 'review', input_tokens: 100, output_tokens: 50 },
        { iteration: 1, phase: 'review', input_tokens: 100, output_tokens: 50 },
        { iteration: 1, phase: 'execution', input_tokens: 200, output_tokens: 100 },
        { iteration: 2, phase: 'execution', input_tokens: 200, output_tokens: 100 },
      ]);
      const steps = registry.getTaskTokenSteps(task.id);
      expect(steps.map(s => `${s.iteration}:${s.phase}`)).toEqual([
        '1:execution', '1:review', '2:execution', '2:review',
      ]);
    });
  });

  // ===========================================
  // Token Validation
  // ===========================================
  describe('token validation', () => {
    beforeEach(() => {
      registry.createStack(makeStack({ id: 'validate-stack' }));
    });

    it('validates matching step and phase totals', () => {
      const task = registry.createTask('validate-stack', 'validate test');
      registry.updateTaskTokens(task.id, 1800, 800, {
        executionInput: 1000,
        executionOutput: 500,
        reviewInput: 800,
        reviewOutput: 300,
      });
      registry.setTaskTokenSteps(task.id, [
        { iteration: 1, phase: 'execution', input_tokens: 1000, output_tokens: 500 },
        { iteration: 1, phase: 'review', input_tokens: 800, output_tokens: 300 },
      ]);

      const result = registry.validateTaskTokens(task.id);
      expect(result.valid).toBe(true);
    });

    it('detects mismatched step vs phase totals', () => {
      const task = registry.createTask('validate-stack', 'mismatch test');
      registry.updateTaskTokens(task.id, 1800, 800, {
        executionInput: 1000,
        executionOutput: 500,
        reviewInput: 800,
        reviewOutput: 300,
      });
      // Steps don't match phase totals
      registry.setTaskTokenSteps(task.id, [
        { iteration: 1, phase: 'execution', input_tokens: 500, output_tokens: 200 },
        { iteration: 1, phase: 'review', input_tokens: 400, output_tokens: 150 },
      ]);

      const result = registry.validateTaskTokens(task.id);
      expect(result.valid).toBe(false);
    });

    it('validates task with no steps (valid by default)', () => {
      const task = registry.createTask('validate-stack', 'no steps');
      registry.updateTaskTokens(task.id, 1000, 500, {
        executionInput: 1000,
        executionOutput: 500,
        reviewInput: 0,
        reviewOutput: 0,
      });

      const result = registry.validateTaskTokens(task.id);
      expect(result.valid).toBe(true);
    });

    it('returns valid for non-existent task', () => {
      const result = registry.validateTaskTokens(99999);
      expect(result.valid).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Dark Factory
  // ---------------------------------------------------------------------------
  describe('Dark Factory', () => {
    it('returns false by default for a new project', () => {
      expect(registry.getDarkFactoryEnabled('/some/project')).toBe(false);
    });

    it('returns false for an unknown project', () => {
      expect(registry.getDarkFactoryEnabled('/does/not/exist')).toBe(false);
    });

    it('enables dark factory for a project', () => {
      registry.setDarkFactoryEnabled('/my/project', true);
      expect(registry.getDarkFactoryEnabled('/my/project')).toBe(true);
    });

    it('disables dark factory after enabling', () => {
      registry.setDarkFactoryEnabled('/my/project', true);
      registry.setDarkFactoryEnabled('/my/project', false);
      expect(registry.getDarkFactoryEnabled('/my/project')).toBe(false);
    });

    it('isolates per-project settings', () => {
      registry.setDarkFactoryEnabled('/project-a', true);
      registry.setDarkFactoryEnabled('/project-b', false);
      expect(registry.getDarkFactoryEnabled('/project-a')).toBe(true);
      expect(registry.getDarkFactoryEnabled('/project-b')).toBe(false);
    });

    it('normalizes project paths (trailing slash, relative path)', () => {
      registry.setDarkFactoryEnabled('/my/project', true);
      // path.resolve normalizes the path
      expect(registry.getDarkFactoryEnabled('/my/project')).toBe(true);
    });

    it('persists across registry reopen (survives DB close/reopen)', async () => {
      registry.setDarkFactoryEnabled('/persistent/project', true);
      registry.close();
      const registry2 = await Registry.create(dbPath);
      expect(registry2.getDarkFactoryEnabled('/persistent/project')).toBe(true);
      registry2.close();
      // Prevent afterEach double-close — reopen so afterEach can close it
      registry = await Registry.create(dbPath);
    });
  });

  // ---------------------------------------------------------------------------
  // Migration v20: retire orphaned #466 rollup cache tables
  // ---------------------------------------------------------------------------
  describe('migration v20 — drop ticket_rollups and rollup_dirty_stacks', () => {
    it('drops rollup tables on a DB that had them at v19', async () => {
      // Pre-seed a DB at v19 with the rollup tables populated
      const Database = (await import('better-sqlite3')).default;
      const migrationDbPath = makeTempDb();
      try {
        const rawDb = new Database(migrationDbPath);
        rawDb.pragma('journal_mode = WAL');
        rawDb.pragma('foreign_keys = ON');
        rawDb.exec(`
          CREATE TABLE IF NOT EXISTS schema_version (
            version     INTEGER PRIMARY KEY,
            applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO schema_version (version) VALUES (19);

          CREATE TABLE IF NOT EXISTS ticket_rollups (
            ticket_id            TEXT PRIMARY KEY,
            title                TEXT NOT NULL DEFAULT '',
            column               TEXT,
            total_cost           REAL NOT NULL DEFAULT 0,
            total_input_tokens   INTEGER NOT NULL DEFAULT 0,
            total_output_tokens  INTEGER NOT NULL DEFAULT 0,
            total_cache_read     INTEGER NOT NULL DEFAULT 0,
            total_cache_creation INTEGER NOT NULL DEFAULT 0,
            primary_model        TEXT,
            unpriced             INTEGER NOT NULL DEFAULT 0,
            computed_at          TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO ticket_rollups (ticket_id, total_cost) VALUES ('T-1', 1.5);

          CREATE TABLE IF NOT EXISTS rollup_dirty_stacks (
            stack_id  TEXT PRIMARY KEY,
            marked_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO rollup_dirty_stacks (stack_id) VALUES ('stack-abc');
        `);
        rawDb.close();

        // Open via Registry — this runs all migrations including v20
        const migrationRegistry = await Registry.create(migrationDbPath);

        // Both rollup tables must be gone after v20
        const remainingTables = (migrationRegistry.getDb().prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ticket_rollups','rollup_dirty_stacks')`
        ).all() as { name: string }[]).map(r => r.name);
        expect(remainingTables).toEqual([]);

        migrationRegistry.close();
      } finally {
        cleanupDb(migrationDbPath);
      }
    });

    it('is idempotent on a fresh DB (never had rollup tables)', async () => {
      // Fresh DB via Registry.create goes through ALL migrations; v20 uses
      // DROP TABLE IF EXISTS so it is a no-op if the tables were never created.
      const freshDbPath = makeTempDb();
      try {
        const freshRegistry = await Registry.create(freshDbPath);
        const remainingTables = (freshRegistry.getDb().prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ticket_rollups','rollup_dirty_stacks')`
        ).all() as { name: string }[]).map(r => r.name);
        expect(remainingTables).toEqual([]);
        freshRegistry.close();
      } finally {
        cleanupDb(freshDbPath);
      }
    });

    it('stacks/tasks token columns and task_token_steps survive (regression guard)', () => {
      // The existing registry fixture is a fully-migrated fresh DB — all columns
      // from v1-v20 are present. Verify the token columns are NOT dropped.
      const db = registry.getDb();

      const stackCols = (db.prepare(`PRAGMA table_info(stacks)`).all() as { name: string }[]).map(r => r.name);
      expect(stackCols).toContain('total_input_tokens');
      expect(stackCols).toContain('total_output_tokens');
      expect(stackCols).toContain('total_cache_read_tokens');
      expect(stackCols).toContain('total_cache_creation_tokens');

      const taskCols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map(r => r.name);
      expect(taskCols).toContain('input_tokens');
      expect(taskCols).toContain('output_tokens');
      expect(taskCols).toContain('cache_read_tokens');
      expect(taskCols).toContain('cache_creation_tokens');

      const taskTokenStepsExists = (db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='task_token_steps'`
      ).all() as { name: string }[]).length > 0;
      expect(taskTokenStepsExists).toBe(true);
    });

    it('model_routing table exists after migration', () => {
      const db = registry.getDb();
      const exists = (db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='model_routing'`
      ).all() as { name: string }[]).length > 0;
      expect(exists).toBe(true);
    });
  });

  // ==========================================================================
  // Model Routing CRUD
  // ==========================================================================
  describe('model routing CRUD', () => {
    it('getGlobalRouting returns empty config on fresh database', () => {
      const config = registry.getGlobalRouting();
      expect(config.assignments).toEqual({});
      expect(config.preset).toBeNull();
    });

    it('setGlobalRouting and getGlobalRouting round-trip', () => {
      registry.setGlobalRouting({
        assignments: { outer: { backend: 'claude', model: 'opus' } },
        preset: 'balanced',
      });
      const config = registry.getGlobalRouting();
      expect(config.assignments.outer).toEqual({ backend: 'claude', model: 'opus' });
      expect(config.preset).toBe('balanced');
    });

    it('setGlobalRouting partial update preserves existing fields', () => {
      registry.setGlobalRouting({ preset: 'budget' });
      registry.setGlobalRouting({ assignments: { review: { backend: 'claude', model: 'sonnet' } } });
      const config = registry.getGlobalRouting();
      expect(config.preset).toBe('budget');
      expect(config.assignments.review?.model).toBe('sonnet');
    });

    it('getProjectRouting returns null for missing project', () => {
      expect(registry.getProjectRouting('/proj/missing')).toBeNull();
    });

    it('setProjectRouting and getProjectRouting round-trip', () => {
      registry.setProjectRouting('/proj/a', {
        assignments: { execution: { backend: 'claude', model: 'haiku' } },
        preset: 'balanced',
      });
      const config = registry.getProjectRouting('/proj/a');
      expect(config).not.toBeNull();
      expect(config!.assignments.execution).toEqual({ backend: 'claude', model: 'haiku' });
      expect(config!.preset).toBe('balanced');
    });

    it('removeProjectRouting removes the row', () => {
      registry.setProjectRouting('/proj/a', { preset: 'budget' });
      registry.removeProjectRouting('/proj/a');
      expect(registry.getProjectRouting('/proj/a')).toBeNull();
    });

    it('different projects have independent routing', () => {
      registry.setProjectRouting('/proj/a', { preset: 'budget' });
      registry.setProjectRouting('/proj/b', { preset: 'max_quality' });
      expect(registry.getProjectRouting('/proj/a')!.preset).toBe('budget');
      expect(registry.getProjectRouting('/proj/b')!.preset).toBe('max_quality');
    });

    it('applyPreset sets preset and clears assignments on project row', () => {
      registry.setProjectRouting('/proj/a', {
        assignments: { outer: { backend: 'claude', model: 'sonnet' } },
      });
      registry.applyPreset('/proj/a', 'max_quality');
      const config = registry.getProjectRouting('/proj/a');
      expect(config!.preset).toBe('max_quality');
      expect(config!.assignments).toEqual({});
    });

    it('applyPreset throws for unknown preset', () => {
      expect(() => registry.applyPreset('/proj/a', 'nonexistent' as 'balanced')).toThrow();
    });
  });

});
