import { app, BrowserWindow, nativeTheme } from 'electron';
import path from 'path';
import { Registry, Stack } from './control-plane/registry';
import { PortAllocator } from './control-plane/port-allocator';
import { PortProxy } from './control-plane/port-proxy';
import { TaskWatcher } from './control-plane/task-watcher';
import { StackManager } from './control-plane/stack-manager';
import { DockerRuntime } from './runtime/docker';
import { PodmanRuntime } from './runtime/podman';
import { ContainerRuntime } from './runtime/types';
import { DockerConnectionManager } from './runtime/docker-connection';
import { AgentBackend, ClaudeBackend, OpenCodeBackend, BackendRouter, StackInfo } from './agent';
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
import { runScheduledScript } from './scheduler/script-runner';
import { runStartupReconciliation, INVESTIGATE_AND_FINISH_PROMPT } from './control-plane/startup-reconciler';
import { DarkFactoryOrchestrator } from './control-plane/dark-factory-orchestrator';
import { APP_USER_DATA_NAME } from './app-identity';

// Pin the userData directory name independent of the package.json `name` /
// electron-builder productName. Electron resolves app.getPath('userData') from
// app.getName(); renaming the package to 'sandstorm' (#485) moved userData and
// hid every existing project/ticket-config. Must run before whenReady and any
// getPath('userData') call. See app-identity.ts.
app.setName(APP_USER_DATA_NAME);

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
export let darkFactoryOrchestrator: DarkFactoryOrchestrator;

// Track in-flight scheduler dispatches to prevent overlapping concurrent
// runs of the same schedule. Each action Promise clears its own entry in
// `finally`; the `safetyTimer` is a belt-and-suspenders leak guard.
interface InFlightEntry {
  safetyTimer: ReturnType<typeof setTimeout>;
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

  // Wire liveness-check investigation dispatch: when TaskWatcher detects a stalled
  // task (process dead + no log growth for 5 min), it calls back here to resume
  // the original session with an investigate-and-finish prompt.
  taskWatcher.setDispatchInvestigation(async (stackId, task) => {
    await stackManager.dispatchInvestigation(stackId, task, INVESTIGATE_AND_FINISH_PROMPT);
  });

  // Backfill: advance any tickets stuck in in_stack whose linked stack is already pr_created.
  registry.reconcilePrCreatedTickets();

  // Set up Docker connection manager for health monitoring
  if (dockerRuntime instanceof DockerRuntime) {
    dockerConnectionManager = (dockerRuntime as DockerRuntime).getConnectionManager();
  }

