import { ipcMain } from 'electron';
import { INVOKE_CHANNELS } from '../ipc-channels';
import type { IpcContext } from './types';

export function registerTaskHandlers(ctx: IpcContext): void {
  ipcMain.handle(
    INVOKE_CHANNELS.TASKS_DISPATCH,
    async (
      _event,
      stackId: string,
      prompt: string,
      model?: string,
      opts?: { gateApproved?: boolean; forceBypass?: boolean },
    ) => {
      return ctx.stackManager.dispatchTask(stackId, prompt, model, opts);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.TASKS_LIST, async (_event, stackId: string) => {
    return ctx.stackManager.getTasksForStack(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.TASKS_TOKEN_STEPS, async (_event, taskId: number) => {
    return ctx.registry.getTaskTokenSteps(taskId);
  });

  ipcMain.handle(INVOKE_CHANNELS.TASKS_WORKFLOW_PROGRESS, async (_event, stackId: string) => {
    return ctx.stackManager.getWorkflowProgress(stackId);
  });
}
