import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { INVOKE_CHANNELS } from '../ipc-channels';
import type { IpcContext } from './types';
import {
  createSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  isCronRunning,
} from '../scheduler';
import type { ScheduleAction } from '../scheduler/types';
import { BUILT_IN_ACTIONS } from '../scheduler/built-in-actions';
import { validateProjectDir } from '../validation';
import { syncAllProjectsCrontab } from '../scheduler/scheduler-manager';

export function registerScheduleHandlers(ctx: IpcContext): void {
  ipcMain.handle(INVOKE_CHANNELS.SCHEDULES_LIST, async (_event, projectDir: string) => {
    const dirError = validateProjectDir(projectDir);
    if (dirError) throw new Error(dirError.error);
    return listSchedules(projectDir);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.SCHEDULES_CREATE,
    async (
      _event,
      projectDir: string,
      data: {
        label?: string;
        cronExpression: string;
        action: ScheduleAction;
        enabled?: boolean;
      },
    ) => {
      const dirError = validateProjectDir(projectDir);
      if (dirError) throw new Error(dirError.error);
      const schedule = createSchedule({
        projectDir,
        label: data.label,
        cronExpression: data.cronExpression,
        action: data.action,
        enabled: data.enabled,
      });
      try {
        await syncAllProjectsCrontab(ctx.registry);
      } catch (err) {
        console.warn('[scheduler] Crontab sync failed (non-fatal):', err);
      }
      return schedule;
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.SCHEDULES_UPDATE,
    async (
      _event,
      projectDir: string,
      id: string,
      patch: {
        label?: string;
        cronExpression?: string;
        action?: ScheduleAction;
        enabled?: boolean;
      },
    ) => {
      const dirError = validateProjectDir(projectDir);
      if (dirError) throw new Error(dirError.error);
      const schedule = updateSchedule(projectDir, id, patch);
      try {
        await syncAllProjectsCrontab(ctx.registry);
      } catch (err) {
        console.warn('[scheduler] Crontab sync failed (non-fatal):', err);
      }
      return schedule;
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.SCHEDULES_DELETE,
    async (_event, projectDir: string, id: string) => {
      const dirError = validateProjectDir(projectDir);
      if (dirError) throw new Error(dirError.error);
      deleteSchedule(projectDir, id);
      try {
        await syncAllProjectsCrontab(ctx.registry);
      } catch (err) {
        console.warn('[scheduler] Crontab sync failed (non-fatal):', err);
      }
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.SCHEDULES_CRON_HEALTH, async () => {
    return { running: isCronRunning() };
  });

  ipcMain.handle(INVOKE_CHANNELS.SCHEDULER_LIST_BUILT_IN_ACTIONS, async () => {
    return BUILT_IN_ACTIONS;
  });

  ipcMain.handle(INVOKE_CHANNELS.SCHEDULES_LIST_SCRIPTS, async (_event, projectDir: string) => {
    const dirError = validateProjectDir(projectDir);
    if (dirError) throw new Error(dirError.error);
    const scriptsDir = path.join(projectDir, '.sandstorm', 'scripts', 'scheduled');
    try {
      const entries = await fs.promises.readdir(scriptsDir);
      return entries.filter((f) => f.endsWith('.sh')).sort();
    } catch {
      return [];
    }
  });
}
