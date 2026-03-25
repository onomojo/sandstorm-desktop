import { contextBridge, ipcRenderer } from 'electron';

export interface SandstormAPI {
  projects: {
    list: () => Promise<unknown[]>;
    add: (directory: string) => Promise<unknown>;
    remove: (id: number) => Promise<void>;
    browse: () => Promise<string | null>;
    checkInit: (directory: string) => Promise<boolean>;
    initialize: (directory: string) => Promise<{ success: boolean; error?: string }>;
  };
  stacks: {
    list: () => Promise<unknown[]>;
    get: (id: string) => Promise<unknown>;
    create: (opts: unknown) => Promise<unknown>;
    teardown: (id: string) => Promise<void>;
    stop: (id: string) => Promise<void>;
    start: (id: string) => Promise<void>;
    history: () => Promise<unknown[]>;
  };
  tasks: {
    dispatch: (stackId: string, prompt: string) => Promise<unknown>;
    list: (stackId: string) => Promise<unknown[]>;
  };
  diff: {
    get: (stackId: string) => Promise<string>;
  };
  push: {
    execute: (stackId: string, message?: string) => Promise<void>;
  };
  ports: {
    get: (stackId: string) => Promise<unknown[]>;
  };
  logs: {
    stream: (containerId: string, runtime: string) => Promise<string>;
  };
  stats: {
    stackMemory: (stackId: string) => Promise<number>;
    stackDetailed: (stackId: string) => Promise<unknown>;
    taskMetrics: (stackId: string) => Promise<unknown>;
  };
  runtime: {
    available: () => Promise<{ docker: boolean; podman: boolean }>;
  };
  claude: {
    send: (tabId: string, message: string, projectDir?: string) => Promise<void>;
    cancel: (tabId: string) => Promise<void>;
    reset: (tabId: string) => Promise<void>;
    history: (tabId: string) => Promise<{ messages: Array<{ role: string; content: string }>; processing: boolean }>;
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
  auth: {
    status: () => Promise<{ loggedIn: boolean; email?: string; expired: boolean; expiresAt?: number }>;
    login: () => Promise<{ success: boolean; error?: string }>;
  };
  docker: {
    status: () => Promise<{ connected: boolean }>;
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
  },
  stacks: {
    list: () => ipcRenderer.invoke('stacks:list'),
    get: (id) => ipcRenderer.invoke('stacks:get', id),
    create: (opts) => ipcRenderer.invoke('stacks:create', opts),
    teardown: (id) => ipcRenderer.invoke('stacks:teardown', id),
    stop: (id) => ipcRenderer.invoke('stacks:stop', id),
    start: (id) => ipcRenderer.invoke('stacks:start', id),
    history: () => ipcRenderer.invoke('stacks:history'),
  },
  tasks: {
    dispatch: (stackId, prompt) =>
      ipcRenderer.invoke('tasks:dispatch', stackId, prompt),
    list: (stackId) => ipcRenderer.invoke('tasks:list', stackId),
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
  },
  logs: {
    stream: (containerId, runtime) =>
      ipcRenderer.invoke('logs:stream', containerId, runtime),
  },
  stats: {
    stackMemory: (stackId) => ipcRenderer.invoke('stats:stack-memory', stackId),
    stackDetailed: (stackId) => ipcRenderer.invoke('stats:stack-detailed', stackId),
    taskMetrics: (stackId) => ipcRenderer.invoke('stats:task-metrics', stackId),
  },
  runtime: {
    available: () => ipcRenderer.invoke('runtime:available'),
  },
  claude: {
    send: (tabId, message, projectDir) =>
      ipcRenderer.invoke('claude:send', tabId, message, projectDir),
    cancel: (tabId) => ipcRenderer.invoke('claude:cancel', tabId),
    reset: (tabId) => ipcRenderer.invoke('claude:reset', tabId),
    history: (tabId) => ipcRenderer.invoke('claude:history', tabId),
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
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    login: () => ipcRenderer.invoke('auth:login'),
  },
  docker: {
    status: () => ipcRenderer.invoke('docker:status'),
  },
  on: (channel, callback) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld('sandstorm', api);
