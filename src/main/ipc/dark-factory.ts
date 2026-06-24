import { ipcMain } from 'electron';
import { INVOKE_CHANNELS } from '../ipc-channels';
import type { IpcContext } from './types';

export function registerDarkFactoryHandlers(ctx: IpcContext): void {
  ipcMain.handle(INVOKE_CHANNELS.DARK_FACTORY_GET_ENABLED, (_event, projectDir: string) => {
    return ctx.registry.getDarkFactoryEnabled(projectDir);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.DARK_FACTORY_SET_ENABLED,
    (_event, projectDir: string, enabled: boolean) => {
      const prior = ctx.registry.getDarkFactoryEnabled(projectDir);
      ctx.registry.setDarkFactoryEnabled(projectDir, enabled);
      if (!prior && enabled) {
        ctx.darkFactoryOrchestrator?.handleDarkFactoryEnabled(projectDir).catch((err) => {
          console.warn('[DarkFactory] handleDarkFactoryEnabled failed:', err);
        });
      }
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.DARK_FACTORY_GET_CONFIG, (_event, projectDir: string) => {
    return ctx.registry.getDarkFactoryConfig(projectDir);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.DARK_FACTORY_SET_CONFIG,
    (_event, projectDir: string, config: { level: string; merge_strategy: string }) => {
      ctx.registry.setDarkFactoryConfig(projectDir, config);
    },
  );
}