  // Initialize agent backend (currently Claude — swappable in future).
  // Orchestrator token usage is tracked per-session (per-tab) inside the
  // backend; the renderer reads it via `agent:tokenUsage` / listens to
  // `agent:token-usage:<tabId>` events. No DB persistence — "New Session"
  // resets the counter by design.
  const modelResolver = (projectDir: string) => {
    return registry.getEffectiveRoutingFor(projectDir, 'outer').model;
  };
  const resolveRuntime = (stack: StackInfo) => stackManager.getRuntimeForStack(stack as Stack);
  agentBackend = new BackendRouter(
    {
      claude: () => new ClaudeBackend(undefined, modelResolver, resolveRuntime),
      opencode: () => new OpenCodeBackend(resolveRuntime),
    },
    (projectDir) => registry.getEffectiveRoutingFor(projectDir, 'outer').backend,
    (projectDir, touchpoint) => registry.getEffectiveTouchpointDescriptor(projectDir, touchpoint),
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

  // Scheduler dispatch handler. Routes each scheduled fire by
  // `schedule.action.kind` to a deterministic primitive (this PR: only
  // `run-script`). MUST NOT call `agentBackend.sendMessage` or any
  // chat-session API — see CLAUDE.md "Deterministic workflow philosophy".
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
      if (smState.halted) {
        return { ok: false, reason: 'auth-halt', message: 'Session is halted' };
      }

      // In-flight dedup so a slow schedule doesn't stack up overlapping
      // fires. Safety timer clears the flight if the action Promise
      // somehow never settles.
      const flightKey = `${request.projectDir}:${request.scheduleId}`;
      if (inFlightDispatches.has(flightKey)) {
        return { ok: false, reason: 'orchestrator-busy', message: `Dispatch already in-flight for schedule ${request.scheduleId}` };
      }

      const safetyTimer = setTimeout(() => {
        inFlightDispatches.delete(flightKey);
      }, 4 * 60 * 60 * 1000);
      inFlightDispatches.set(flightKey, { safetyTimer });

      // Notify the renderer so the UI can show an "action running" badge
      // on the schedule in the panel. No chat turn — this is just a UI
      // hint, keyed by scheduleId, not a message in the agent session.
      mainWindow?.webContents.send('schedule:dispatched', {
        projectDir: request.projectDir,
        scheduleId: request.scheduleId,
        scheduleLabel: schedule.label || schedule.id,
        firedAt: request.firedAt,
      });

      try {
        switch (schedule.action.kind) {
          case 'run-script': {
            const response = await runScheduledScript(
              project.directory,
              schedule.action.scriptName,
              request,
            );
            return response;
          }
          case 'refine-to-comments': {
            const { runRefineToComments, buildRefineToCommentsDeps } = await import('./scheduler/refine-to-comments');
            const { handleToolCall, makeContractGateDeps } = await import('./claude/tools');
            const { defaultSpecGateDeps, runSpecCheck, runSpecRefine } = await import('./control-plane/ticket-spec');
            const specDeps = defaultSpecGateDeps(
              (ticketId, projectDir) =>
                handleToolCall('spec_check', { ticketId, projectDir }) as Promise<import('./control-plane/ticket-spec').SpecGateReport>,
              (ticketId, projectDir, userAnswers) =>
                handleToolCall('spec_refine', { ticketId, projectDir, userAnswers }) as Promise<import('./control-plane/ticket-spec').SpecGateReport>,
              (projectDir) => registry.getProjectTicketConfig(projectDir),
              makeContractGateDeps(),
            );
            const deps = buildRefineToCommentsDeps(
              (ticketId, projectDir) => runSpecCheck(ticketId, projectDir, specDeps),
              (ticketId, projectDir, userAnswers) => runSpecRefine(ticketId, projectDir, userAnswers, specDeps),
              (projectDir) => registry.getProjectTicketConfig(projectDir),
            );
            const label = schedule.action.ticketLabel ?? 'needs-spec';
            const result = await runRefineToComments(project.directory, label, deps);
            console.log(
              `[scheduler] refine-to-comments: processed=${result.processed} passed=${result.passed} failed=${result.failed}`,
            );
            const dispatchId = `dispatch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
            return { ok: true, dispatchId };
          }
          default: {
            const unknownKind = (schedule.action as { kind?: string }).kind;
            return {
              ok: false,
              reason: 'internal-error',
              message: `Unknown schedule action kind: ${String(unknownKind)}`,
            };
          }
        }
      } finally {
        clearTimeout(safetyTimer);
        inFlightDispatches.delete(flightKey);
      }
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

  // Initialize dark factory orchestrator
  darkFactoryOrchestrator = new DarkFactoryOrchestrator(
    registry,
    stackManager,
    agentBackend,
    () => mainWindow?.webContents.send('stacks:updated'),
  );
  darkFactoryOrchestrator.startPeriodicWatcher();

  // Listen for task events to send to renderer
  taskWatcher.on('task:completed', ({ stackId, task }) => {
    mainWindow?.webContents.send('task:completed', { stackId, task });
    mainWindow?.webContents.send('stacks:updated');
    darkFactoryOrchestrator.handleTaskCompleted(stackId, task);
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

  // Background startup reconciliation — runs after the window is shown so it
  // never delays window readiness. Drives stale 'running' stacks to terminal
  // states or re-attaches watchers. Fire-and-forget; cards update live via
  // per-stack 'stacks:updated' emissions.
  mainWindow.webContents.once('did-finish-load', () => {
    runStartupReconciliation(
      registry,
      stackManager,
      taskWatcher,
      dockerRuntime,
      podmanRuntime,
      () => mainWindow?.webContents.send('stacks:updated')
    ).catch((err) => {
      console.warn('[StartupReconciler] Background reconciliation error:', err);
    });

    // Dispatch any spec_ready tickets with no stack across all Dark-Factory-enabled
    // projects. Catches tickets that were stranded before the last app restart.
    for (const project of registry.listProjects()) {
      darkFactoryOrchestrator.reconcileSpecReady(project.directory).catch((err) => {
        console.warn('[DarkFactory] Startup reconcile failed for', project.directory, ':', err);
      });
    }
  });

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
  // Clear in-flight dispatch safety timers to allow graceful shutdown
  for (const entry of inFlightDispatches.values()) {
    clearTimeout(entry.safetyTimer);
  }
  inFlightDispatches.clear();
  schedulerSocketServer?.stop().catch(() => {});
  sessionMonitor?.destroy();
  agentBackend?.destroy();
  stackManager?.destroy();
  taskWatcher?.unwatchAll();
  darkFactoryOrchestrator?.destroy();
  if (dockerRuntime instanceof DockerRuntime) {
    (dockerRuntime as DockerRuntime).destroy();
  }
  registry?.close();
});
