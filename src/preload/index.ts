import { contextBridge, ipcRenderer } from 'electron';
import { INVOKE_CHANNELS, type EventChannel } from '../main/ipc-channels';
import type { ByTicketEntry, ByEpicEntry } from '@main/telemetry/types';
import type { CatalogProviderList } from '../shared/opencode-providers';

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
    askClarifyingQuestions: (stackId: string) => Promise<void>;
    selfHealContinue: (stackId: string) => Promise<void>;
    restartWithFindings: (stackId: string, updatedTicketBody: string) => Promise<{ newStackId: string }>;
    recheckCompleted: (stackId: string) => Promise<{
      outcome: 'resuming_with_session' | 'resumed_fresh' | 'not_token_limited' | 'container_gone' | 'idle';
    }>;
    reconcileStatus: (stackId: string) => Promise<{
      outcome: 'reconciled' | 'container_gone' | 'guarded';
      status?: string;
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
    setSecret: (scope: 'global' | string, surface: 'inner' | 'outer', name: string, value: string) => Promise<void>;
    secretStatus: (scope: 'global' | string, surface: 'inner' | 'outer') => Promise<{ set: boolean }>;
    setSecretBundle: (scope: 'global' | string, surface: 'inner' | 'outer', bundle: Record<string, string>) => Promise<void>;
    getSecretBundle: (scope: 'global' | string, surface: 'inner' | 'outer') => Promise<Record<string, string> | null>;
  };
  providerSecrets: {
    get: (scope: 'global' | string, provider: string) => Promise<Record<string, string> | null>;
    set: (scope: 'global' | string, provider: string, bundle: Record<string, string>) => Promise<void>;
    remove: (scope: 'global' | string, provider: string) => Promise<void>;
    status: (scope: 'global' | string, provider: string) => Promise<{ set: boolean }>;
    getBundle: (scope: 'global' | string, provider: string) => Promise<Record<string, string> | null>;
    setBundle: (scope: 'global' | string, provider: string, bundle: Record<string, string>) => Promise<void>;
  };
  providers: {
    catalog: () => Promise<CatalogProviderList | null>;
    configured: (scope: string) => Promise<string[]>;
  };
  modelRouting: {
    getEffective: (projectDir: string) => Promise<Record<string, { backend: string; provider: string; model: string }>>;
    getProject: (projectDir: string) => Promise<{ assignments: Record<string, { backend: string; provider: string; model: string }>; preset: string | null } | null>;
    setProject: (projectDir: string, config: { assignments?: Record<string, { backend: string; provider: string; model: string }>; preset?: string | null }) => Promise<void>;
    removeProject: (projectDir: string) => Promise<void>;
    getGlobal: () => Promise<{ assignments: Record<string, { backend: string; provider: string; model: string }>; preset: string | null }>;
    setGlobal: (config: { assignments?: Record<string, { backend: string; provider: string; model: string }>; preset?: string | null }) => Promise<void>;
    applyPreset: (projectDir: string, presetId: string) => Promise<void>;
    getAvailableModels: (projectDir: string) => Promise<Array<{ backend: string; model: string; label: string; version: string; provider: string; needsKey?: boolean; available: boolean }>>;
    getAvailableModelsWithCatalog: (projectDir: string) => Promise<Array<{ backend: string; model: string; label: string; version: string; provider: string; needsKey?: boolean; available: boolean }>>;
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
      jiraProjectKey?: string | null;
      filterMode?: 'assisted' | 'advanced' | null;
      filterOwnership?: 'created' | 'assigned' | null;
      filterOpenOnly?: boolean | null;
      filterQuery?: string | null;
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
    getConfig: (projectDir: string) => Promise<{ level: string; merge_strategy: string }>;
    setConfig: (projectDir: string, config: { level: string; merge_strategy: string }) => Promise<void>;
  };
  telemetry: {
    summary: (range: { since: string; until: string }) => Promise<unknown>;
    daily: (range: { since: string; until: string }) => Promise<unknown[]>;
    byModel: (range: { since: string; until: string }) => Promise<unknown[]>;
    session: (range: { since: string; until: string }) => Promise<unknown[]>;
    byTicket: (range?: { since: string; until: string }) => Promise<ByTicketEntry[]>;
    byEpic: (range?: { since: string; until: string }) => Promise<ByEpicEntry[]>;
    refresh: () => Promise<{ ok: true }>;
  };
  epic: {
    start: (epicId: string, projectDir: string) => Promise<unknown>;
    getRunPlan: (epicId: string, projectDir: string) => Promise<unknown>;
  };
  on: (channel: EventChannel, callback: (...args: unknown[]) => void) => () => void;
}

