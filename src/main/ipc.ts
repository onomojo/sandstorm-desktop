import { ipcMain, BrowserWindow } from 'electron';
import {
  registry,
  stackManager,
  dockerRuntime,
  podmanRuntime,
  cliDir,
  agentBackend,
  dockerConnectionManager,
  sessionMonitor,
  darkFactoryOrchestrator,
} from './index';
import { initEpicRunner, getEpicRunner } from './control-plane/epic-runner';
import { fetchTicketWithConfig } from './control-plane/ticket-config';
import { EVENT_CHANNELS } from './ipc-channels';
import type { IpcContext } from './ipc/types';
import { registerAgentHandlers } from './ipc/agent';
import { registerProjectHandlers } from './ipc/projects';
import { registerStackHandlers } from './ipc/stacks';
import { registerTaskHandlers } from './ipc/tasks';
import { registerDiffPushHandlers } from './ipc/diff-push';
import { registerPortHandlers } from './ipc/ports';
import { registerLogHandlers } from './ipc/logs';
import { registerStatsHandlers } from './ipc/stats';
import { registerContextHandlers } from './ipc/context';
import { registerSettingsHandlers } from './ipc/settings';
import { registerProviderHandlers } from './ipc/providers';
import { registerSessionHandlers } from './ipc/session';
import { registerScheduleHandlers } from './ipc/schedules';
import { registerTicketHandlers } from './ipc/tickets';
import { registerPrHandlers } from './ipc/pr';
import { registerDarkFactoryHandlers } from './ipc/dark-factory';
import { registerEpicHandlers } from './ipc/epic';

// Set __sandstorm at module-load time so app.evaluate() works immediately
// after electron.launch() resolves — which happens during createWindow(),
// before registerIpcHandlers() is called.  The getter defers reading
// `registry` until first access so circular-import init order doesn't matter.
if (process.env.PLAYWRIGHT_TEST) {
  Object.defineProperty(globalThis, '__sandstorm', {
    get: () => ({ registry, ipcMain }),
    configurable: true,
    enumerable: true,
  });
}

export function registerIpcHandlers(mainWindow?: BrowserWindow): void {
  // Initialize the epic runner singleton with live dependencies
  const epicRunner = initEpicRunner({
    listStacks: () => registry.listStacks(),
    getEpicTasks: (epicId) => registry.getEpicTasks(epicId),
    upsertEpicRunState: (epicId, projectDir, status) =>
      registry.upsertEpicRunState(epicId, projectDir, status),
    upsertEpicTask: (epicId, ticketId, opts) =>
      registry.upsertEpicTask(epicId, ticketId, opts),
    setEpicTaskDone: (epicId, ticketId) => registry.setEpicTaskDone(epicId, ticketId),
    getEpicRunState: (epicId) => registry.getEpicRunState(epicId),
    getDarkFactoryEnabled: (projectDir) => registry.getDarkFactoryEnabled(projectDir),
    getEpicMaxParallelStacks: (projectDir) => registry.getEpicMaxParallelStacks(projectDir),
    getProjectTicketConfig: (projectDir) => registry.getProjectTicketConfig(projectDir),
    createStack: (opts) => stackManager.createStack(opts),
    dispatchTask: (stackId, prompt) => stackManager.dispatchTask(stackId, prompt),
    fetchTicketWithConfig,
  });

  epicRunner.setOnStatusUpdate((_epicId, snapshot) => {
    mainWindow?.webContents.send(EVENT_CHANNELS.EPIC_STATUS, snapshot);
  });

  // Wire up stack update notifications to the renderer and advance any running epics
  stackManager.setOnStackUpdate(() => {
    mainWindow?.webContents.send(EVENT_CHANNELS.STACKS_UPDATED);
    getEpicRunner()
      .onAnyStackUpdated()
      .catch((err) => {
        console.warn('[EpicRunner] onAnyStackUpdated error:', err);
      });
  });

  const ctx: IpcContext = {
    mainWindow,
    registry,
    stackManager,
    dockerRuntime,
    podmanRuntime,
    cliDir,
    agentBackend,
    dockerConnectionManager,
    sessionMonitor,
    darkFactoryOrchestrator: darkFactoryOrchestrator ?? null,
  };

  registerAgentHandlers(ctx);
  registerProjectHandlers(ctx);
  registerStackHandlers(ctx);
  registerTaskHandlers(ctx);
  registerDiffPushHandlers(ctx);
  registerPortHandlers(ctx);
  registerLogHandlers(ctx);
  registerStatsHandlers(ctx);
  registerContextHandlers();
  registerSettingsHandlers(ctx);
  registerProviderHandlers(ctx);
  registerSessionHandlers(ctx);
  registerScheduleHandlers(ctx);
  registerTicketHandlers(ctx);
  registerPrHandlers(ctx);
  registerDarkFactoryHandlers(ctx);
  registerEpicHandlers();
}
