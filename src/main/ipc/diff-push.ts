import { ipcMain } from 'electron';
import { INVOKE_CHANNELS } from '../ipc-channels';
import type { IpcContext } from './types';

export function registerDiffPushHandlers(ctx: IpcContext): void {
  ipcMain.handle(INVOKE_CHANNELS.DIFF_GET, async (_event, stackId: string) => {
    return ctx.stackManager.getDiff(stackId);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.PUSH_EXECUTE,
    async (_event, stackId: string, message?: string) => {
      await ctx.stackManager.push(stackId, message);
    },
  );
}
