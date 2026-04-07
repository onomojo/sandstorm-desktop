import { app, BrowserWindow, nativeTheme } from 'electron';
import path from 'path';
import { Registry } from './control-plane/registry';
import { PortAllocator } from './control-plane/port-allocator';
import { TaskWatcher } from './control-plane/task-watcher';
import { StackManager } from './control-plane/stack-manager';
import { DockerRuntime } from './runtime/docker';
import { PodmanRuntime } from './runtime/podman';
import { ContainerRuntime } from './runtime/types';
import { DockerConnectionManager } from './runtime/docker-connection';
import { AgentBackend, ClaudeBackend } from './agent';
import { registerIpcHandlers } from './ipc';
import { createTray } from './tray';

let mainWindow: BrowserWindow | null = null;

// Global app state
export let registry: Registry;
export let stackManager: StackManager;
export let portAllocator: PortAllocator;
export let taskWatcher: TaskWatcher;
export let dockerRuntime: ContainerRuntime;
export let podmanRuntime: ContainerRuntime;
export let cliDir: string;
export let agentBackend: AgentBackend;
export let dockerConnectionManager: DockerConnectionManager | null = null;

function createWindow(): BrowserWindow {
  nativeTheme.themeSource = 'dark';

  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'Sandstorm Desktop',
    backgroundColor: '#0d1017',
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' }
      : isWin
        ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#151921', symbolColor: '#6b7394', height: 36 } }
        : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

function resolveCliDir(): string {
  if (app.isPackaged) {
    // extraResources copies sandstorm-cli to <resourcesPath>/sandstorm-cli
    return path.join(process.resourcesPath, 'sandstorm-cli');
  }
  return path.join(app.getAppPath(), 'sandstorm-cli');
}

async function initializeApp(): Promise<void> {
  // Initialize runtimes
  dockerRuntime = new DockerRuntime();
  podmanRuntime = new PodmanRuntime();

  // Initialize control plane — both runtimes are passed through so that
  // each stack uses the runtime it was created with, rather than a single
  // global default that may have been wrong at startup (see #152).
  cliDir = resolveCliDir();
  registry = await Registry.create();
  // Auto-purge archived stack history older than 14 days
  registry.purgeOldHistory(14);

  // Remove legacy JSON stack files left over from before the SQLite migration
  for (const project of registry.listProjects()) {
    registry.cleanupLegacyStackJsonFiles(project.directory);
  }


  portAllocator = new PortAllocator(registry);
  taskWatcher = new TaskWatcher(registry, dockerRuntime, podmanRuntime);
  stackManager = new StackManager(
    registry,
    portAllocator,
    taskWatcher,
    dockerRuntime,
    podmanRuntime,
    cliDir
  );

  // Set up Docker connection manager for health monitoring
  if (dockerRuntime instanceof DockerRuntime) {
    dockerConnectionManager = (dockerRuntime as DockerRuntime).getConnectionManager();
  }

  // Initialize agent backend (currently Claude — swappable in future)
  agentBackend = new ClaudeBackend(
    undefined,
    (projectDir) => registry.getEffectiveModels(projectDir).outer_model
  );
  agentBackend.setTokenUsageCallback?.((projectDir: string, inputTokens: number, outputTokens: number) => {
    registry.addProjectTokenUsage(projectDir, inputTokens, outputTokens);
  });
  await agentBackend.initialize();

  // Listen for task events to send to renderer
  taskWatcher.on('task:completed', ({ stackId, task }) => {
    mainWindow?.webContents.send('task:completed', { stackId, task });
    mainWindow?.webContents.send('stacks:updated');
  });

  taskWatcher.on('task:failed', ({ stackId, task }) => {
    mainWindow?.webContents.send('task:failed', { stackId, task });
    mainWindow?.webContents.send('stacks:updated');
  });

  taskWatcher.on('task:output', ({ stackId, data }) => {
    mainWindow?.webContents.send('task:output', { stackId, data });
  });

  // Forward Docker connection status to renderer
  if (dockerConnectionManager) {
    dockerConnectionManager.on('connected', () => {
      mainWindow?.webContents.send('docker:connected');
    });
    dockerConnectionManager.on('disconnected', () => {
      mainWindow?.webContents.send('docker:disconnected');
    });
  }
}

app.whenReady().then(async () => {
  await initializeApp();

  mainWindow = createWindow();
  agentBackend.setMainWindow(mainWindow);
  registerIpcHandlers(mainWindow);
  createTray(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  agentBackend?.destroy();
  stackManager?.destroy();
  taskWatcher?.unwatchAll();
  if (dockerRuntime instanceof DockerRuntime) {
    (dockerRuntime as DockerRuntime).destroy();
  }
  registry?.close();
});
