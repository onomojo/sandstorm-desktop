import { app, BrowserWindow, nativeTheme } from 'electron';
import path from 'path';
import { Registry } from './control-plane/registry';
import { PortAllocator } from './control-plane/port-allocator';
import { PortProxy } from './control-plane/port-proxy';
import { TaskWatcher } from './control-plane/task-watcher';
import { StackManager } from './control-plane/stack-manager';
import { DockerRuntime } from './runtime/docker';
import { PodmanRuntime } from './runtime/podman';
import { ContainerRuntime } from './runtime/types';
import { DockerConnectionManager } from './runtime/docker-connection';
import { AgentBackend, ClaudeBackend } from './agent';
import { registerIpcHandlers } from './ipc';
import { createTray } from './tray';
import { SessionMonitor } from './control-plane/session-monitor';
import {
  SchedulerSocketServer,
  ScheduledDispatchRequest,
  ScheduledDispatchResponse,
  getSchedule,
  installWrapper,
  getBundledWrapperPath,
  getStableWrapperPath,
  isCronRunning,
} from './scheduler';
import { syncAllProjectsCrontab } from './scheduler/scheduler-manager';

// Enable remote debugging via env var (used by integration tests and ad-hoc CDP connections)
if (process.env.REMOTE_DEBUGGING_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.REMOTE_DEBUGGING_PORT);
}

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
export let sessionMonitor: SessionMonitor;
export let schedulerSocketServer: SchedulerSocketServer;

