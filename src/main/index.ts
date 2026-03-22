import { app, BrowserWindow, nativeTheme } from 'electron';
import path from 'path';
import { Registry } from './control-plane/registry';
import { PortAllocator } from './control-plane/port-allocator';
import { TaskWatcher } from './control-plane/task-watcher';
import { StackManager } from './control-plane/stack-manager';
import { DockerRuntime } from './runtime/docker';
import { PodmanRuntime } from './runtime/podman';
import { ContainerRuntime } from './runtime/types';
import { ClaudeSessionManager } from './claude/session-manager';
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
export let claudeSessionManager: ClaudeSessionManager;

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
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'sandstorm-cli');
  }
  return path.join(app.getAppPath(), 'sandstorm-cli');
}

async function initializeApp(): Promise<void> {
  // Initialize runtimes
  dockerRuntime = new DockerRuntime();
  podmanRuntime = new PodmanRuntime();

  // Default to Docker, fall back to Podman
  const defaultRuntime = (await dockerRuntime.isAvailable())
    ? dockerRuntime
    : podmanRuntime;

  // Initialize control plane
  cliDir = resolveCliDir();
  registry = await Registry.create();
  portAllocator = new PortAllocator(registry);
  taskWatcher = new TaskWatcher(registry, defaultRuntime);
  stackManager = new StackManager(
    registry,
    portAllocator,
    taskWatcher,
    defaultRuntime,
    cliDir
  );

  // Initialize Claude session manager
  claudeSessionManager = new ClaudeSessionManager();
  await claudeSessionManager.initialize();

  // Listen for task events to send to renderer
  taskWatcher.on('task:completed', ({ stackId, task }) => {
    mainWindow?.webContents.send('task:completed', { stackId, task });
  });

  taskWatcher.on('task:failed', ({ stackId, task }) => {
    mainWindow?.webContents.send('task:failed', { stackId, task });
  });

  taskWatcher.on('task:output', ({ stackId, data }) => {
    mainWindow?.webContents.send('task:output', { stackId, data });
  });
}

app.whenReady().then(async () => {
  await initializeApp();

  mainWindow = createWindow();
  claudeSessionManager.setMainWindow(mainWindow);
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
  claudeSessionManager?.destroy();
  taskWatcher?.unwatchAll();
  registry?.close();
});
