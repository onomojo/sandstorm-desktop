import { contextBridge, ipcRenderer } from 'electron';
import type { ByTicketEntry } from '@main/telemetry/types';

export type ScheduleAction =
  | { kind: 'run-script'; scriptName: string };

export interface BuiltInAction {
  kind: ScheduleAction['kind'];
  label: string;
  description: string;
  defaultAction: ScheduleAction;
}

export interface ScheduleEntry {
  id: string;
  label?: string;
  cronExpression: string;
  action: ScheduleAction;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SandstormAPI {
  projects: {
    list: () => Promise<unknown[]>;
    add: (directory: string) => Promise<unknown>;
    remove: (id: number) => Promise<void>;
    browse: () => Promise<string | null>;
    checkInit: (directory: string) => Promise<{ state: 'uninitialized' | 'partial' | 'full' }>;
    initialize: (directory: string) => Promise<{ success: boolean; error?: string; skippedFiles?: string[] }>;
    checkMigration: (directory: string) => Promise<{
      needsMigration: boolean;
      missingVerifyScript?: boolean;
      missingServiceLabels?: boolean;
      networksMigrated?: boolean;
      legacyPortMappings?: boolean;
      ticketProviderUnconfigured?: boolean;
    }>;
    autoDetectVerify: (directory: string) => Promise<{
      verifyScript: string;
      serviceDescriptions: Record<string, string>;
    }>;
    saveMigration: (
      directory: string,
      verifyScript: string,
      serviceDescriptions: Record<string, string>,
    ) => Promise<{ success: boolean; error?: string }>;
    generateCompose: (directory: string) => Promise<{
      success: boolean;
      yaml?: string;
      config?: string;
      composeFile?: string;
      services?: Array<{ name: string; description: string; ports: Array<{ host: string; container: string }> }>;
      error?: string;
      noProjectCompose?: boolean;
    }>;
    saveComposeSetup: (
      directory: string,
      composeYaml: string,
      composeFile: string,
    ) => Promise<{ success: boolean; error?: string }>;
  };
  stacks: {
    list: () => Promise<unknown[]>;
    get: (id: string) => Promise<unknown>;
    create: (opts: unknown) => Promise<unknown>;
    teardown: (id: string) => Promise<void>;
    stop: (id: string) => Promise<void>;
    start: (id: string) => Promise<void>;
    history: () => Promise<unknown[]>;
    setPr: (id: string, prUrl: string, prNumber: number) => Promise<void>;
    detectStale: () => Promise<unknown[]>;
    cleanupStale: (workspacePaths: string[]) => Promise<unknown[]>;
    getNeedsHumanQuestions: (stackId: string) => Promise<string | null>;
    resumeNeedsHuman: (stackId: string, answers: string) => Promise<void>;
    getFailureDiagnosis: (stackId: string) => Promise<unknown>;
    selfHealContinue: (stackId: string) => Promise<void>;
    restartWithFindings: (stackId: string, updatedTicketBody: string) => Promise<{ newStackId: string }>;
    recheckCompleted: (stackId: string) => Promise<{
      outcome: 'resuming_with_session' | 'resumed_fresh' | 'not_token_limited' | 'container_gone' | 'idle';
    }>;
  };
  tasks: {
    dispatch: (stackId: string, prompt: string, model?: string) => Promise<unknown>;
    list: (stackId: string) => Promise<unknown[]>;
    tokenSteps: (taskId: number) => Promise<unknown[]>;
    workflowProgress: (stackId: string) => Promise<unknown>;
  };
  diff: {
    get: (stackId: string) => Promise<string>;
  };
  push: {
    execute: (stackId: string, message?: string) => Promise<void>;
  };
  ports: {
    get: (stackId: string) => Promise<unknown[]>;
    expose: (stackId: string, service: string, containerPort: number) => Promise<number>;
    unexpose: (stackId: string, service: string, containerPort: number) => Promise<void>;
    cleanupLegacy: (directory: string) => Promise<{ success: boolean; error?: string }>;
  };
  logs: {
    stream: (containerId: string, runtime: string) => Promise<string>;
  };
  stats: {
    stackMemory: (stackId: string) => Promise<number>;
    stackDetailed: (stackId: string) => Promise<unknown>;
    taskMetrics: (stackId: string) => Promise<unknown>;
    tokenUsage: (stackId: string) => Promise<unknown>;
    globalTokenUsage: () => Promise<unknown>;
    rateLimit: () => Promise<unknown>;
    accountUsage: () => Promise<unknown>;
  };
  runtime: {
    available: () => Promise<{ docker: boolean; podman: boolean }>;
  };
  agent: {
    send: (tabId: string, message: string, projectDir?: string) => Promise<void>;
    cancel: (tabId: string) => Promise<void>;
    reset: (tabId: string) => Promise<void>;
    history: (tabId: string) => Promise<{ messages: Array<{ role: string; content: string }>; processing: boolean }>;
    tokenUsage: (tabId: string) => Promise<{
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    }>;
  };
  context: {
    get: (projectDir: string) => Promise<{ instructions: string; skills: string[]; settings: string }>;
    saveInstructions: (projectDir: string, content: string) => Promise<void>;
    listSkills: (projectDir: string) => Promise<string[]>;
    getSkill: (projectDir: string, name: string) => Promise<string>;
    saveSkill: (projectDir: string, name: string, content: string) => Promise<void>;
    deleteSkill: (projectDir: string, name: string) => Promise<void>;
    getSettings: (projectDir: string) => Promise<string>;
    saveSettings: (projectDir: string, content: string) => Promise<void>;
  };
  reviewPrompt: {
    getDefault: () => Promise<string>;
  };
  modelSettings: {
    getGlobal: () => Promise<{ inner_model: string; outer_model: string }>;
    setGlobal: (settings: { inner_model?: string; outer_model?: string }) => Promise<void>;
    getProject: (projectDir: string) => Promise<{ inner_model: string; outer_model: string } | null>;
    setProject: (projectDir: string, settings: { inner_model?: string; outer_model?: string }) => Promise<void>;
    removeProject: (projectDir: string) => Promise<void>;
    getEffective: (projectDir: string) => Promise<{ inner_model: string; outer_model: string }>;
  };
  backendSettings: {
    getGlobal: () => Promise<{ inner_backend: string; outer_backend: string; inner_provider: string | null; inner_model: string | null; outer_provider: string | null; outer_model: string | null }>;
    setGlobal: (settings: { inner_backend?: string; outer_backend?: string; inner_provider?: string | null; inner_model?: string | null; outer_provider?: string | null; outer_model?: string | null }) => Promise<void>;
    getProject: (projectDir: string) => Promise<{ inner_backend: string; outer_backend: string; inner_provider: string | null; inner_model: string | null; outer_provider: string | null; outer_model: string | null } | null>;
    setProject: (projectDir: string, settings: { inner_backend?: string; outer_backend?: string; inner_provider?: string | null; inner_model?: string | null; outer_provider?: string | null; outer_model?: string | null }) => Promise<void>;
    getEffective: (projectDir: string, surface: 'inner' | 'outer') => Promise<{ backend: 'claude' | 'opencode'; provider?: string; model?: string }>;
    setSecret: (key: string, surface: 'inner' | 'outer', name: string, value: string) => Promise<void>;
    secretStatus: (key: string, surface: 'inner' | 'outer') => Promise<{ set: boolean }>;
  };
  modelRouting: {
    getEffective: (projectDir: string) => Promise<Record<string, { backend: string; model: string }>>;
    getProject: (projectDir: string) => Promise<{ assignments: Record<string, { backend: string; model: string }>; preset: string | null } | null>;
    setProject: (projectDir: string, config: { assignments?: Record<string, { backend: string; model: string }>; preset?: string | null }) => Promise<void>;
    removeProject: (projectDir: string) => Promise<void>;
    getGlobal: () => Promise<{ assignments: Record<string, { backend: string; model: string }>; preset: string | null }>;
    setGlobal: (config: { assignments?: Record<string, { backend: string; model: string }>; preset?: string | null }) => Promise<void>;
    applyPreset: (projectDir: string, presetId: string) => Promise<void>;
    getAvailableModels: (projectDir: string) => Promise<Array<{ backend: string; model: string; label: string; version: string; provider: string; needsKey?: boolean; available: boolean }>>;
  };
  projectTicketConfig: {
    get: (projectDir: string) => Promise<{
      provider: 'github' | 'jira';
      jira_url?: string | null;
      jira_username?: string | null;
      jira_api_token?: string | null;
      jira_project_key?: string | null;
      jira_issue_type?: string | null;
      ticket_prefix?: string | null;
    } | null>;
    set: (projectDir: string, config: {
      provider: 'github' | 'jira';
      jira_url?: string | null;
      jira_username?: string | null;
      jira_api_token?: string | null;
      jira_project_key?: string | null;
      jira_issue_type?: string | null;
      ticket_prefix?: string | null;
    }) => Promise<void>;
  };
  session: {
    getState: () => Promise<unknown>;
    getSettings: () => Promise<unknown>;
    updateSettings: (settings: Record<string, unknown>) => Promise<void>;
    acknowledgeCritical: () => Promise<void>;
    haltAll: () => Promise<string[]>;
    resumeAll: () => Promise<string[]>;
    resumeStack: (stackId: string) => Promise<void>;
    resumeStackWithContinuation: (stackId: string, manual?: boolean) => Promise<{
      halted: boolean;
      resetAt?: string | null;
      outcome?: 'resuming_with_session' | 'resumed_fresh' | 'idle';
    }>;
    forcePoll: () => Promise<unknown>;
    reportActivity: () => void;
  };
  schedules: {
    list: (projectDir: string) => Promise<ScheduleEntry[]>;
    create: (projectDir: string, data: { label?: string; cronExpression: string; action: ScheduleAction; enabled?: boolean }) => Promise<ScheduleEntry>;
    update: (projectDir: string, id: string, patch: { label?: string; cronExpression?: string; action?: ScheduleAction; enabled?: boolean }) => Promise<ScheduleEntry>;
    delete: (projectDir: string, id: string) => Promise<void>;
    cronHealth: () => Promise<{ running: boolean }>;
    listBuiltInActions: () => Promise<BuiltInAction[]>;
    listScripts: (projectDir: string) => Promise<string[]>;
  };
  auth: {
    status: () => Promise<{ loggedIn: boolean; email?: string; expired: boolean; expiresAt?: number }>;
    login: () => Promise<{ success: boolean; error?: string }>;
  };
  docker: {
    status: () => Promise<{ connected: boolean }>;
  };
  tickets: {
    fetch: (ticketId: string, projectDir: string) => Promise<{ body: string; url: string | null }>;
    specCheck: (ticketId: string, projectDir: string) => Promise<unknown>;
    specRefine: (ticketId: string, projectDir: string, userAnswers: string) => Promise<unknown>;
    specCheckAsync: (ticketId: string, projectDir: string) => Promise<{ sessionId: string }>;
    specRefineAsync: (sessionId: string, ticketId: string, projectDir: string, userAnswers: string) => Promise<void>;
    retryRefinementAsync: (sessionId: string, ticketId: string, projectDir: string) => Promise<{ sessionId: string }>;
    postAnswers: (ticketId: string, projectDir: string, answersBody: string) => Promise<void>;
    cancelRefinement: (sessionId: string) => Promise<void>;
    listRefinements: () => Promise<unknown[]>;
    create: (projectDir: string, title: string, body: string) => Promise<{ url: string; ticketId: string }>;
    list: (projectDir: string) => Promise<{ tickets: unknown[]; error: unknown }>;
    fetchRaw: (ticketId: string, projectDir: string) => Promise<string | null>;
    update: (projectDir: string, ticketId: string, body: string) => Promise<void>;
    testJiraConnection: (params: {
      jiraUrl: string;
      jiraUsername: string;
      jiraApiToken: string;
      label?: string;
    }) => Promise<{
      auth: { ok: true; displayName: string } | { ok: false; status?: number; message: string };
      jql: { ok: true; count: number; hasMore: boolean } | { ok: false; status?: number; message: string } | null;
    }>;
    close: (ticketId: string, projectDir: string) => Promise<void>;
    markDone: (ticketId: string, projectDir: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  };
  ticketBoard: {
    setColumn: (ticketId: string, projectDir: string, column: string) => Promise<void>;
    delete: (ticketId: string, projectDir: string) => Promise<void>;
  };
  pr: {
    draftBody: (stackId: string) => Promise<{ title: string; body: string }>;
    create: (stackId: string, title: string, body: string) => Promise<{ url: string; number: number }>;
    merge: (stackId: string, prNumber: number) => Promise<{ status: 'merged' } | { status: 'conflict' } | { status: 'failed'; error: string }>;
    createAuto: (stackId: string) => Promise<
      | { status: 'created'; url: string; number: number }
      | { status: 'draft_failed' }
      | { status: 'create_failed'; draft: { title: string; body: string }; error: string }
    >;
    autoResolve: (ticketId: string, projectDir: string) => Promise<
      | { status: 'resolved' }
      | { status: 'no_conflicts' }
      | { status: 'unknown_state' }
      | { status: 'failed'; error: string }
    >;
  };
  darkFactory: {
    getEnabled: (projectDir: string) => Promise<boolean>;
    setEnabled: (projectDir: string, enabled: boolean) => Promise<void>;
  };
  telemetry: {
    summary: (range: { since: string; until: string }) => Promise<unknown>;
    daily: (range: { since: string; until: string }) => Promise<unknown[]>;
    byModel: (range: { since: string; until: string }) => Promise<unknown[]>;
    session: (range: { since: string; until: string }) => Promise<unknown[]>;
    byTicket: (range?: { since: string; until: string }) => Promise<ByTicketEntry[]>;
    refresh: () => Promise<{ ok: true }>;
  };
  on: (channel: string, callback: (...args: unknown[]) => void) => () => void;
}

const api: SandstormAPI = {
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    add: (directory) => ipcRenderer.invoke('projects:add', directory),
    remove: (id) => ipcRenderer.invoke('projects:remove', id),
    browse: () => ipcRenderer.invoke('projects:browse'),
    checkInit: (directory) => ipcRenderer.invoke('projects:checkInit', directory),
    initialize: (directory) => ipcRenderer.invoke('projects:initialize', directory),
    checkMigration: (directory) => ipcRenderer.invoke('projects:checkMigration', directory),
    autoDetectVerify: (directory) => ipcRenderer.invoke('projects:autoDetectVerify', directory),
    saveMigration: (directory: string, verifyScript: string, serviceDescriptions: Record<string, string>) =>
      ipcRenderer.invoke('projects:saveMigration', directory, verifyScript, serviceDescriptions),
    generateCompose: (directory: string) =>
      ipcRenderer.invoke('projects:generateCompose', directory),
    saveComposeSetup: (directory: string, composeYaml: string, composeFile: string) =>
      ipcRenderer.invoke('projects:saveComposeSetup', directory, composeYaml, composeFile),
  },
  stacks: {
    list: () => ipcRenderer.invoke('stacks:list'),
    get: (id) => ipcRenderer.invoke('stacks:get', id),
    create: (opts) => ipcRenderer.invoke('stacks:create', opts),
    teardown: (id) => ipcRenderer.invoke('stacks:teardown', id),
    stop: (id) => ipcRenderer.invoke('stacks:stop', id),
    start: (id) => ipcRenderer.invoke('stacks:start', id),
    history: () => ipcRenderer.invoke('stacks:history'),
    setPr: (id: string, prUrl: string, prNumber: number) =>
      ipcRenderer.invoke('stacks:setPr', id, prUrl, prNumber),
    detectStale: () => ipcRenderer.invoke('stacks:detectStale'),
    cleanupStale: (workspacePaths: string[]) =>
      ipcRenderer.invoke('stacks:cleanupStale', workspacePaths),
    getNeedsHumanQuestions: (stackId: string) =>
      ipcRenderer.invoke('stacks:getNeedsHumanQuestions', stackId),
    resumeNeedsHuman: (stackId: string, answers: string) =>
      ipcRenderer.invoke('stacks:resumeNeedsHuman', stackId, answers),
    getFailureDiagnosis: (stackId: string) =>
      ipcRenderer.invoke('stacks:getFailureDiagnosis', stackId),
    selfHealContinue: (stackId: string) =>
      ipcRenderer.invoke('stacks:selfHealContinue', stackId),
    restartWithFindings: (stackId: string, updatedTicketBody: string) =>
      ipcRenderer.invoke('stacks:restartWithFindings', stackId, updatedTicketBody),
    recheckCompleted: (stackId: string) =>
      ipcRenderer.invoke('stacks:recheckCompleted', stackId),
  },
  tasks: {
    dispatch: (stackId, prompt, model?) =>
      ipcRenderer.invoke('tasks:dispatch', stackId, prompt, model),
    list: (stackId) => ipcRenderer.invoke('tasks:list', stackId),
    tokenSteps: (taskId) => ipcRenderer.invoke('tasks:tokenSteps', taskId),
    workflowProgress: (stackId) => ipcRenderer.invoke('tasks:workflowProgress', stackId),
  },
  diff: {
    get: (stackId) => ipcRenderer.invoke('diff:get', stackId),
  },
  push: {
    execute: (stackId, message) =>
      ipcRenderer.invoke('push:execute', stackId, message),
  },
  ports: {
    get: (stackId) => ipcRenderer.invoke('ports:get', stackId),
    expose: (stackId, service, containerPort) =>
      ipcRenderer.invoke('stack:expose-port', stackId, service, containerPort),
    unexpose: (stackId, service, containerPort) =>
      ipcRenderer.invoke('stack:unexpose-port', stackId, service, containerPort),
    cleanupLegacy: (directory) =>
      ipcRenderer.invoke('ports:cleanupLegacy', directory),
  },
  logs: {
    stream: (containerId, runtime) =>
      ipcRenderer.invoke('logs:stream', containerId, runtime),
  },
  stats: {
    stackMemory: (stackId) => ipcRenderer.invoke('stats:stack-memory', stackId),
    stackDetailed: (stackId) => ipcRenderer.invoke('stats:stack-detailed', stackId),
    taskMetrics: (stackId) => ipcRenderer.invoke('stats:task-metrics', stackId),
    tokenUsage: (stackId) => ipcRenderer.invoke('stats:token-usage', stackId),
    globalTokenUsage: () => ipcRenderer.invoke('stats:global-token-usage'),
    rateLimit: () => ipcRenderer.invoke('stats:rate-limit'),
    accountUsage: () => ipcRenderer.invoke('stats:account-usage'),
  },
  runtime: {
    available: () => ipcRenderer.invoke('runtime:available'),
  },
  agent: {
    send: (tabId, message, projectDir) =>
      ipcRenderer.invoke('agent:send', tabId, message, projectDir),
    cancel: (tabId) => ipcRenderer.invoke('agent:cancel', tabId),
    reset: (tabId) => ipcRenderer.invoke('agent:reset', tabId),
    history: (tabId) => ipcRenderer.invoke('agent:history', tabId),
    tokenUsage: (tabId) => ipcRenderer.invoke('agent:tokenUsage', tabId),
  },
  context: {
    get: (projectDir) => ipcRenderer.invoke('context:get', projectDir),
    saveInstructions: (projectDir, content) =>
      ipcRenderer.invoke('context:saveInstructions', projectDir, content),
    listSkills: (projectDir) =>
      ipcRenderer.invoke('context:listSkills', projectDir),
    getSkill: (projectDir, name) =>
      ipcRenderer.invoke('context:getSkill', projectDir, name),
    saveSkill: (projectDir, name, content) =>
      ipcRenderer.invoke('context:saveSkill', projectDir, name, content),
    deleteSkill: (projectDir, name) =>
      ipcRenderer.invoke('context:deleteSkill', projectDir, name),
    getSettings: (projectDir) =>
      ipcRenderer.invoke('context:getSettings', projectDir),
    saveSettings: (projectDir, content) =>
      ipcRenderer.invoke('context:saveSettings', projectDir, content),
  },
  reviewPrompt: {
    getDefault: () => ipcRenderer.invoke('reviewPrompt:getDefault'),
  },
  modelSettings: {
    getGlobal: () => ipcRenderer.invoke('modelSettings:getGlobal'),
    setGlobal: (settings) => ipcRenderer.invoke('modelSettings:setGlobal', settings),
    getProject: (projectDir) => ipcRenderer.invoke('modelSettings:getProject', projectDir),
    setProject: (projectDir, settings) => ipcRenderer.invoke('modelSettings:setProject', projectDir, settings),
    removeProject: (projectDir) => ipcRenderer.invoke('modelSettings:removeProject', projectDir),
    getEffective: (projectDir) => ipcRenderer.invoke('modelSettings:getEffective', projectDir),
  },
  backendSettings: {
    getGlobal: () => ipcRenderer.invoke('backendSettings:getGlobal'),
    setGlobal: (settings) => ipcRenderer.invoke('backendSettings:setGlobal', settings),
    getProject: (projectDir) => ipcRenderer.invoke('backendSettings:getProject', projectDir),
    setProject: (projectDir, settings) => ipcRenderer.invoke('backendSettings:setProject', projectDir, settings),
    getEffective: (projectDir, surface) => ipcRenderer.invoke('backendSettings:getEffective', projectDir, surface),
    setSecret: (key, surface, name, value) => ipcRenderer.invoke('backendSettings:setSecret', key, surface, name, value),
    secretStatus: (key, surface) => ipcRenderer.invoke('backendSettings:secretStatus', key, surface),
  },
  modelRouting: {
    getEffective: (projectDir) => ipcRenderer.invoke('modelRouting:getEffective', projectDir),
    getProject: (projectDir) => ipcRenderer.invoke('modelRouting:getProject', projectDir),
    setProject: (projectDir, config) => ipcRenderer.invoke('modelRouting:setProject', projectDir, config),
    removeProject: (projectDir) => ipcRenderer.invoke('modelRouting:removeProject', projectDir),
    getGlobal: () => ipcRenderer.invoke('modelRouting:getGlobal'),
    setGlobal: (config) => ipcRenderer.invoke('modelRouting:setGlobal', config),
    applyPreset: (projectDir, presetId) => ipcRenderer.invoke('modelRouting:applyPreset', projectDir, presetId),
    getAvailableModels: (projectDir) => ipcRenderer.invoke('modelRouting:getAvailableModels', projectDir),
  },
  projectTicketConfig: {
    get: (projectDir) => ipcRenderer.invoke('projectTicketConfig:get', projectDir),
    set: (projectDir, config) => ipcRenderer.invoke('projectTicketConfig:set', projectDir, config),
  },
  session: {
    getState: () => ipcRenderer.invoke('session:getState'),
    getSettings: () => ipcRenderer.invoke('session:getSettings'),
    updateSettings: (settings) => ipcRenderer.invoke('session:updateSettings', settings),
    acknowledgeCritical: () => ipcRenderer.invoke('session:acknowledgeCritical'),
    haltAll: () => ipcRenderer.invoke('session:haltAll'),
    resumeAll: () => ipcRenderer.invoke('session:resumeAll'),
    resumeStack: (stackId) => ipcRenderer.invoke('session:resumeStack', stackId),
    resumeStackWithContinuation: (stackId, manual) =>
      ipcRenderer.invoke('session:resumeStackWithContinuation', stackId, manual),
    forcePoll: () => ipcRenderer.invoke('session:forcePoll'),
    reportActivity: () => { ipcRenderer.send('session:activity'); },
  },
  schedules: {
    list: (projectDir) => ipcRenderer.invoke('schedules:list', projectDir),
    create: (projectDir, data) => ipcRenderer.invoke('schedules:create', projectDir, data),
    update: (projectDir, id, patch) => ipcRenderer.invoke('schedules:update', projectDir, id, patch),
    delete: (projectDir, id) => ipcRenderer.invoke('schedules:delete', projectDir, id),
    cronHealth: () => ipcRenderer.invoke('schedules:cronHealth'),
    listBuiltInActions: () => ipcRenderer.invoke('scheduler:listBuiltInActions'),
    listScripts: (projectDir) => ipcRenderer.invoke('schedules:listScripts', projectDir),
  },
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    login: () => ipcRenderer.invoke('auth:login'),
  },
  docker: {
    status: () => ipcRenderer.invoke('docker:status'),
  },
  tickets: {
    fetch: (ticketId, projectDir) =>
      ipcRenderer.invoke('tickets:fetch', ticketId, projectDir),
    specCheck: (ticketId, projectDir) =>
      ipcRenderer.invoke('tickets:specCheck', ticketId, projectDir),
    specRefine: (ticketId, projectDir, userAnswers) =>
      ipcRenderer.invoke('tickets:specRefine', ticketId, projectDir, userAnswers),
    specCheckAsync: (ticketId, projectDir) =>
      ipcRenderer.invoke('tickets:specCheckAsync', ticketId, projectDir),
    specRefineAsync: (sessionId, ticketId, projectDir, userAnswers) =>
      ipcRenderer.invoke('tickets:specRefineAsync', sessionId, ticketId, projectDir, userAnswers),
    retryRefinementAsync: (sessionId, ticketId, projectDir) =>
      ipcRenderer.invoke('tickets:retryRefinementAsync', sessionId, ticketId, projectDir),
    postAnswers: (ticketId, projectDir, answersBody) =>
      ipcRenderer.invoke('tickets:postAnswers', ticketId, projectDir, answersBody),
    cancelRefinement: (sessionId) =>
      ipcRenderer.invoke('tickets:cancelRefinement', sessionId),
    listRefinements: () =>
      ipcRenderer.invoke('tickets:listRefinements'),
    create: (projectDir, title, body) =>
      ipcRenderer.invoke('tickets:create', projectDir, title, body),
    list: async (projectDir) => {
      const raw = await ipcRenderer.invoke('tickets:list', projectDir);
      if (Array.isArray(raw)) return { tickets: raw, error: null };
      return raw;
    },
    fetchRaw: (ticketId, projectDir) =>
      ipcRenderer.invoke('tickets:fetchRaw', ticketId, projectDir),
    update: (projectDir, ticketId, body) =>
      ipcRenderer.invoke('tickets:update', projectDir, ticketId, body),
    testJiraConnection: (params) =>
      ipcRenderer.invoke('tickets:testJiraConnection', params),
    close: (ticketId, projectDir) =>
      ipcRenderer.invoke('ticket:close', { ticketId, projectDir }),
    markDone: (ticketId, projectDir) =>
      ipcRenderer.invoke('ticket:mark-done', { ticketId, projectDir }),
  },
  ticketBoard: {
    setColumn: (ticketId, projectDir, column) =>
      ipcRenderer.invoke('ticket-board:set-column', ticketId, projectDir, column),
    delete: (ticketId, projectDir) =>
      ipcRenderer.invoke('ticket-board:delete', { ticketId, projectDir }),
  },
  pr: {
    draftBody: (stackId) => ipcRenderer.invoke('pr:draftBody', stackId),
    create: (stackId, title, body) =>
      ipcRenderer.invoke('pr:create', stackId, title, body),
    merge: (stackId, prNumber) =>
      ipcRenderer.invoke('pr:merge', stackId, prNumber),
    createAuto: (stackId) => ipcRenderer.invoke('pr:createAuto', stackId),
    autoResolve: (ticketId, projectDir) =>
      ipcRenderer.invoke('pr:autoResolve', ticketId, projectDir),
  },
  darkFactory: {
    getEnabled: (projectDir) => ipcRenderer.invoke('darkFactory:getEnabled', projectDir),
    setEnabled: (projectDir, enabled) => ipcRenderer.invoke('darkFactory:setEnabled', projectDir, enabled),
  },
  telemetry: {
    summary: (range) => ipcRenderer.invoke('stats:telemetry:summary', range),
    daily: (range) => ipcRenderer.invoke('stats:telemetry:daily', range),
    byModel: (range) => ipcRenderer.invoke('stats:telemetry:byModel', range),
    session: (range) => ipcRenderer.invoke('stats:telemetry:session', range),
    byTicket: (range) => ipcRenderer.invoke('stats:telemetry:byTicket', range),
    refresh: () => ipcRenderer.invoke('stats:telemetry:refresh'),
  },
  on: (channel, callback) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('sandstorm', api);
