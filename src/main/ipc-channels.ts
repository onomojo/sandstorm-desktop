// Single source of truth for all IPC channel names.
// Import INVOKE_CHANNELS for ipcMain.handle / ipcRenderer.invoke channels,
// EVENT_CHANNELS for static push events (webContents.send / sandstorm.on),
// and the AGENT_* builders for per-tab dynamic agent event channels.

export const INVOKE_CHANNELS = {
  // --- Agent (request/response) ---
  AGENT_SEND: 'agent:send',
  AGENT_CANCEL: 'agent:cancel',
  AGENT_RESET: 'agent:reset',
  AGENT_HISTORY: 'agent:history',
  AGENT_TOKEN_USAGE: 'agent:tokenUsage',
  SESSION_ACTIVITY: 'session:activity',

  // --- Projects ---
  PROJECTS_LIST: 'projects:list',
  PROJECTS_ADD: 'projects:add',
  PROJECTS_REMOVE: 'projects:remove',
  PROJECTS_BROWSE: 'projects:browse',
  PROJECTS_CHECK_INIT: 'projects:checkInit',
  PROJECTS_INITIALIZE: 'projects:initialize',
  PROJECTS_CHECK_MIGRATION: 'projects:checkMigration',
  PROJECTS_AUTO_DETECT_VERIFY: 'projects:autoDetectVerify',
  PROJECTS_SAVE_MIGRATION: 'projects:saveMigration',
  PROJECTS_GENERATE_COMPOSE: 'projects:generateCompose',
  PROJECTS_SAVE_COMPOSE_SETUP: 'projects:saveComposeSetup',
  PROJECT_TICKET_CONFIG_GET: 'projectTicketConfig:get',
  PROJECT_TICKET_CONFIG_SET: 'projectTicketConfig:set',

  // --- Stacks ---
  STACKS_LIST: 'stacks:list',
  STACKS_GET: 'stacks:get',
  STACKS_CREATE: 'stacks:create',
  STACKS_TEARDOWN: 'stacks:teardown',
  STACKS_STOP: 'stacks:stop',
  STACKS_START: 'stacks:start',
  STACKS_HISTORY: 'stacks:history',
  STACKS_SET_PR: 'stacks:setPr',
  STACKS_DETECT_STALE: 'stacks:detectStale',
  STACKS_CLEANUP_STALE: 'stacks:cleanupStale',
  STACKS_GET_NEEDS_HUMAN_QUESTIONS: 'stacks:getNeedsHumanQuestions',
  STACKS_RESUME_NEEDS_HUMAN: 'stacks:resumeNeedsHuman',
  STACKS_ASK_CLARIFYING_QUESTIONS: 'stacks:askClarifyingQuestions',
  STACKS_SELF_HEAL_CONTINUE: 'stacks:selfHealContinue',
  STACKS_RESTART_WITH_FINDINGS: 'stacks:restartWithFindings',
  STACKS_RECHECK_COMPLETED: 'stacks:recheckCompleted',
  STACKS_RECONCILE_STATUS: 'stacks:reconcileStatus',

  // --- Tasks ---
  TASKS_DISPATCH: 'tasks:dispatch',
  TASKS_LIST: 'tasks:list',
  TASKS_TOKEN_STEPS: 'tasks:tokenSteps',
  TASKS_WORKFLOW_PROGRESS: 'tasks:workflowProgress',

  // --- Diff ---
  DIFF_GET: 'diff:get',

  // --- Push ---
  PUSH_EXECUTE: 'push:execute',

  // --- Ports ---
  PORTS_GET: 'ports:get',
  STACK_EXPOSE_PORT: 'stack:expose-port',
  STACK_UNEXPOSE_PORT: 'stack:unexpose-port',
  PORTS_CLEANUP_LEGACY: 'ports:cleanupLegacy',

  // --- Logs ---
  LOGS_STREAM: 'logs:stream',

  // --- Stats ---
  STATS_STACK_MEMORY: 'stats:stack-memory',
  STATS_STACK_DETAILED: 'stats:stack-detailed',
  STATS_TASK_METRICS: 'stats:task-metrics',
  STATS_TOKEN_USAGE: 'stats:token-usage',
  STATS_GLOBAL_TOKEN_USAGE: 'stats:global-token-usage',
  STATS_RATE_LIMIT: 'stats:rate-limit',
  STATS_ACCOUNT_USAGE: 'stats:account-usage',
  STATS_TELEMETRY_SUMMARY: 'stats:telemetry:summary',
  STATS_TELEMETRY_DAILY: 'stats:telemetry:daily',
  STATS_TELEMETRY_BY_MODEL: 'stats:telemetry:byModel',
  STATS_TELEMETRY_SESSION: 'stats:telemetry:session',
  STATS_TELEMETRY_BY_TICKET: 'stats:telemetry:byTicket',
  STATS_TELEMETRY_BY_EPIC: 'stats:telemetry:byEpic',
  STATS_TELEMETRY_REFRESH: 'stats:telemetry:refresh',

  // --- Context ---
  CONTEXT_GET: 'context:get',
  CONTEXT_SAVE_INSTRUCTIONS: 'context:saveInstructions',
  CONTEXT_LIST_SKILLS: 'context:listSkills',
  CONTEXT_GET_SKILL: 'context:getSkill',
  CONTEXT_SAVE_SKILL: 'context:saveSkill',
  CONTEXT_DELETE_SKILL: 'context:deleteSkill',
  CONTEXT_GET_SETTINGS: 'context:getSettings',
  CONTEXT_SAVE_SETTINGS: 'context:saveSettings',

  // --- Review Prompt ---
  REVIEW_PROMPT_GET_DEFAULT: 'reviewPrompt:getDefault',

  // --- Runtime ---
  RUNTIME_AVAILABLE: 'runtime:available',

  // --- Model Settings ---
  MODEL_SETTINGS_GET_GLOBAL: 'modelSettings:getGlobal',
  MODEL_SETTINGS_SET_GLOBAL: 'modelSettings:setGlobal',
  MODEL_SETTINGS_GET_PROJECT: 'modelSettings:getProject',
  MODEL_SETTINGS_SET_PROJECT: 'modelSettings:setProject',
  MODEL_SETTINGS_REMOVE_PROJECT: 'modelSettings:removeProject',
  MODEL_SETTINGS_GET_EFFECTIVE: 'modelSettings:getEffective',

  // --- Backend Settings ---
  BACKEND_SETTINGS_GET_GLOBAL: 'backendSettings:getGlobal',
  BACKEND_SETTINGS_SET_GLOBAL: 'backendSettings:setGlobal',
  BACKEND_SETTINGS_GET_PROJECT: 'backendSettings:getProject',
  BACKEND_SETTINGS_SET_PROJECT: 'backendSettings:setProject',
  BACKEND_SETTINGS_GET_EFFECTIVE: 'backendSettings:getEffective',
  BACKEND_SETTINGS_SET_SECRET: 'backendSettings:setSecret',
  BACKEND_SETTINGS_SECRET_STATUS: 'backendSettings:secretStatus',
  BACKEND_SETTINGS_SET_SECRET_BUNDLE: 'backendSettings:setSecretBundle',
  BACKEND_SETTINGS_GET_SECRET_BUNDLE: 'backendSettings:getSecretBundle',

  // --- Model Routing ---
  MODEL_ROUTING_GET_EFFECTIVE: 'modelRouting:getEffective',
  MODEL_ROUTING_GET_PROJECT: 'modelRouting:getProject',
  MODEL_ROUTING_SET_PROJECT: 'modelRouting:setProject',
  MODEL_ROUTING_REMOVE_PROJECT: 'modelRouting:removeProject',
  MODEL_ROUTING_GET_GLOBAL: 'modelRouting:getGlobal',
  MODEL_ROUTING_SET_GLOBAL: 'modelRouting:setGlobal',
  MODEL_ROUTING_APPLY_PRESET: 'modelRouting:applyPreset',
  MODEL_ROUTING_GET_AVAILABLE_MODELS: 'modelRouting:getAvailableModels',
  MODEL_ROUTING_GET_AVAILABLE_MODELS_WITH_CATALOG: 'modelRouting:getAvailableModelsWithCatalog',

  // --- Provider Secrets ---
  PROVIDER_SECRETS_STATUS: 'providerSecrets:status',
  PROVIDER_SECRETS_GET: 'providerSecrets:get',
  PROVIDER_SECRETS_GET_BUNDLE: 'providerSecrets:getBundle',
  PROVIDER_SECRETS_SET: 'providerSecrets:set',
  PROVIDER_SECRETS_SET_BUNDLE: 'providerSecrets:setBundle',
  PROVIDER_SECRETS_REMOVE: 'providerSecrets:remove',

  // --- Providers ---
  PROVIDERS_CATALOG: 'providers:catalog',
  PROVIDERS_CONFIGURED: 'providers:configured',

  // --- Session ---
  SESSION_GET_STATE: 'session:getState',
  SESSION_GET_SETTINGS: 'session:getSettings',
  SESSION_UPDATE_SETTINGS: 'session:updateSettings',
  SESSION_ACKNOWLEDGE_CRITICAL: 'session:acknowledgeCritical',
  SESSION_HALT_ALL: 'session:haltAll',
  SESSION_RESUME_ALL: 'session:resumeAll',
  SESSION_RESUME_STACK: 'session:resumeStack',
  SESSION_RESUME_STACK_WITH_CONTINUATION: 'session:resumeStackWithContinuation',
  SESSION_FORCE_POLL: 'session:forcePoll',

  // --- Docker ---
  DOCKER_STATUS: 'docker:status',

  // --- Auth ---
  AUTH_STATUS: 'auth:status',
  AUTH_LOGIN: 'auth:login',

  // --- Schedules ---
  SCHEDULES_LIST: 'schedules:list',
  SCHEDULES_CREATE: 'schedules:create',
  SCHEDULES_UPDATE: 'schedules:update',
  SCHEDULES_DELETE: 'schedules:delete',
  SCHEDULES_CRON_HEALTH: 'schedules:cronHealth',
  SCHEDULER_LIST_BUILT_IN_ACTIONS: 'scheduler:listBuiltInActions',
  SCHEDULES_LIST_SCRIPTS: 'schedules:listScripts',

  // --- Tickets ---
  TICKETS_FETCH: 'tickets:fetch',
  TICKETS_SPEC_CHECK: 'tickets:specCheck',
  TICKETS_SPEC_REFINE: 'tickets:specRefine',
  TICKETS_SPEC_CHECK_ASYNC: 'tickets:specCheckAsync',
  TICKETS_SPEC_REFINE_ASYNC: 'tickets:specRefineAsync',
  TICKETS_RETRY_REFINEMENT_ASYNC: 'tickets:retryRefinementAsync',
  TICKETS_POST_ANSWERS: 'tickets:postAnswers',
  TICKETS_CANCEL_REFINEMENT: 'tickets:cancelRefinement',
  TICKETS_LIST_REFINEMENTS: 'tickets:listRefinements',
  TICKETS_CREATE: 'tickets:create',
  TICKETS_FETCH_RAW: 'tickets:fetchRaw',
  TICKETS_UPDATE: 'tickets:update',
  TICKETS_LIST: 'tickets:list',
  TICKETS_TEST_JIRA_CONNECTION: 'tickets:testJiraConnection',
  TICKET_BOARD_SET_COLUMN: 'ticket-board:set-column',
  TICKET_CLOSE: 'ticket:close',
  TICKET_MARK_DONE: 'ticket:mark-done',
  TICKET_BOARD_DELETE: 'ticket-board:delete',

  // --- Pull Requests ---
  PR_DRAFT_BODY: 'pr:draftBody',
  PR_CREATE: 'pr:create',
  PR_MERGE: 'pr:merge',
  PR_CREATE_AUTO: 'pr:createAuto',
  PR_AUTO_RESOLVE: 'pr:autoResolve',

  // --- Dark Factory ---
  DARK_FACTORY_GET_ENABLED: 'darkFactory:getEnabled',
  DARK_FACTORY_SET_ENABLED: 'darkFactory:setEnabled',
  DARK_FACTORY_GET_CONFIG: 'darkFactory:getConfig',
  DARK_FACTORY_SET_CONFIG: 'darkFactory:setConfig',

  // --- Epic ---
  EPIC_START: 'epic:start',
  EPIC_GET_RUN_PLAN: 'epic:getRunPlan',
} as const;