// Track in-flight dispatches to prevent duplicate concurrent runs.
// Maps flightKey → { safetyTimer, completionPoll } so we can clear both on quit.
interface InFlightEntry {
  safetyTimer: ReturnType<typeof setTimeout>;
  completionPoll: ReturnType<typeof setInterval>;
}
const inFlightDispatches = new Map<string, InFlightEntry>();

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
  const portProxy = new PortProxy(registry, portAllocator);
  taskWatcher = new TaskWatcher(registry, dockerRuntime, podmanRuntime);
  stackManager = new StackManager(
    registry,
    portAllocator,
    taskWatcher,
    dockerRuntime,
    podmanRuntime,
    cliDir
  );
  stackManager.setPortProxy(portProxy);

  // Set up Docker connection manager for health monitoring
  if (dockerRuntime instanceof DockerRuntime) {
    dockerConnectionManager = (dockerRuntime as DockerRuntime).getConnectionManager();
  }

  // Initialize agent backend (currently Claude — swappable in future).
  // Orchestrator token usage is tracked per-session (per-tab) inside the
  // backend; the renderer reads it via `agent:tokenUsage` / listens to
  // `agent:token-usage:<tabId>` events. No DB persistence — "New Session"
  // resets the counter by design.
  agentBackend = new ClaudeBackend(
    undefined,
    (projectDir) => registry.getEffectiveModels(projectDir).outer_model
  );
  await agentBackend.initialize();

  // Initialize session monitor with persisted settings
  const monitorSettings = registry.getSessionMonitorSettings();
  sessionMonitor = new SessionMonitor(monitorSettings);

  // Wire session monitor events
  sessionMonitor.on('threshold:warning', (usage) => {
    mainWindow?.webContents.send('session:threshold', { level: 'warning', usage });
  });
  sessionMonitor.on('threshold:critical', (usage) => {
    mainWindow?.webContents.send('session:threshold', { level: 'critical', usage });
  });
  sessionMonitor.on('threshold:limit', (usage) => {
    mainWindow?.webContents.send('session:threshold', { level: 'limit', usage });
  });
  sessionMonitor.on('threshold:cleared', () => {
    mainWindow?.webContents.send('session:threshold', { level: 'normal', usage: null });
  });
  sessionMonitor.on('halt:triggered', () => {
    const paused = stackManager.sessionPauseAllStacks();
    mainWindow?.webContents.send('session:halted', { pausedStacks: paused });
  });
  sessionMonitor.on('session:reset', () => {
    const currentSettings = registry.getSessionMonitorSettings();
    if (currentSettings.autoResumeAfterReset) {
      stackManager.sessionResumeAllStacks();
    }
    mainWindow?.webContents.send('session:reset');
  });
  sessionMonitor.on('state:changed', (state) => {
    mainWindow?.webContents.send('session:state', state);
  });

  sessionMonitor.start();

  // --- Scheduler setup ---

  // Install the wrapper script to a stable user-writable path
  try {
    const bundledPath = app.isPackaged
      ? getBundledWrapperPath(process.resourcesPath)
      : getBundledWrapperPath(path.join(app.getAppPath(), 'resources'));
    installWrapper(bundledPath);
  } catch (err) {
    console.warn('[scheduler] Wrapper install failed (non-fatal):', err);
  }

  // Start the scheduler socket server for cron → app dispatch
  const handleScheduledDispatch = async (
    request: ScheduledDispatchRequest
  ): Promise<ScheduledDispatchResponse> => {
    try {
      // Find the project
      const projects = registry.listProjects();
      const resolvedDir = path.resolve(request.projectDir);
      const project = projects.find((p) => path.resolve(p.directory) === resolvedDir);
      if (!project) {
        return { ok: false, reason: 'project-not-open', message: `Project not open: ${request.projectDir}` };
      }

      // Find the schedule
      const schedule = getSchedule(request.projectDir, request.scheduleId);
      if (!schedule) {
        return { ok: false, reason: 'schedule-not-found', message: `Schedule not found: ${request.scheduleId}` };
      }
      if (!schedule.enabled) {
        return { ok: false, reason: 'schedule-disabled', message: `Schedule is disabled: ${request.scheduleId}` };
      }

      // Check rate-limit state
      const smState = sessionMonitor.getState();
      if (smState.level === 'over_limit' || smState.level === 'limit') {
        return { ok: false, reason: 'rate-limited', message: 'Rate limit reached' };
      }

      // Check auth-halt (session monitor halted state)
      if (smState.halted) {
        return { ok: false, reason: 'auth-halt', message: 'Session is halted' };
      }

      // Check if a dispatch for this (projectDir, scheduleId) is already in-flight
      const flightKey = `${request.projectDir}:${request.scheduleId}`;
      if (inFlightDispatches.has(flightKey)) {
        return { ok: false, reason: 'orchestrator-busy', message: `Dispatch already in-flight for schedule ${request.scheduleId}` };
      }

      // Use the schedule's prompt (not the placeholder from the wrapper)
      const prompt = schedule.prompt;

      // Dispatch via the agent backend as a scheduled turn
      const tabId = `project-${project.id}`;
      agentBackend.sendMessage(tabId, prompt, project.directory);

      // Mark as in-flight and poll the agent backend for completion.
      // The agent backend sets session.processing = false when done; we check
      // every 10s and clear the in-flight entry when the session is no longer
      // processing, allowing the next scheduled fire to dispatch.
      const clearFlight = (key: string): void => {
        const entry = inFlightDispatches.get(key);
        if (entry) {
          clearInterval(entry.completionPoll);
          clearTimeout(entry.safetyTimer);
          inFlightDispatches.delete(key);
        }
      };
      const completionPoll = setInterval(() => {
        const history = agentBackend.getHistory(tabId);
        if (!history.processing) {
          clearFlight(flightKey);
        }
      }, 10_000);
      // Safety timeout: 4 hours max to prevent leaks if polling somehow fails
      const safetyTimer = setTimeout(() => {
        clearFlight(flightKey);
      }, 4 * 60 * 60 * 1000);
      inFlightDispatches.set(flightKey, { safetyTimer, completionPoll });

      // Notify the renderer to mark this user-turn with a "scheduled" badge
      mainWindow?.webContents.send('schedule:dispatched', {
        projectDir: request.projectDir,
        scheduleId: request.scheduleId,
        scheduleLabel: schedule.label || schedule.id,
        firedAt: request.firedAt,
        tabId,
      });

      return { ok: true, dispatchId: `dispatch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}` };
    } catch (err) {
      return {
        ok: false,
        reason: 'internal-error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  };

  schedulerSocketServer = new SchedulerSocketServer(handleScheduledDispatch);
  try {
    await schedulerSocketServer.start();
  } catch (err) {
    console.error('[scheduler] Socket server failed to start:', err);
  }

  // Sync crontab entries on startup
  try {
    await syncAllProjectsCrontab(registry);
  } catch (err) {
    console.warn('[scheduler] Initial crontab sync failed (non-fatal):', err);
  }

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

  taskWatcher.on('task:workflow-progress', (progress) => {
    mainWindow?.webContents.send('task:workflow-progress', progress);
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

  // Proactive cron health check on app launch — push result to renderer
  try {
    const cronRunning = isCronRunning();
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send('scheduler:cronHealth', { running: cronRunning });
    });
  } catch {
    // Non-fatal — renderer will check lazily when panel mounts
  }

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
  // Clear in-flight dispatch timers to allow graceful shutdown
  for (const entry of inFlightDispatches.values()) {
    clearInterval(entry.completionPoll);
    clearTimeout(entry.safetyTimer);
  }
  inFlightDispatches.clear();
  schedulerSocketServer?.stop().catch(() => {});
  sessionMonitor?.destroy();
  agentBackend?.destroy();
  stackManager?.destroy();
  taskWatcher?.unwatchAll();
  if (dockerRuntime instanceof DockerRuntime) {
    (dockerRuntime as DockerRuntime).destroy();
  }
  registry?.close();
});
