/**
 * Unit tests for registry domain modules.
 * These test the decomposed modules directly (not through the Registry facade).
 * The Registry facade's full behavior is covered by tests/unit/registry.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Registry } from '../../../../src/main/control-plane/registry';
import { ProjectsModule } from '../../../../src/main/control-plane/registry/projects';
import { StacksModule } from '../../../../src/main/control-plane/registry/stacks';
import { TasksModule } from '../../../../src/main/control-plane/registry/tasks';
import { TokensModule } from '../../../../src/main/control-plane/registry/tokens';
import { PortsModule } from '../../../../src/main/control-plane/registry/ports';
import { HistoryModule } from '../../../../src/main/control-plane/registry/history';
import { ModelSettingsModule } from '../../../../src/main/control-plane/registry/model-settings';
import { RoutingConfigModule } from '../../../../src/main/control-plane/registry/routing-config';
import { TicketConfigModule } from '../../../../src/main/control-plane/registry/ticket-config';
import { DarkFactoryModule } from '../../../../src/main/control-plane/registry/dark-factory';
import { BoardModule } from '../../../../src/main/control-plane/registry/board';
import { BackendSettingsModule } from '../../../../src/main/control-plane/registry/backend-settings';
import { SecretsModule } from '../../../../src/main/control-plane/registry/secrets';
import { SessionModule } from '../../../../src/main/control-plane/registry/session';
import { EpicsModule } from '../../../../src/main/control-plane/registry/epics';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-module-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

/** Create a Registry (runs migrations) and return its db handle for direct module testing. */
async function makeDb(): Promise<{ db: Database.Database; registry: Registry; dbPath: string }> {
  const dbPath = makeTempDb();
  const registry = await Registry.create(dbPath);
  const db = registry.getDb();
  return { db, registry, dbPath };
}