const api: SandstormAPI = {
  projects: {
    list: () => ipcRenderer.invoke(INVOKE_CHANNELS.PROJECTS_LIST),
    add: (directory) => ipcRenderer.invoke(INVOKE_CHANNELS.PROJECTS_ADD, directory),
    remove: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.PROJECTS_REMOVE, id),
    browse: () => ipcRenderer.invoke(INVOKE_CHANNELS.PROJECTS_BROWSE),
    checkInit: (directory) => ipcRenderer.invoke(INVOKE_CHANNELS.PROJECTS_CHECK_INIT, directory),
    initialize: (directory) => ipcRenderer.invoke(INVOKE_CHANNELS.PROJECTS_INITIALIZE, directory),
    checkMigration: (directory) => ipcRenderer.invoke(INVOKE_CHANNELS.PROJECTS_CHECK_MIGRATION, directory),
    autoDetectVerify: (directory) => ipcRenderer.invoke(INVOKE_CHANNELS.PROJECTS_AUTO_DETECT_VERIFY, directory),
    saveMigration: (directory: string, verifyScript: string, serviceDescriptions: Record<string, string>) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.PROJECTS_SAVE_MIGRATION, directory, verifyScript, serviceDescriptions),
    generateCompose: (directory: string) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.PROJECTS_GENERATE_COMPOSE, directory),
    saveComposeSetup: (directory: string, composeYaml: string, composeFile: string) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.PROJECTS_SAVE_COMPOSE_SETUP, directory, composeYaml, composeFile),
  },
  stacks: {
    list: () => ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_LIST),
    get: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_GET, id),
    create: (opts) => ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_CREATE, opts),
    teardown: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_TEARDOWN, id),
    stop: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_STOP, id),
    start: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_START, id),
    history: () => ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_HISTORY),
    setPr: (id: string, prUrl: string, prNumber: number) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_SET_PR, id, prUrl, prNumber),
    detectStale: () => ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_DETECT_STALE),
    cleanupStale: (workspacePaths: string[]) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_CLEANUP_STALE, workspacePaths),
    getNeedsHumanQuestions: (stackId: string) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_GET_NEEDS_HUMAN_QUESTIONS, stackId),
    resumeNeedsHuman: (stackId: string, answers: string) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_RESUME_NEEDS_HUMAN, stackId, answers),
    askClarifyingQuestions: (stackId: string) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_ASK_CLARIFYING_QUESTIONS, stackId),
    selfHealContinue: (stackId: string) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_SELF_HEAL_CONTINUE, stackId),
    restartWithFindings: (stackId: string, updatedTicketBody: string) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_RESTART_WITH_FINDINGS, stackId, updatedTicketBody),
    recheckCompleted: (stackId: string) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_RECHECK_COMPLETED, stackId),
    reconcileStatus: (stackId: string) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.STACKS_RECONCILE_STATUS, stackId),
  },
  tasks: {
    dispatch: (stackId, prompt, model?) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TASKS_DISPATCH, stackId, prompt, model),
    list: (stackId) => ipcRenderer.invoke(INVOKE_CHANNELS.TASKS_LIST, stackId),
    tokenSteps: (taskId) => ipcRenderer.invoke(INVOKE_CHANNELS.TASKS_TOKEN_STEPS, taskId),
    workflowProgress: (stackId) => ipcRenderer.invoke(INVOKE_CHANNELS.TASKS_WORKFLOW_PROGRESS, stackId),
  },
  diff: {
    get: (stackId) => ipcRenderer.invoke(INVOKE_CHANNELS.DIFF_GET, stackId),
  },
  push: {
    execute: (stackId, message) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.PUSH_EXECUTE, stackId, message),
  },
  ports: {
    get: (stackId) => ipcRenderer.invoke(INVOKE_CHANNELS.PORTS_GET, stackId),
    expose: (stackId, service, containerPort) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.STACK_EXPOSE_PORT, stackId, service, containerPort),
    unexpose: (stackId, service, containerPort) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.STACK_UNEXPOSE_PORT, stackId, service, containerPort),
    cleanupLegacy: (directory) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.PORTS_CLEANUP_LEGACY, directory),
  },
  logs: {
    stream: (containerId, runtime) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.LOGS_STREAM, containerId, runtime),
  },
  stats: {
    stackMemory: (stackId) => ipcRenderer.invoke(INVOKE_CHANNELS.STATS_STACK_MEMORY, stackId),
    stackDetailed: (stackId) => ipcRenderer.invoke(INVOKE_CHANNELS.STATS_STACK_DETAILED, stackId),
    taskMetrics: (stackId) => ipcRenderer.invoke(INVOKE_CHANNELS.STATS_TASK_METRICS, stackId),
    tokenUsage: (stackId) => ipcRenderer.invoke(INVOKE_CHANNELS.STATS_TOKEN_USAGE, stackId),
    globalTokenUsage: () => ipcRenderer.invoke(INVOKE_CHANNELS.STATS_GLOBAL_TOKEN_USAGE),
    rateLimit: () => ipcRenderer.invoke(INVOKE_CHANNELS.STATS_RATE_LIMIT),
    accountUsage: () => ipcRenderer.invoke(INVOKE_CHANNELS.STATS_ACCOUNT_USAGE),
  },
  runtime: {
    available: () => ipcRenderer.invoke(INVOKE_CHANNELS.RUNTIME_AVAILABLE),
  },
  agent: {
    send: (tabId, message, projectDir) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.AGENT_SEND, tabId, message, projectDir),
    cancel: (tabId) => ipcRenderer.invoke(INVOKE_CHANNELS.AGENT_CANCEL, tabId),
    reset: (tabId) => ipcRenderer.invoke(INVOKE_CHANNELS.AGENT_RESET, tabId),
    history: (tabId) => ipcRenderer.invoke(INVOKE_CHANNELS.AGENT_HISTORY, tabId),
    tokenUsage: (tabId) => ipcRenderer.invoke(INVOKE_CHANNELS.AGENT_TOKEN_USAGE, tabId),
  },
  context: {
    get: (projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.CONTEXT_GET, projectDir),
    saveInstructions: (projectDir, content) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.CONTEXT_SAVE_INSTRUCTIONS, projectDir, content),
    listSkills: (projectDir) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.CONTEXT_LIST_SKILLS, projectDir),
    getSkill: (projectDir, name) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.CONTEXT_GET_SKILL, projectDir, name),
    saveSkill: (projectDir, name, content) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.CONTEXT_SAVE_SKILL, projectDir, name, content),
    deleteSkill: (projectDir, name) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.CONTEXT_DELETE_SKILL, projectDir, name),
    getSettings: (projectDir) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.CONTEXT_GET_SETTINGS, projectDir),
    saveSettings: (projectDir, content) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.CONTEXT_SAVE_SETTINGS, projectDir, content),
  },
  reviewPrompt: {
    getDefault: () => ipcRenderer.invoke(INVOKE_CHANNELS.REVIEW_PROMPT_GET_DEFAULT),
  },
  modelSettings: {
    getGlobal: () => ipcRenderer.invoke(INVOKE_CHANNELS.MODEL_SETTINGS_GET_GLOBAL),
    setGlobal: (settings) => ipcRenderer.invoke(INVOKE_CHANNELS.MODEL_SETTINGS_SET_GLOBAL, settings),
    getProject: (projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.MODEL_SETTINGS_GET_PROJECT, projectDir),
    setProject: (projectDir, settings) => ipcRenderer.invoke(INVOKE_CHANNELS.MODEL_SETTINGS_SET_PROJECT, projectDir, settings),
    removeProject: (projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.MODEL_SETTINGS_REMOVE_PROJECT, projectDir),
    getEffective: (projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.MODEL_SETTINGS_GET_EFFECTIVE, projectDir),
  },
  backendSettings: {
    getGlobal: () => ipcRenderer.invoke(INVOKE_CHANNELS.BACKEND_SETTINGS_GET_GLOBAL),
    setGlobal: (settings) => ipcRenderer.invoke(INVOKE_CHANNELS.BACKEND_SETTINGS_SET_GLOBAL, settings),
    getProject: (projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.BACKEND_SETTINGS_GET_PROJECT, projectDir),
    setProject: (projectDir, settings) => ipcRenderer.invoke(INVOKE_CHANNELS.BACKEND_SETTINGS_SET_PROJECT, projectDir, settings),
    getEffective: (projectDir, surface) => ipcRenderer.invoke(INVOKE_CHANNELS.BACKEND_SETTINGS_GET_EFFECTIVE, projectDir, surface),
    setSecret: (scope, surface, name, value) => ipcRenderer.invoke(INVOKE_CHANNELS.BACKEND_SETTINGS_SET_SECRET, scope, surface, name, value),
    secretStatus: (scope, surface) => ipcRenderer.invoke(INVOKE_CHANNELS.BACKEND_SETTINGS_SECRET_STATUS, scope, surface),
    setSecretBundle: (scope, surface, bundle) => ipcRenderer.invoke(INVOKE_CHANNELS.BACKEND_SETTINGS_SET_SECRET_BUNDLE, scope, surface, bundle),
    getSecretBundle: (scope, surface) => ipcRenderer.invoke(INVOKE_CHANNELS.BACKEND_SETTINGS_GET_SECRET_BUNDLE, scope, surface),
  },
  providerSecrets: {
    get: (scope, provider) => ipcRenderer.invoke(INVOKE_CHANNELS.PROVIDER_SECRETS_GET, scope, provider),
    set: (scope, provider, bundle) => ipcRenderer.invoke(INVOKE_CHANNELS.PROVIDER_SECRETS_SET, scope, provider, bundle),
    remove: (scope, provider) => ipcRenderer.invoke(INVOKE_CHANNELS.PROVIDER_SECRETS_REMOVE, scope, provider),
    status: (scope, provider) => ipcRenderer.invoke(INVOKE_CHANNELS.PROVIDER_SECRETS_STATUS, scope, provider),
    getBundle: (scope, provider) => ipcRenderer.invoke(INVOKE_CHANNELS.PROVIDER_SECRETS_GET_BUNDLE, scope, provider),
    setBundle: (scope, provider, bundle) => ipcRenderer.invoke(INVOKE_CHANNELS.PROVIDER_SECRETS_SET_BUNDLE, scope, provider, bundle),
  },
  providers: {
    catalog: () => ipcRenderer.invoke(INVOKE_CHANNELS.PROVIDERS_CATALOG),
    configured: (scope) => ipcRenderer.invoke(INVOKE_CHANNELS.PROVIDERS_CONFIGURED, scope),
  },
  modelRouting: {
    getEffective: (projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.MODEL_ROUTING_GET_EFFECTIVE, projectDir),
    getProject: (projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.MODEL_ROUTING_GET_PROJECT, projectDir),
    setProject: (projectDir, config) => ipcRenderer.invoke(INVOKE_CHANNELS.MODEL_ROUTING_SET_PROJECT, projectDir, config),
    removeProject: (projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.MODEL_ROUTING_REMOVE_PROJECT, projectDir),
    getGlobal: () => ipcRenderer.invoke(INVOKE_CHANNELS.MODEL_ROUTING_GET_GLOBAL),
    setGlobal: (config) => ipcRenderer.invoke(INVOKE_CHANNELS.MODEL_ROUTING_SET_GLOBAL, config),
    applyPreset: (projectDir, presetId) => ipcRenderer.invoke(INVOKE_CHANNELS.MODEL_ROUTING_APPLY_PRESET, projectDir, presetId),
    getAvailableModels: (projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.MODEL_ROUTING_GET_AVAILABLE_MODELS, projectDir),
    getAvailableModelsWithCatalog: (projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.MODEL_ROUTING_GET_AVAILABLE_MODELS_WITH_CATALOG, projectDir),
  },
  projectTicketConfig: {
    get: (projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.PROJECT_TICKET_CONFIG_GET, projectDir),
    set: (projectDir, config) => ipcRenderer.invoke(INVOKE_CHANNELS.PROJECT_TICKET_CONFIG_SET, projectDir, config),
  },
  session: {
    getState: () => ipcRenderer.invoke(INVOKE_CHANNELS.SESSION_GET_STATE),
    getSettings: () => ipcRenderer.invoke(INVOKE_CHANNELS.SESSION_GET_SETTINGS),
    updateSettings: (settings) => ipcRenderer.invoke(INVOKE_CHANNELS.SESSION_UPDATE_SETTINGS, settings),
    acknowledgeCritical: () => ipcRenderer.invoke(INVOKE_CHANNELS.SESSION_ACKNOWLEDGE_CRITICAL),
    haltAll: () => ipcRenderer.invoke(INVOKE_CHANNELS.SESSION_HALT_ALL),
    resumeAll: () => ipcRenderer.invoke(INVOKE_CHANNELS.SESSION_RESUME_ALL),
    resumeStack: (stackId) => ipcRenderer.invoke(INVOKE_CHANNELS.SESSION_RESUME_STACK, stackId),
    resumeStackWithContinuation: (stackId, manual) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.SESSION_RESUME_STACK_WITH_CONTINUATION, stackId, manual),
    forcePoll: () => ipcRenderer.invoke(INVOKE_CHANNELS.SESSION_FORCE_POLL),
    reportActivity: () => { ipcRenderer.send(INVOKE_CHANNELS.SESSION_ACTIVITY); },
  },
  schedules: {
    list: (projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.SCHEDULES_LIST, projectDir),
    create: (projectDir, data) => ipcRenderer.invoke(INVOKE_CHANNELS.SCHEDULES_CREATE, projectDir, data),
    update: (projectDir, id, patch) => ipcRenderer.invoke(INVOKE_CHANNELS.SCHEDULES_UPDATE, projectDir, id, patch),
    delete: (projectDir, id) => ipcRenderer.invoke(INVOKE_CHANNELS.SCHEDULES_DELETE, projectDir, id),
    cronHealth: () => ipcRenderer.invoke(INVOKE_CHANNELS.SCHEDULES_CRON_HEALTH),
    listBuiltInActions: () => ipcRenderer.invoke(INVOKE_CHANNELS.SCHEDULER_LIST_BUILT_IN_ACTIONS),
    listScripts: (projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.SCHEDULES_LIST_SCRIPTS, projectDir),
  },
  auth: {
    status: () => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_STATUS),
    login: () => ipcRenderer.invoke(INVOKE_CHANNELS.AUTH_LOGIN),
  },
  docker: {
    status: () => ipcRenderer.invoke(INVOKE_CHANNELS.DOCKER_STATUS),
  },
  tickets: {
    fetch: (ticketId, projectDir) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKETS_FETCH, ticketId, projectDir),
    specCheck: (ticketId, projectDir) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKETS_SPEC_CHECK, ticketId, projectDir),
    specRefine: (ticketId, projectDir, userAnswers) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKETS_SPEC_REFINE, ticketId, projectDir, userAnswers),
    specCheckAsync: (ticketId, projectDir) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKETS_SPEC_CHECK_ASYNC, ticketId, projectDir),
    specRefineAsync: (sessionId, ticketId, projectDir, userAnswers) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKETS_SPEC_REFINE_ASYNC, sessionId, ticketId, projectDir, userAnswers),
    retryRefinementAsync: (sessionId, ticketId, projectDir) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKETS_RETRY_REFINEMENT_ASYNC, sessionId, ticketId, projectDir),
    postAnswers: (ticketId, projectDir, answersBody) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKETS_POST_ANSWERS, ticketId, projectDir, answersBody),
    cancelRefinement: (sessionId) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKETS_CANCEL_REFINEMENT, sessionId),
    listRefinements: () =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKETS_LIST_REFINEMENTS),
    create: (projectDir, title, body) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKETS_CREATE, projectDir, title, body),
    list: async (projectDir) => {
      const raw = await ipcRenderer.invoke(INVOKE_CHANNELS.TICKETS_LIST, projectDir);
      if (Array.isArray(raw)) return { tickets: raw, error: null };
      return raw;
    },
    fetchRaw: (ticketId, projectDir) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKETS_FETCH_RAW, ticketId, projectDir),
    update: (projectDir, ticketId, body) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKETS_UPDATE, projectDir, ticketId, body),
    testJiraConnection: (params) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKETS_TEST_JIRA_CONNECTION, params),
    close: (ticketId, projectDir) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKET_CLOSE, { ticketId, projectDir }),
    markDone: (ticketId, projectDir) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKET_MARK_DONE, { ticketId, projectDir }),
  },
  ticketBoard: {
    setColumn: (ticketId, projectDir, column) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKET_BOARD_SET_COLUMN, ticketId, projectDir, column),
    delete: (ticketId, projectDir) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.TICKET_BOARD_DELETE, { ticketId, projectDir }),
  },
  pr: {
    draftBody: (stackId) => ipcRenderer.invoke(INVOKE_CHANNELS.PR_DRAFT_BODY, stackId),
    create: (stackId, title, body) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.PR_CREATE, stackId, title, body),
    merge: (stackId, prNumber) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.PR_MERGE, stackId, prNumber),
    createAuto: (stackId) => ipcRenderer.invoke(INVOKE_CHANNELS.PR_CREATE_AUTO, stackId),
    autoResolve: (ticketId, projectDir) =>
      ipcRenderer.invoke(INVOKE_CHANNELS.PR_AUTO_RESOLVE, ticketId, projectDir),
  },
  darkFactory: {
    getEnabled: (projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.DARK_FACTORY_GET_ENABLED, projectDir),
    setEnabled: (projectDir, enabled) => ipcRenderer.invoke(INVOKE_CHANNELS.DARK_FACTORY_SET_ENABLED, projectDir, enabled),
    getConfig: (projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.DARK_FACTORY_GET_CONFIG, projectDir),
    setConfig: (projectDir, config) => ipcRenderer.invoke(INVOKE_CHANNELS.DARK_FACTORY_SET_CONFIG, projectDir, config),
  },
  telemetry: {
    summary: (range) => ipcRenderer.invoke(INVOKE_CHANNELS.STATS_TELEMETRY_SUMMARY, range),
    daily: (range) => ipcRenderer.invoke(INVOKE_CHANNELS.STATS_TELEMETRY_DAILY, range),
    byModel: (range) => ipcRenderer.invoke(INVOKE_CHANNELS.STATS_TELEMETRY_BY_MODEL, range),
    session: (range) => ipcRenderer.invoke(INVOKE_CHANNELS.STATS_TELEMETRY_SESSION, range),
    byTicket: (range) => ipcRenderer.invoke(INVOKE_CHANNELS.STATS_TELEMETRY_BY_TICKET, range),
    byEpic: (range) => ipcRenderer.invoke(INVOKE_CHANNELS.STATS_TELEMETRY_BY_EPIC, range),
    refresh: () => ipcRenderer.invoke(INVOKE_CHANNELS.STATS_TELEMETRY_REFRESH),
  },
  epic: {
    start: (epicId, projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.EPIC_START, epicId, projectDir),
    getRunPlan: (epicId, projectDir) => ipcRenderer.invoke(INVOKE_CHANNELS.EPIC_GET_RUN_PLAN, epicId, projectDir),
  },
  on: (channel: EventChannel, callback: (...args: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('sandstorm', api);
