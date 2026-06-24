import { ipcMain } from 'electron';
import { INVOKE_CHANNELS } from '../ipc-channels';
import type { IpcContext } from './types';
import { SandstormError, ErrorCode } from '../errors';

export function registerSessionHandlers(ctx: IpcContext): void {
  // --- Session Monitor ---

  ipcMain.handle(INVOKE_CHANNELS.SESSION_GET_STATE, () => {
    return ctx.sessionMonitor.getState();
  });

  ipcMain.handle(INVOKE_CHANNELS.SESSION_GET_SETTINGS, () => {
    return ctx.registry.getSessionMonitorSettings();
  });

  ipcMain.handle(
    INVOKE_CHANNELS.SESSION_UPDATE_SETTINGS,
    (_event, settings: Record<string, unknown>) => {
      ctx.registry.setSessionMonitorSettings(
        settings as Partial<{
          warningThreshold: number;
          criticalThreshold: number;
          autoHaltThreshold: number;
          autoHaltEnabled: boolean;
          autoResumeAfterReset: boolean;
          pollIntervalMs: number;
          idleTimeoutMs: number;
          pollingDisabled: boolean;
        }>,
      );
      ctx.sessionMonitor.updateSettings(ctx.registry.getSessionMonitorSettings());
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.SESSION_ACKNOWLEDGE_CRITICAL, () => {
    ctx.sessionMonitor.acknowledgeCritical();
  });

  ipcMain.handle(INVOKE_CHANNELS.SESSION_HALT_ALL, () => {
    return ctx.stackManager.sessionPauseAllStacks();
  });

  ipcMain.handle(INVOKE_CHANNELS.SESSION_RESUME_ALL, () => {
    ctx.sessionMonitor.markResumed();
    return ctx.stackManager.sessionResumeAllStacks();
  });

  ipcMain.handle(INVOKE_CHANNELS.SESSION_RESUME_STACK, (_event, stackId: string) => {
    ctx.stackManager.sessionResumeStack(stackId);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.SESSION_RESUME_STACK_WITH_CONTINUATION,
    async (_event, stackId: string, manual: boolean = false) => {
      try {
        const result = await ctx.stackManager.resumeStackWithContinuation(
          stackId,
          () => ctx.sessionMonitor.getState().halted,
          manual,
        );
        return { halted: false, ...result };
      } catch (err) {
        if (err instanceof SandstormError && err.code === ErrorCode.SESSION_HALTED) {
          const resetAt = ctx.sessionMonitor.getState().usage?.session?.resetsAt ?? null;
          return { halted: true, resetAt };
        }
        throw err;
      }
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.SESSION_FORCE_POLL, async () => {
    return ctx.sessionMonitor.forcePoll();
  });

  // Fire-and-forget: renderer notifies main of user activity to keep the
  // session monitor's idle timer alive.
  ipcMain.on(INVOKE_CHANNELS.SESSION_ACTIVITY, () => {
    ctx.sessionMonitor.reportActivity();
  });

  // --- Docker ---

  ipcMain.handle(INVOKE_CHANNELS.DOCKER_STATUS, () => {
    return {
      connected: ctx.dockerConnectionManager?.isConnected ?? false,
    };
  });

  // --- Auth ---

  ipcMain.handle(INVOKE_CHANNELS.AUTH_STATUS, async () => {
    return ctx.agentBackend.getAuthStatus();
  });

  ipcMain.handle(INVOKE_CHANNELS.AUTH_LOGIN, async () => {
    const result = await ctx.agentBackend.login(ctx.mainWindow ?? undefined);
    if (result.success) {
      const stacks = await ctx.stackManager.listStacksWithServices();
      await ctx.agentBackend.syncCredentials(stacks);
    }
    return result;
  });

  // --- Runtime ---

  ipcMain.handle(INVOKE_CHANNELS.RUNTIME_AVAILABLE, async () => {
    const [dockerAvail, podmanAvail] = await Promise.all([
      ctx.dockerRuntime.isAvailable(),
      ctx.podmanRuntime.isAvailable(),
    ]);
    return { docker: dockerAvail, podman: podmanAvail };
  });
}