function makeStackInput(overrides: Partial<{
  id: string; project: string; project_dir: string;
  ticket: string | null; branch: string | null; description: string | null;
  status: 'building'; runtime: 'docker';
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

describe('Registry domain modules (direct)', () => {
  let db: Database.Database;
  let registry: Registry;
  let dbPath: string;

  beforeEach(async () => {
    ({ db, registry, dbPath } = await makeDb());
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
  });

  // ─── ProjectsModule ────────────────────────────────────────────────────────

  describe('ProjectsModule', () => {
    let projects: ProjectsModule;

    beforeEach(() => {
      projects = new ProjectsModule(db);
    });

    it('adds and retrieves a project', () => {
      const p = projects.addProject('/home/user/myapp', 'myapp');
      expect(p.name).toBe('myapp');
      expect(p.directory).toBe('/home/user/myapp');
      expect(p.id).toBeGreaterThan(0);
    });

    it('lists projects in insertion order', () => {
      projects.addProject('/a', 'alpha');
      projects.addProject('/b', 'beta');
      const all = projects.listProjects();
      expect(all).toHaveLength(2);
      expect(all[0].name).toBe('alpha');
      expect(all[1].name).toBe('beta');
    });

    it('removes a project by id', () => {
      const p = projects.addProject('/x', 'x');
      projects.removeProject(p.id);
      expect(projects.getProject(p.id)).toBeUndefined();
    });

    it('returns undefined for unknown project id', () => {
      expect(projects.getProject(9999)).toBeUndefined();
    });

    it('auto-generates name from basename', () => {
      const p = projects.addProject('/home/user/cool-project');
      expect(p.name).toBe('cool-project');
    });
  });

  // ─── StacksModule ──────────────────────────────────────────────────────────

  describe('StacksModule', () => {
    let stacks: StacksModule;

    beforeEach(() => {
      stacks = new StacksModule(db);
    });

    it('creates and retrieves a stack', () => {
      const s = stacks.createStack(makeStackInput());
      expect(s.id).toBe('test-stack');
      expect(s.status).toBe('building');
      expect(s.latest_task_token_limited).toBe(false);
    });

    it('throws if stack id is empty', () => {
      expect(() => stacks.createStack(makeStackInput({ id: '' }))).toThrow();
    });

    it('updates stack status', () => {
      stacks.createStack(makeStackInput());
      stacks.updateStackStatus('test-stack', 'running');
      expect(stacks.getStack('test-stack')?.status).toBe('running');
    });

    it('sets stack status with error', () => {
      stacks.createStack(makeStackInput());
      stacks.updateStackStatus('test-stack', 'failed', 'oops');
      const s = stacks.getStack('test-stack');
      expect(s?.status).toBe('failed');
      expect(s?.error).toBe('oops');
    });

    it('lists all stacks', () => {
      stacks.createStack(makeStackInput({ id: 's1' }));
      stacks.createStack(makeStackInput({ id: 's2' }));
      expect(stacks.listStacks()).toHaveLength(2);
    });

    it('deletes a stack', () => {
      stacks.createStack(makeStackInput());
      stacks.deleteStack('test-stack');
      expect(stacks.getStack('test-stack')).toBeUndefined();
    });

    it('sets pull request fields', () => {
      stacks.createStack(makeStackInput());
      stacks.setPullRequest('test-stack', 'https://gh/pr/1', 1);
      const s = stacks.getStack('test-stack');
      expect(s?.status).toBe('pr_created');
      expect(s?.pr_url).toBe('https://gh/pr/1');
      expect(s?.pr_number).toBe(1);
    });

    it('returns undefined for unknown stack id', () => {
      expect(stacks.getStack('nope')).toBeUndefined();
    });

    it('setSelfhealContinueUsed updates stacks table', () => {
      stacks.createStack(makeStackInput());
      stacks.setSelfhealContinueUsed('test-stack', 1);
      const s = stacks.getStack('test-stack');
      expect(s?.selfheal_continue_used).toBe(1);
    });

    it('getBranchesForTicket returns branches from active stacks', () => {
      stacks.createStack(makeStackInput({ id: 'ticketed', ticket: 'T-1', branch: 'feat/T-1' }));
      const branches = stacks.getBranchesForTicket('T-1');
      expect(branches).toContain('feat/T-1');
    });
  });

  // ─── TasksModule ───────────────────────────────────────────────────────────

  describe('TasksModule', () => {
    let stacks: StacksModule;
    let tasks: TasksModule;

    beforeEach(() => {
      stacks = new StacksModule(db);
      tasks = new TasksModule(db);
      stacks.createStack(makeStackInput());
    });

    it('inserts a task and retrieves it as running', () => {
      const task = tasks.insertTask('test-stack', 'do something', 'sonnet');
      expect(task.status).toBe('running');
      expect(task.prompt).toBe('do something');
      expect(task.model).toBe('sonnet');
    });

    it('getMostRecentTask returns latest task', () => {
      tasks.insertTask('test-stack', 'first');
      tasks.insertTask('test-stack', 'second');
      const t = tasks.getMostRecentTask('test-stack');
      expect(t?.prompt).toBe('second');
    });

    it('getRunningTask returns running task', () => {
      const task = tasks.insertTask('test-stack', 'run me');
      expect(tasks.getRunningTask('test-stack')?.id).toBe(task.id);
    });

    it('reopenTaskForResume clears finished_at and exit_code', () => {
      const task = tasks.insertTask('test-stack', 'resume me');
      tasks.updateTaskStatus(task.id, 'completed', 0);
      tasks.reopenTaskForResume(task.id);
      const t = tasks.getMostRecentTask('test-stack');
      expect(t?.status).toBe('running');
      expect(t?.exit_code).toBeNull();
      expect(t?.finished_at).toBeNull();
    });

    it('getTasksForStack returns all tasks ordered by started_at desc', () => {
      tasks.insertTask('test-stack', 'first');
      tasks.insertTask('test-stack', 'second');
      const all = tasks.getTasksForStack('test-stack');
      expect(all).toHaveLength(2);
      expect(all[0].prompt).toBe('second');
    });

    it('setTaskWarning updates warnings field', () => {
      const task = tasks.insertTask('test-stack', 'warn me');
      tasks.setTaskWarning(task.id, 'something is off');
      const t = tasks.getMostRecentTask('test-stack');
      expect(t?.warnings).toBe('something is off');
    });

    it('updateTaskResolvedModel sets resolved_model', () => {
      const task = tasks.insertTask('test-stack', 'model me');
      tasks.updateTaskResolvedModel(task.id, 'claude-3-5-sonnet');
      const t = tasks.getMostRecentTask('test-stack');
      expect(t?.resolved_model).toBe('claude-3-5-sonnet');
    });

    it('getNeedsHumanQuestions returns null when most recent task is not needs_human', () => {
      tasks.insertTask('test-stack', 'normal task');
      expect(tasks.getNeedsHumanQuestions('test-stack')).toBeNull();
    });
  });

  // ─── TokensModule ──────────────────────────────────────────────────────────

  describe('TokensModule', () => {
    let stacks: StacksModule;
    let tasks: TasksModule;
    let tokens: TokensModule;
    let taskId: number;

    beforeEach(() => {
      stacks = new StacksModule(db);
      tasks = new TasksModule(db);
      tokens = new TokensModule(db);
      stacks.createStack(makeStackInput());
      taskId = tasks.insertTask('test-stack', 'token task').id;
    });

    it('updateTaskTokens sets basic totals', () => {
      tokens.updateTaskTokens(taskId, 100, 50);
      const usage = tokens.getStackTokenUsage('test-stack');
      expect(usage.input_tokens).toBe(100);
      expect(usage.output_tokens).toBe(50);
    });

    it('updateTaskTokens with phase breakdown sets phase columns', () => {
      tokens.updateTaskTokens(taskId, 200, 100, {
        executionInput: 150, executionOutput: 75,
        reviewInput: 50, reviewOutput: 25,
      });
      const result = tokens.validateTaskTokens(taskId);
      expect(result.phaseTotal.executionInput).toBe(150);
      expect(result.phaseTotal.reviewInput).toBe(50);
    });

    it('setTaskTokenSteps and getTaskTokenSteps round-trip', () => {
      tokens.setTaskTokenSteps(taskId, [
        { iteration: 1, phase: 'execution', input_tokens: 10, output_tokens: 5 },
        { iteration: 1, phase: 'review', input_tokens: 8, output_tokens: 4 },
      ]);
      const steps = tokens.getTaskTokenSteps(taskId);
      expect(steps).toHaveLength(2);
      expect(steps[0].phase).toBe('execution');
      expect(steps[1].phase).toBe('review');
    });

    it('interruptTask changes status to interrupted', () => {
      tokens.interruptTask(taskId);
      const t = tasks.getMostRecentTask('test-stack');
      expect(t?.status).toBe('interrupted');
    });

    it('setTaskSessionId updates session_id', () => {
      tokens.setTaskSessionId(taskId, 'sess-abc');
      const t = tasks.getMostRecentTask('test-stack');
      expect(t?.session_id).toBe('sess-abc');
    });

    it('setTaskIterations updates review_iterations and verify_retries', () => {
      tokens.setTaskIterations(taskId, 3, 2);
      const t = tasks.getMostRecentTask('test-stack');
      expect(t?.review_iterations).toBe(3);
      expect(t?.verify_retries).toBe(2);
    });

    it('updateTaskMetadata updates specified fields only', () => {
      tokens.updateTaskMetadata(taskId, { execution_summary: 'done', execution_started_at: '2024-01-01T00:00:00Z' });
      const t = tasks.getMostRecentTask('test-stack');
      expect(t?.execution_summary).toBe('done');
      expect(t?.execution_started_at).toBe('2024-01-01T00:00:00Z');
    });
  });

  // ─── PortsModule ───────────────────────────────────────────────────────────

  describe('PortsModule', () => {
    let stacks: StacksModule;
    let ports: PortsModule;

    beforeEach(() => {
      stacks = new StacksModule(db);
      ports = new PortsModule(db);
      stacks.createStack(makeStackInput());
    });

    it('setPorts and getPorts round-trip ordered by host_port', () => {
      ports.setPorts('test-stack', [
        { service: 'api', host_port: 10005, container_port: 8080, proxy_container_id: null },
        { service: 'app', host_port: 10001, container_port: 3000, proxy_container_id: null },
      ]);
      const result = ports.getPorts('test-stack');
      expect(result).toHaveLength(2);
      expect(result[0].host_port).toBe(10001);
      expect(result[0].service).toBe('app');
    });

    it('getAllAllocatedPorts returns all host ports', () => {
      ports.setPort('test-stack', 'web', 8000, 80);
      ports.setPort('test-stack', 'db', 5432, 5432);
      expect(ports.getAllAllocatedPorts()).toEqual(expect.arrayContaining([8000, 5432]));
    });

    it('releasePorts removes all ports for a stack', () => {
      ports.setPort('test-stack', 'web', 8000, 80);
      ports.releasePorts('test-stack');
      expect(ports.getPorts('test-stack')).toHaveLength(0);
    });

    it('getPortByService returns specific port mapping', () => {
      ports.setPort('test-stack', 'web', 8080, 80);
      const p = ports.getPortByService('test-stack', 'web', 80);
      expect(p?.host_port).toBe(8080);
    });

    it('setProxyContainerId updates the proxy container id', () => {
      ports.setPort('test-stack', 'web', 8080, 80);
      ports.setProxyContainerId('test-stack', 'web', 80, 'proxy-abc');
      const p = ports.getPortByService('test-stack', 'web', 80);
      expect(p?.proxy_container_id).toBe('proxy-abc');
    });

    it('releasePort removes specific port', () => {
      ports.setPort('test-stack', 'web', 8080, 80);
      ports.setPort('test-stack', 'api', 8081, 8080);
      ports.releasePort('test-stack', 'web', 80);
      expect(ports.getPorts('test-stack')).toHaveLength(1);
      expect(ports.getPorts('test-stack')[0].service).toBe('api');
    });
  });

  // ─── HistoryModule ─────────────────────────────────────────────────────────

  describe('HistoryModule', () => {
    let stacks: StacksModule;
    let tasks: TasksModule;
    let history: HistoryModule;

    beforeEach(() => {
      stacks = new StacksModule(db);
      tasks = new TasksModule(db);
      history = new HistoryModule(db);
      stacks.createStack(makeStackInput({ id: 's1', ticket: 'T-1', branch: 'feat/T-1' }));
    });

    it('insertArchiveRecord and listStackHistory round-trip', () => {
      const stack = stacks.getStack('s1')!;
      const taskList = tasks.getTasksForStack('s1');
      history.insertArchiveRecord(stack, 'do the thing', taskList, 'completed');
      const records = history.listStackHistory();
      expect(records).toHaveLength(1);
      expect(records[0].stack_id).toBe('s1');
      expect(records[0].final_status).toBe('completed');
      expect(records[0].task_prompt).toBe('do the thing');
    });

    it('purgeOldHistory removes old records', () => {
      const stack = stacks.getStack('s1')!;
      history.insertArchiveRecord(stack, null, [], 'completed');
      // Force old finished_at
      db.prepare("UPDATE stack_history SET finished_at = datetime('now', '-30 days')").run();
      const deleted = history.purgeOldHistory(14);
      expect(deleted).toBe(1);
      expect(history.listStackHistory()).toHaveLength(0);
    });
  });

  // ─── ModelSettingsModule ───────────────────────────────────────────────────

  describe('ModelSettingsModule', () => {
    let modelSettings: ModelSettingsModule;

    beforeEach(() => {
      modelSettings = new ModelSettingsModule(db);
    });

    it('getGlobalModelSettings returns defaults', () => {
      const s = modelSettings.getGlobalModelSettings();
      expect(s.inner_model).toBe('sonnet');
      expect(s.outer_model).toBe('opus');
    });

    it('setGlobalModelSettings updates values', () => {
      modelSettings.setGlobalModelSettings({ inner_model: 'haiku' });
      expect(modelSettings.getGlobalModelSettings().inner_model).toBe('haiku');
    });

    it('project model settings override global', () => {
      modelSettings.setProjectModelSettings('/proj', { inner_model: 'opus' });
      const ps = modelSettings.getProjectModelSettings('/proj');
      expect(ps?.inner_model).toBe('opus');
    });

    it('removeProjectModelSettings deletes row', () => {
      modelSettings.setProjectModelSettings('/proj', { inner_model: 'haiku' });
      modelSettings.removeProjectModelSettings('/proj');
      expect(modelSettings.getProjectModelSettings('/proj')).toBeNull();
    });
  });

  // ─── RoutingConfigModule ───────────────────────────────────────────────────

  describe('RoutingConfigModule', () => {
    let modelSettings: ModelSettingsModule;
    let routingConfig: RoutingConfigModule;

    beforeEach(() => {
      modelSettings = new ModelSettingsModule(db);
      routingConfig = new RoutingConfigModule(db, modelSettings);
    });

    it('getGlobalRouting returns empty defaults', () => {
      const r = routingConfig.getGlobalRouting();
      expect(r.assignments).toEqual({});
      expect(r.preset).toBeNull();
    });

    it('setGlobalRouting and getGlobalRouting round-trip', () => {
      routingConfig.setGlobalRouting({ preset: 'balanced' });
      expect(routingConfig.getGlobalRouting().preset).toBe('balanced');
    });

    it('getProjectRouting returns null when unset', () => {
      expect(routingConfig.getProjectRouting('/proj')).toBeNull();
    });

    it('setProjectRouting and removeProjectRouting round-trip', () => {
      routingConfig.setProjectRouting('/proj', { preset: 'fast' });
      expect(routingConfig.getProjectRouting('/proj')?.preset).toBe('fast');
      routingConfig.removeProjectRouting('/proj');
      expect(routingConfig.getProjectRouting('/proj')).toBeNull();
    });

    it('getEffectiveRoutingFor falls back to legacy models', () => {
      const assignment = routingConfig.getEffectiveRoutingFor('/proj', 'execution');
      expect(assignment.model).toBeTruthy();
      expect(assignment.backend).toBe('claude');
    });

    it('getEffectiveModels returns inner and outer model', () => {
      const models = routingConfig.getEffectiveModels('/proj');
      expect(models.inner_model).toBeTruthy();
      expect(models.outer_model).toBeTruthy();
    });
  });

  // ─── TicketConfigModule ────────────────────────────────────────────────────

  describe('TicketConfigModule', () => {
    let ticketConfig: TicketConfigModule;

    beforeEach(() => {
      ticketConfig = new TicketConfigModule(db);
    });

    it('returns null when not configured', () => {
      expect(ticketConfig.getProjectTicketConfig('/proj')).toBeNull();
    });

    it('sets and retrieves github config', () => {
      ticketConfig.setProjectTicketConfig('/proj', { provider: 'github', ticket_prefix: 'T' });
      const c = ticketConfig.getProjectTicketConfig('/proj');
      expect(c?.provider).toBe('github');
      expect(c?.ticket_prefix).toBe('T');
    });

    it('removeProjectTicketConfig deletes the row', () => {
      ticketConfig.setProjectTicketConfig('/proj', { provider: 'github' });
      ticketConfig.removeProjectTicketConfig('/proj');
      expect(ticketConfig.getProjectTicketConfig('/proj')).toBeNull();
    });
  });

  // ─── DarkFactoryModule ─────────────────────────────────────────────────────

  describe('DarkFactoryModule', () => {
    let darkFactory: DarkFactoryModule;

    beforeEach(() => {
      darkFactory = new DarkFactoryModule(db);
    });

    it('getDarkFactoryEnabled returns false by default', () => {
      expect(darkFactory.getDarkFactoryEnabled('/proj')).toBe(false);
    });

    it('setDarkFactoryEnabled and getDarkFactoryEnabled toggle', () => {
      darkFactory.setDarkFactoryEnabled('/proj', true);
      expect(darkFactory.getDarkFactoryEnabled('/proj')).toBe(true);
      darkFactory.setDarkFactoryEnabled('/proj', false);
      expect(darkFactory.getDarkFactoryEnabled('/proj')).toBe(false);
    });

    it('getDarkFactoryConfig returns default level and strategy', () => {
      const c = darkFactory.getDarkFactoryConfig('/proj');
      expect(c.level).toBe('manual');
      expect(c.merge_strategy).toBe('squash');
    });

    it('setDarkFactoryConfig persists level and merge_strategy', () => {
      darkFactory.setDarkFactoryConfig('/proj', { level: 'assisted', merge_strategy: 'merge' });
      const c = darkFactory.getDarkFactoryConfig('/proj');
      expect(c.level).toBe('assisted');
      expect(c.merge_strategy).toBe('merge');
    });
  });

  // ─── BoardModule ───────────────────────────────────────────────────────────

  describe('BoardModule', () => {
    let board: BoardModule;
    let movedCalls: Array<{ ticketId: string; projectDir: string; column: string }>;
    const sessionProtected = new Set<string>();

    beforeEach(() => {
      movedCalls = [];
      board = new BoardModule(db, sessionProtected, (ticketId, projectDir, column) => {
        movedCalls.push({ ticketId, projectDir, column });
      });
    });

    it('seedBoardTicket creates a backlog row', () => {
      board.seedBoardTicket('T-1', '/proj', 'My ticket');
      const tickets = board.listBoardTickets('/proj');
      expect(tickets).toHaveLength(1);
      expect(tickets[0].ticket_id).toBe('T-1');
      expect(tickets[0].column).toBe('backlog');
    });

    it('setBoardTicketColumn moves ticket and fires listener', () => {
      board.seedBoardTicket('T-1', '/proj', 'My ticket');
      board.setBoardTicketColumn('T-1', '/proj', 'in_stack');
      const tickets = board.listBoardTickets('/proj');
      expect(tickets[0].column).toBe('in_stack');
      expect(movedCalls).toHaveLength(1);
      expect(movedCalls[0].column).toBe('in_stack');
    });

    it('deleteBoardTicket removes the row', () => {
      board.seedBoardTicket('T-1', '/proj', 'My ticket');
      board.deleteBoardTicket('T-1', '/proj');
      expect(board.listBoardTickets('/proj')).toHaveLength(0);
    });

    it('listBoardTicketsInOrder respects orderedIds', () => {
      board.seedBoardTicket('T-1', '/proj', 'first');
      board.seedBoardTicket('T-2', '/proj', 'second');
      const ordered = board.listBoardTicketsInOrder('/proj', ['T-2', 'T-1']);
      expect(ordered[0].ticket_id).toBe('T-2');
      expect(ordered[1].ticket_id).toBe('T-1');
    });
  });

  // ─── BackendSettingsModule ─────────────────────────────────────────────────

  describe('BackendSettingsModule', () => {
    let backendSettings: BackendSettingsModule;

    beforeEach(() => {
      backendSettings = new BackendSettingsModule(db);
    });

    it('getGlobalBackendSettings returns defaults', () => {
      const s = backendSettings.getGlobalBackendSettings();
      expect(s.inner_backend).toBe('claude');
      expect(s.outer_backend).toBe('claude');
    });

    it('setGlobalBackendSettings updates inner_backend', () => {
      backendSettings.setGlobalBackendSettings({ inner_backend: 'opencode' });
      expect(backendSettings.getGlobalBackendSettings().inner_backend).toBe('opencode');
    });

    it('getProjectBackendSettings returns null when unset', () => {
      expect(backendSettings.getProjectBackendSettings('/proj')).toBeNull();
    });

    it('setProjectBackendSettings persists project overrides', () => {
      backendSettings.setProjectBackendSettings('/proj', { inner_backend: 'opencode' });
      expect(backendSettings.getProjectBackendSettings('/proj')?.inner_backend).toBe('opencode');
    });
  });

  // ─── SecretsModule ─────────────────────────────────────────────────────────

  describe('SecretsModule', () => {
    let secrets: SecretsModule;

    beforeEach(() => {
      secrets = new SecretsModule(db);
    });

    it('setBackendSecret and getBackendSecret round-trip', () => {
      secrets.setBackendSecret('global', 'inner', 'api_key', 'sk-123');
      expect(secrets.getBackendSecret('global', 'inner')).toBe('sk-123');
    });

    it('hasBackendSecret returns false before set', () => {
      expect(secrets.hasBackendSecret('global', 'inner')).toBe(false);
    });

    it('setBackendSecretBundle and getBackendSecretBundle round-trip', () => {
      secrets.setBackendSecretBundle('global', 'inner', { api_key: 'sk-xyz', org: 'my-org' });
      const bundle = secrets.getBackendSecretBundle('global', 'inner');
      expect(bundle?.api_key).toBe('sk-xyz');
      expect(bundle?.org).toBe('my-org');
    });

    it('setProviderSecretBundle and getProviderSecretBundle round-trip', () => {
      secrets.setProviderSecretBundle('global', 'anthropic', { api_key: 'sk-ant' });
      const bundle = secrets.getProviderSecretBundle('global', 'anthropic');
      expect(bundle?.api_key).toBe('sk-ant');
    });

    it('hasProviderSecret returns false before set', () => {
      expect(secrets.hasProviderSecret('global', 'anthropic')).toBe(false);
    });

    it('removeProviderSecret removes the row', () => {
      secrets.setProviderSecretBundle('global', 'anthropic', { api_key: 'sk-ant' });
      secrets.removeProviderSecret('global', 'anthropic');
      expect(secrets.getProviderSecretBundle('global', 'anthropic')).toBeNull();
    });

    it('getStoredProviderKeys lists provider names for a scope', () => {
      secrets.setProviderSecretBundle('global', 'anthropic', { api_key: 'sk-1' });
      secrets.setProviderSecretBundle('global', 'openai', { api_key: 'sk-2' });
      const keys = secrets.getStoredProviderKeys('global');
      expect(keys).toContain('anthropic');
      expect(keys).toContain('openai');
    });
  });

  // ─── SessionModule ─────────────────────────────────────────────────────────

  describe('SessionModule', () => {
    let session: SessionModule;

    beforeEach(() => {
      session = new SessionModule(db);
    });

    it('getSessionMonitorSettings returns defaults', () => {
      const s = session.getSessionMonitorSettings();
      expect(s.warningThreshold).toBe(80);
      expect(s.criticalThreshold).toBe(90);
      expect(s.autoHaltEnabled).toBe(true);
      expect(s.pollingDisabled).toBe(false);
    });

    it('setSessionMonitorSettings updates fields', () => {
      session.setSessionMonitorSettings({ warningThreshold: 70, pollingDisabled: true });
      const s = session.getSessionMonitorSettings();
      expect(s.warningThreshold).toBe(70);
      expect(s.pollingDisabled).toBe(true);
    });
  });

  // ─── EpicsModule ───────────────────────────────────────────────────────────

  describe('EpicsModule', () => {
    let epics: EpicsModule;

    beforeEach(() => {
      epics = new EpicsModule(db);
    });

    it('getEpicRunState returns null when not set', () => {
      expect(epics.getEpicRunState('epic-1')).toBeNull();
    });

    it('upsertEpicRunState and getEpicRunState round-trip', () => {
      epics.upsertEpicRunState('epic-1', '/proj', 'running');
      const state = epics.getEpicRunState('epic-1');
      expect(state?.status).toBe('running');
      expect(state?.epic_id).toBe('epic-1');
    });

    it('upsertEpicRunState throws for invalid status', () => {
      expect(() => epics.upsertEpicRunState('epic-1', '/proj', 'invalid' as never)).toThrow();
    });

    it('upsertEpicTask and getEpicTasks round-trip', () => {
      epics.upsertEpicRunState('epic-1', '/proj', 'running');
      epics.upsertEpicTask('epic-1', 'T-1', { role: 'build', origin: 'planned' });
      const tasks = epics.getEpicTasks('epic-1');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].role).toBe('build');
    });

    it('setEpicTaskDone marks task as done', () => {
      epics.upsertEpicRunState('epic-1', '/proj', 'running');
      epics.upsertEpicTask('epic-1', 'T-1', { role: 'build', origin: 'planned' });
      epics.setEpicTaskDone('epic-1', 'T-1');
      expect(epics.getEpicTasks('epic-1')[0].done).toBe(1);
    });

    it('incrementGapCycles increments counter', () => {
      const n1 = epics.incrementGapCycles('epic-1', 'T-1');
      const n2 = epics.incrementGapCycles('epic-1', 'T-1');
      expect(n1).toBe(1);
      expect(n2).toBe(2);
    });

    it('getEpicMaxParallelStacks returns 3 by default', () => {
      expect(epics.getEpicMaxParallelStacks('/proj')).toBe(3);
    });

    it('setEpicMaxParallelStacks persists value', () => {
      epics.setEpicMaxParallelStacks('/proj', 5);
      expect(epics.getEpicMaxParallelStacks('/proj')).toBe(5);
    });

    it('getAllEpicIds returns distinct epic ids', () => {
      epics.upsertEpicTask('epic-a', 'T-1', { role: 'build', origin: 'planned' });
      epics.upsertEpicTask('epic-b', 'T-2', { role: 'build', origin: 'planned' });
      const ids = epics.getAllEpicIds();
      expect(ids).toContain('epic-a');
      expect(ids).toContain('epic-b');
    });

    it('getEpicForTicket returns the epic for a ticket', () => {
      epics.upsertEpicTask('epic-1', 'T-99', { role: 'reconcile', origin: 'gap' });
      const result = epics.getEpicForTicket('T-99');
      expect(result?.epicId).toBe('epic-1');
      expect(result?.role).toBe('reconcile');
    });
  });
});