// Static push-event channels (webContents.send → window.sandstorm.on)
export const EVENT_CHANNELS = {
  EPIC_STATUS: 'epic:status',
  STACKS_UPDATED: 'stacks:updated',
  REFINEMENT_UPDATE: 'refinement:update',
  REFINEMENT_PROGRESS: 'refinement:progress',
  SESSION_THRESHOLD: 'session:threshold',
  SESSION_HALTED: 'session:halted',
  SESSION_RESET: 'session:reset',
  SESSION_STATE: 'session:state',
  SCHEDULE_DISPATCHED: 'schedule:dispatched',
  TASK_COMPLETED: 'task:completed',
  TASK_FAILED: 'task:failed',
  TASK_OUTPUT: 'task:output',
  TASK_WORKFLOW_PROGRESS: 'task:workflow-progress',
  DOCKER_CONNECTED: 'docker:connected',
  DOCKER_DISCONNECTED: 'docker:disconnected',
  SCHEDULER_CRON_HEALTH: 'scheduler:cronHealth',
  NAVIGATE_STACK: 'navigate:stack',
  AUTH_URL_OPENED: 'auth:url-opened',
  AUTH_COMPLETED: 'auth:completed',
} as const;

// Typed builders for per-tab dynamic agent event channels.
// Each builder returns a template-literal type so callers are compile-checked.
export const AGENT_OUTPUT = (tabId: string): `agent:output:${string}` =>
  `agent:output:${tabId}`;

export const AGENT_DONE = (tabId: string): `agent:done:${string}` =>
  `agent:done:${tabId}`;

export const AGENT_ERROR = (tabId: string): `agent:error:${string}` =>
  `agent:error:${tabId}`;

export const AGENT_QUEUED = (tabId: string): `agent:queued:${string}` =>
  `agent:queued:${tabId}`;

export const AGENT_TOKEN_USAGE_EVENT = (tabId: string): `agent:token-usage:${string}` =>
  `agent:token-usage:${tabId}`;

export const AGENT_USER_MESSAGE = (tabId: string): `agent:user-message:${string}` =>
  `agent:user-message:${tabId}`;

type StaticEventChannel = typeof EVENT_CHANNELS[keyof typeof EVENT_CHANNELS];
type AgentEventChannel =
  | `agent:output:${string}`
  | `agent:done:${string}`
  | `agent:error:${string}`
  | `agent:queued:${string}`
  | `agent:token-usage:${string}`
  | `agent:user-message:${string}`;

export type EventChannel = StaticEventChannel | AgentEventChannel;
