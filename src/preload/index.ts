import { contextBridge, ipcRenderer } from 'electron';

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
      missingSpecQualityGate?: boolean;
      missingReviewPrompt?: boolean;
      networksMigrated?: boolean;
      missingUpdateScript?: boolean;
      missingCreatePrScript?: boolean;
      detectedTicketProvider?: 'github' | 'jira' | 'skeleton';
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
    installUpdateScript: (
      directory: string,
      provider: 'github' | 'jira' | 'skeleton',
    ) => Promise<{ success: boolean; path?: string; error?: string }>;
    installCreatePrScript: (
      directory: string,
      provider: 'github' | 'jira' | 'skeleton',
    ) => Promise<{ success: boolean; path?: string; error?: string }>;
    detectTicketProvider: (
      directory: string,
    ) => Promise<{ provider: 'github' | 'jira' | 'skeleton' }>;
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
  specGate: {
    get: (projectDir: string) => Promise<string>;
    save: (projectDir: string, content: string) => Promise<void>;
    getDefault: () => Promise<string>;
    ensure: (projectDir: string) => Promise<boolean>;
  };
  reviewPrompt: {
    get: (projectDir: string) => Promise<string>;
    save: (projectDir: string, content: string) => Promise<void>;
    getDefault: () => Promise<string>;
    ensure: (projectDir: string) => Promise<boolean>;
  };
  modelSettings: {
    getGlobal: () => Promise<{ inner_model: string; outer_model: string }>;
    setGlobal: (settings: { inner_model?: string; outer_model?: string }) => Promise<void>;
    getProject: (projectDir: string) => Promise<{ inner_model: string; outer_model: string } | null>;
    setProject: (projectDir: string, settings: { inner_model?: string; outer_model?: string }) => Promise<void>;
    removeProject: (projectDir: string) => Promise<void>;
    getEffective: (projectDir: string) => Promise<{ inner_model: string; outer_model: string }>;
  };
  session: {
    getState: () => Promise<unknown>;
    getSettings: () => Promise<unknown>;
    updateSettings: (settings: Record<string, unknown>) => Promise<void>;
    acknowledgeCritical: () => Promise<void>;
    haltAll: () => Promise<string[]>;
    resumeAll: () => Promise<string[]>;
    resumeStack: (stackId: string) => Promise<void>;
    forcePoll: () => Promise<unknown>;
    reportActivity: () => void;
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
    create: (projectDir: string, title: string, body: string) => Promise<{ url: string; number: number; ticketId: string }>;
  };
  pr: {
    draftBody: (stackId: string) => Promise<{ title: string; body: string }>;
    create: (stackId: string, title: string, body: string) => Promise<{ url: string; number: number }>;
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
    installUpdateScript: (directory: string, provider: 'github' | 'jira' | 'skeleton') =>
      ipcRenderer.invoke('projects:installUpdateScript', directory, provider),
    installCreatePrScript: (directory: string, provider: 'github' | 'jira' | 'skeleton') =>
      ipcRenderer.invoke('projects:installCreatePrScript', directory, provider),
    detectTicketProvider: (directory: string) =>
      ipcRenderer.invoke('projects:detectTicketProvider', directory),
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
  specGate: {
    get: (projectDir) => ipcRenderer.invoke('specGate:get', projectDir),
    save: (projectDir, content) =>
      ipcRenderer.invoke('specGate:save', projectDir, content),
    getDefault: () => ipcRenderer.invoke('specGate:getDefault'),
    ensure: (projectDir) => ipcRenderer.invoke('specGate:ensure', projectDir),
  },
  reviewPrompt: {
    get: (projectDir) => ipcRenderer.invoke('reviewPrompt:get', projectDir),
    save: (projectDir, content) =>
      ipcRenderer.invoke('reviewPrompt:save', projectDir, content),
    getDefault: () => ipcRenderer.invoke('reviewPrompt:getDefault'),
    ensure: (projectDir) => ipcRenderer.invoke('reviewPrompt:ensure', projectDir),
  },
  modelSettings: {
    getGlobal: () => ipcRenderer.invoke('modelSettings:getGlobal'),
    setGlobal: (settings) => ipcRenderer.invoke('modelSettings:setGlobal', settings),
    getProject: (projectDir) => ipcRenderer.invoke('modelSettings:getProject', projectDir),
    setProject: (projectDir, settings) => ipcRenderer.invoke('modelSettings:setProject', projectDir, settings),
    removeProject: (projectDir) => ipcRenderer.invoke('modelSettings:removeProject', projectDir),
    getEffective: (projectDir) => ipcRenderer.invoke('modelSettings:getEffective', projectDir),
  },
  session: {
    getState: () => ipcRenderer.invoke('session:getState'),
    getSettings: () => ipcRenderer.invoke('session:getSettings'),
    updateSettings: (settings) => ipcRenderer.invoke('session:updateSettings', settings),
    acknowledgeCritical: () => ipcRenderer.invoke('session:acknowledgeCritical'),
    haltAll: () => ipcRenderer.invoke('session:haltAll'),
    resumeAll: () => ipcRenderer.invoke('session:resumeAll'),
    resumeStack: (stackId) => ipcRenderer.invoke('session:resumeStack', stackId),
    forcePoll: () => ipcRenderer.invoke('session:forcePoll'),
    reportActivity: () => { ipcRenderer.send('session:activity'); },
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
    create: (projectDir, title, body) =>
      ipcRenderer.invoke('tickets:create', projectDir, title, body),
  },
  pr: {
    draftBody: (stackId) => ipcRenderer.invoke('pr:draftBody', stackId),
    create: (stackId, title, body) =>
      ipcRenderer.invoke('pr:create', stackId, title, body),
  },
  on: (channel, callback) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('sandstorm', api);
