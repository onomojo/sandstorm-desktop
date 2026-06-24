import { ipcMain } from 'electron';
import path from 'path';
import { INVOKE_CHANNELS } from '../ipc-channels';
import type { IpcContext } from './types';
import { fetchProviderCatalog } from '../control-plane/provider-catalog';

function getBackendServerUrl(ctx: IpcContext): string | null {
  try {
    const router = ctx.agentBackend as unknown as { getOpenCodeServerUrl?: () => string | null };
    return router.getOpenCodeServerUrl?.() ?? null;
  } catch {
    return null;
  }
}

export function registerProviderHandlers(ctx: IpcContext): void {
  ipcMain.handle(
    INVOKE_CHANNELS.PROVIDER_SECRETS_STATUS,
    (_event, scope: string, provider: string) => {
      const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
      return { set: ctx.registry.hasProviderSecret(key, provider) };
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.PROVIDER_SECRETS_GET,
    (_event, scope: string, provider: string) => {
      const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
      return ctx.registry.getProviderSecretBundle(key, provider);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.PROVIDER_SECRETS_GET_BUNDLE,
    (_event, scope: string, provider: string) => {
      const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
      return ctx.registry.getProviderSecretBundle(key, provider);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.PROVIDER_SECRETS_SET,
    (_event, scope: string, provider: string, bundle: Record<string, string>) => {
      const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
      ctx.registry.setProviderSecretBundle(key, provider, bundle);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.PROVIDER_SECRETS_SET_BUNDLE,
    (_event, scope: string, provider: string, bundle: Record<string, string>) => {
      const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
      ctx.registry.setProviderSecretBundle(key, provider, bundle);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.PROVIDER_SECRETS_REMOVE,
    (_event, scope: string, provider: string) => {
      const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
      ctx.registry.removeProviderSecret(key, provider);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.PROVIDERS_CATALOG, async () => {
    return fetchProviderCatalog(getBackendServerUrl(ctx));
  });

  ipcMain.handle(INVOKE_CHANNELS.PROVIDERS_CONFIGURED, (_event, scope: string) => {
    const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
    return ctx.registry.getStoredProviderKeys(key);
  });
}
