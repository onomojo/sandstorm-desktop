import { vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

// Mock window.sandstorm API
export function mockSandstormApi() {
  const api = {
    projects: {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn().mockResolvedValue({ id: 1, name: 'test', directory: '/test', added_at: '' }),
      remove: vi.fn().mockResolvedValue(undefined),
      browse: vi.fn().mockResolvedValue(null),
      checkInit: vi.fn().mockResolvedValue({ state: 'full' }),
      initialize: vi.fn().mockResolvedValue(true),
      checkMigration: vi.fn().mockResolvedValue({ needsMigration: false }),
      autoDetectVerify: vi.fn().mockResolvedValue({ verifyScript: '#!/bin/bash\nset -e\n', serviceDescriptions: {} }),
      saveMigration: vi.fn().mockResolvedValue({ success: true }),
      generateCompose: vi.fn().mockResolvedValue({ success: true, yaml: 'services:\n  claude:\n    image: test\n', composeFile: 'docker-compose.yml', services: [] }),
      saveComposeSetup: vi.fn().mockResolvedValue({ success: true }),
    },
    stacks: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'test-stack', project: 'proj', status: 'building', services: [] }),
      teardown: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      history: vi.fn().mockResolvedValue([]),
      setPr: vi.fn().mockResolvedValue(undefined),
      detectStale: vi.fn().mockResolvedValue([]),
      cleanupStale: vi.fn().mockResolvedValue([]),
    },
    tasks: {
      dispatch: vi.fn().mockResolvedValue({ id: 1, stack_id: 'test', prompt: '', model: null, status: 'running' }),
      list: vi.fn().mockResolvedValue([]),
      tokenSteps: vi.fn().mockResolvedValue([]),
      workflowProgress: vi.fn().mockResolvedValue(null),
    },
    diff: {
      get: vi.fn().mockResolvedValue(''),
    },
    push: {
      execute: vi.fn().mockResolvedValue(undefined),
    },
    ports: {
      get: vi.fn().mockResolvedValue([]),
      expose: vi.fn().mockResolvedValue(12345),
      unexpose: vi.fn().mockResolvedValue(undefined),
      cleanupLegacy: vi.fn().mockResolvedValue({ success: true }),
    },
    logs: {
      stream: vi.fn().mockResolvedValue(''),
    },
    stats: {
      stackMemory: vi.fn().mockResolvedValue(0),
      stackDetailed: vi.fn().mockResolvedValue({ stackId: '', totalMemory: 0, containers: [] }),
      taskMetrics: vi.fn().mockResolvedValue({ stackId: '', totalTasks: 0, completedTasks: 0, failedTasks: 0, runningTasks: 0, avgTaskDurationMs: 0 }),
      tokenUsage: vi.fn().mockResolvedValue({ stackId: '', input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
      globalTokenUsage: vi.fn().mockResolvedValue({ total_input_tokens: 0, total_output_tokens: 0, total_tokens: 0, per_stack: [] }),
      rateLimit: vi.fn().mockResolvedValue({ active: false, reset_at: null, affected_stacks: [], reason: null }),
      accountUsage: vi.fn().mockResolvedValue(null),
    },
    docker: {
      status: vi.fn().mockResolvedValue({ connected: true }),
    },
    runtime: {
      available: vi.fn().mockResolvedValue({ docker: true, podman: false }),
    },
    agent: {
      send: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockResolvedValue(undefined),
      history: vi.fn().mockResolvedValue({ messages: [], processing: false }),
      tokenUsage: vi.fn().mockResolvedValue({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    },
    context: {
      get: vi.fn().mockResolvedValue({ instructions: '', skills: [], settings: '' }),
      saveInstructions: vi.fn().mockResolvedValue(undefined),
      listSkills: vi.fn().mockResolvedValue([]),
      getSkill: vi.fn().mockResolvedValue(''),
      saveSkill: vi.fn().mockResolvedValue(undefined),
      deleteSkill: vi.fn().mockResolvedValue(undefined),
      getSettings: vi.fn().mockResolvedValue(''),
      saveSettings: vi.fn().mockResolvedValue(undefined),
    },
    specGate: {
      get: vi.fn().mockResolvedValue(''),
      save: vi.fn().mockResolvedValue(undefined),
      getDefault: vi.fn().mockResolvedValue(''),
      ensure: vi.fn().mockResolvedValue(true),
    },
    reviewPrompt: {
      get: vi.fn().mockResolvedValue(''),
      save: vi.fn().mockResolvedValue(undefined),
      getDefault: vi.fn().mockResolvedValue(''),
      ensure: vi.fn().mockResolvedValue(true),
    },
    modelSettings: {
      getGlobal: vi.fn().mockResolvedValue({ inner_model: 'sonnet', outer_model: 'opus' }),
      setGlobal: vi.fn().mockResolvedValue(undefined),
      getProject: vi.fn().mockResolvedValue(null),
      setProject: vi.fn().mockResolvedValue(undefined),
      removeProject: vi.fn().mockResolvedValue(undefined),
      getEffective: vi.fn().mockResolvedValue({ inner_model: 'sonnet', outer_model: 'opus' }),
    },
    session: {
      getState: vi.fn().mockResolvedValue({
        usage: null, level: 'normal', stale: false, halted: false,
        lastPollAt: null, consecutiveFailures: 0,
        pollMode: 'normal', nextPollAt: null, idle: false, claudeAvailable: null,
      }),
      getSettings: vi.fn().mockResolvedValue({
        warningThreshold: 80, criticalThreshold: 90, autoHaltThreshold: 95,
        autoHaltEnabled: true, autoResumeAfterReset: false, pollIntervalMs: 120000,
        idleTimeoutMs: 300000, pollingDisabled: false,
      }),
      updateSettings: vi.fn().mockResolvedValue(undefined),
      acknowledgeCritical: vi.fn().mockResolvedValue(undefined),
      haltAll: vi.fn().mockResolvedValue([]),
      resumeAll: vi.fn().mockResolvedValue([]),
      resumeStack: vi.fn().mockResolvedValue(undefined),
      forcePoll: vi.fn().mockResolvedValue({
        usage: null, level: 'normal', stale: false, halted: false,
        lastPollAt: null, consecutiveFailures: 0,
        pollMode: 'normal', nextPollAt: null, idle: false, claudeAvailable: null,
      }),
      reportActivity: vi.fn(),
    },
    schedules: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'sch_test', cronExpression: '0 * * * *', action: { kind: 'run-script', scriptName: 'test.sh' }, enabled: true, createdAt: '', updatedAt: '' }),
      update: vi.fn().mockResolvedValue({ id: 'sch_test', cronExpression: '0 * * * *', action: { kind: 'run-script', scriptName: 'test.sh' }, enabled: true, createdAt: '', updatedAt: '' }),
      delete: vi.fn().mockResolvedValue(undefined),
      cronHealth: vi.fn().mockResolvedValue({ running: true }),
      listBuiltInActions: vi.fn().mockResolvedValue([]),
      listScripts: vi.fn().mockResolvedValue([]),
    },
    auth: {
      status: vi.fn().mockResolvedValue({ loggedIn: false, expired: false }),
      login: vi.fn().mockResolvedValue({ success: true }),
    },
    tickets: {
      fetch: vi.fn().mockResolvedValue({ body: '# Issue: test\n\nbody', url: 'https://github.com/o/r/issues/1' }),
      specCheck: vi.fn().mockResolvedValue({
        passed: true, questions: [], gateSummary: 'Gate=PASS, questions=0',
        ticketUrl: 'https://github.com/o/r/issues/1', cached: false,
      }),
      specRefine: vi.fn().mockResolvedValue({
        passed: true, questions: [], gateSummary: 'Gate=PASS, questions=0',
        ticketUrl: 'https://github.com/o/r/issues/1', cached: false,
      }),
      specCheckAsync: vi.fn().mockResolvedValue({ sessionId: 'test-session-id' }),
      specRefineAsync: vi.fn().mockResolvedValue(undefined),
      cancelRefinement: vi.fn().mockResolvedValue(undefined),
      listRefinements: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({
        url: 'https://github.com/o/r/issues/42', number: 42, ticketId: '42',
      }),
    },
    pr: {
      draftBody: vi.fn().mockResolvedValue({ title: 'Test PR', body: '## Summary\n- thing\n\n## Test plan\n- [ ] check' }),
      create: vi.fn().mockResolvedValue({ url: 'https://github.com/o/r/pull/1', number: 1 }),
    },
    on: vi.fn().mockReturnValue(() => {}),
  };

  Object.defineProperty(window, 'sandstorm', {
    value: api,
    writable: true,
    configurable: true,
  });

  return api;
}
