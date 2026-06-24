import { ipcMain } from 'electron';
import { INVOKE_CHANNELS } from '../ipc-channels';
import type { IpcContext } from './types';

export function registerAgentHandlers(ctx: IpcContext): void {
  ipcMain.handle(
    INVOKE_CHANNELS.AGENT_SEND,
    (_event, tabId: string, message: string, projectDir?: string) => {
      ctx.agentBackend.sendMessage(tabId, message, projectDir);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.AGENT_CANCEL, (_event, tabId: string) => {
    ctx.agentBackend.cancelSession(tabId);
  });

  ipcMain.handle(INVOKE_CHANNELS.AGENT_RESET, (_event, tabId: string) => {
    ctx.agentBackend.resetSession(tabId);
  });

  ipcMain.handle(INVOKE_CHANNELS.AGENT_HISTORY, (_event, tabId: string) => {
    return ctx.agentBackend.getHistory(tabId);
  });

  ipcMain.handle(INVOKE_CHANNELS.AGENT_TOKEN_USAGE, (_event, tabId: string) => {
    return ctx.agentBackend.getSessionTokens(tabId);
  });
}
