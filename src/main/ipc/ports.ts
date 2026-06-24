import { ipcMain } from 'electron';
import { INVOKE_CHANNELS } from '../ipc-channels';
import type { IpcContext } from './types';
import { cleanupLegacyPorts } from '../compose-generator';

export function registerPortHandlers(ctx: IpcContext): void {
  ipcMain.handle(INVOKE_CHANNELS.PORTS_GET, async (_event, stackId: string) => {
    return ctx.registry.getPorts(stackId);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.STACK_EXPOSE_PORT,
    async (_event, stackId: string, service: string, containerPort: number) => {
      return ctx.stackManager.exposePort(stackId, service, containerPort);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.STACK_UNEXPOSE_PORT,
    async (_event, stackId: string, service: string, containerPort: number) => {
      await ctx.stackManager.unexposePort(stackId, service, containerPort);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.PORTS_CLEANUP_LEGACY, async (_event, directory: string) => {
    return cleanupLegacyPorts(directory);
  });
}
