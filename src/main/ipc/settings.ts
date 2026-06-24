import { ipcMain } from 'electron';
import path from 'path';
import { INVOKE_CHANNELS } from '../ipc-channels';
import type { IpcContext } from './types';
import { getAvailableModels } from '../control-plane/routing';
import type { RoutingAssignment, PresetId } from '../control-plane/routing';
import { fetchProviderCatalog } from '../control-plane/provider-catalog';

function getBackendServerUrl(ctx: IpcContext): string | null {
  try {
    const router = ctx.agentBackend as unknown as { getOpenCodeServerUrl?: () => string | null };
    return router.getOpenCodeServerUrl?.() ?? null;
  } catch {
    return null;
  }
}

export function registerSettingsHandlers(ctx: IpcContext): void {
  // --- Model Settings ---

  ipcMain.handle(INVOKE_CHANNELS.MODEL_SETTINGS_GET_GLOBAL, () => {
    return ctx.registry.getGlobalModelSettings();
  });

  ipcMain.handle(
    INVOKE_CHANNELS.MODEL_SETTINGS_SET_GLOBAL,
    (_event, settings: { inner_model?: string; outer_model?: string }) => {
      ctx.registry.setGlobalModelSettings(settings);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.MODEL_SETTINGS_GET_PROJECT, (_event, projectDir: string) => {
    return ctx.registry.getProjectModelSettings(projectDir);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.MODEL_SETTINGS_SET_PROJECT,
    (_event, projectDir: string, settings: { inner_model?: string; outer_model?: string }) => {
      ctx.registry.setProjectModelSettings(projectDir, settings);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.MODEL_SETTINGS_REMOVE_PROJECT, (_event, projectDir: string) => {
    ctx.registry.removeProjectModelSettings(projectDir);
  });

  ipcMain.handle(INVOKE_CHANNELS.MODEL_SETTINGS_GET_EFFECTIVE, (_event, projectDir: string) => {
    return ctx.registry.getEffectiveModels(projectDir);
  });

  // --- Backend Settings ---

  ipcMain.handle(INVOKE_CHANNELS.BACKEND_SETTINGS_GET_GLOBAL, () => {
    return ctx.registry.getGlobalBackendSettings();
  });

  ipcMain.handle(
    INVOKE_CHANNELS.BACKEND_SETTINGS_SET_GLOBAL,
    (
      _event,
      settings: {
        inner_backend?: string;
        outer_backend?: string;
        inner_provider?: string | null;
        inner_model?: string | null;
        outer_provider?: string | null;
        outer_model?: string | null;
      },
    ) => {
      ctx.registry.setGlobalBackendSettings(settings);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.BACKEND_SETTINGS_GET_PROJECT, (_event, projectDir: string) => {
    return ctx.registry.getProjectBackendSettings(projectDir);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.BACKEND_SETTINGS_SET_PROJECT,
    (
      _event,
      projectDir: string,
      settings: {
        inner_backend?: string;
        outer_backend?: string;
        inner_provider?: string | null;
        inner_model?: string | null;
        outer_provider?: string | null;
        outer_model?: string | null;
      },
    ) => {
      ctx.registry.setProjectBackendSettings(projectDir, settings);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.BACKEND_SETTINGS_GET_EFFECTIVE,
    (_event, projectDir: string, surface: 'inner' | 'outer') => {
      return ctx.registry.getEffectiveBackend(projectDir, surface);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.BACKEND_SETTINGS_SET_SECRET,
    (_event, scope: string, surface: 'inner' | 'outer', name: string, value: string) => {
      const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
      ctx.registry.setBackendSecret(key, surface, name, value);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.BACKEND_SETTINGS_SECRET_STATUS,
    (_event, scope: string, surface: 'inner' | 'outer') => {
      const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
      return { set: ctx.registry.hasBackendSecret(key, surface) };
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.BACKEND_SETTINGS_SET_SECRET_BUNDLE,
    (_event, scope: string, surface: 'inner' | 'outer', bundle: Record<string, string>) => {
      const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
      ctx.registry.setBackendSecretBundle(key, surface, bundle);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.BACKEND_SETTINGS_GET_SECRET_BUNDLE,
    (_event, scope: string, surface: 'inner' | 'outer') => {
      const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
      return ctx.registry.getBackendSecretBundle(key, surface);
    },
  );

  // --- Model Routing ---

  ipcMain.handle(INVOKE_CHANNELS.MODEL_ROUTING_GET_EFFECTIVE, (_event, projectDir: string) => {
    return ctx.registry.getEffectiveRouting(projectDir);
  });

  ipcMain.handle(INVOKE_CHANNELS.MODEL_ROUTING_GET_PROJECT, (_event, projectDir: string) => {
    return ctx.registry.getProjectRouting(projectDir);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.MODEL_ROUTING_SET_PROJECT,
    (
      _event,
      projectDir: string,
      config: {
        assignments?: Partial<Record<string, RoutingAssignment>>;
        preset?: PresetId | null;
      },
    ) => {
      ctx.registry.setProjectRouting(projectDir, config);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.MODEL_ROUTING_REMOVE_PROJECT, (_event, projectDir: string) => {
    ctx.registry.removeProjectRouting(projectDir);
  });

  ipcMain.handle(INVOKE_CHANNELS.MODEL_ROUTING_GET_GLOBAL, () => {
    return ctx.registry.getGlobalRouting();
  });

  ipcMain.handle(
    INVOKE_CHANNELS.MODEL_ROUTING_SET_GLOBAL,
    (
      _event,
      config: {
        assignments?: Partial<Record<string, RoutingAssignment>>;
        preset?: PresetId | null;
      },
    ) => {
      ctx.registry.setGlobalRouting(config);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.MODEL_ROUTING_APPLY_PRESET,
    (_event, projectDir: string, presetId: PresetId) => {
      ctx.registry.applyPreset(projectDir, presetId);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.MODEL_ROUTING_GET_AVAILABLE_MODELS, (_event, projectDir: string) => {
    return getAvailableModels(projectDir, (key, provider) =>
      ctx.registry.hasProviderSecret(key, provider),
    );
  });

  ipcMain.handle(
    INVOKE_CHANNELS.MODEL_ROUTING_GET_AVAILABLE_MODELS_WITH_CATALOG,
    async (_event, projectDir: string) => {
      const catalog = await fetchProviderCatalog(getBackendServerUrl(ctx));
      return getAvailableModels(
        projectDir,
        (key, provider) => ctx.registry.hasProviderSecret(key, provider),
        catalog?.all,
      );
    },
  );
}
