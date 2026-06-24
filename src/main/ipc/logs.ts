import { ipcMain } from 'electron';
import { INVOKE_CHANNELS } from '../ipc-channels';
import type { IpcContext } from './types';

export function registerLogHandlers(ctx: IpcContext): void {
  ipcMain.handle(
    INVOKE_CHANNELS.LOGS_STREAM,
    async (_event, containerId: string, runtime: 'docker' | 'podman') => {
      const rt = runtime === 'podman' ? ctx.podmanRuntime : ctx.dockerRuntime;
      const lines: string[] = [];
      for await (const line of rt.logs(containerId, { tail: 200 })) {
        lines.push(line);
      }
      return lines.join('');
    },
  );
}
