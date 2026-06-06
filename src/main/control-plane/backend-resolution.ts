/**
 * Pure, electron-free, sqlite-free module for resolving the effective backend.
 *
 * Tests import this module directly without needing vi.mock('electron').
 */

export type BackendType = 'claude' | 'opencode';

export interface GlobalBackendInput {
  inner_backend: BackendType;
  outer_backend: BackendType;
  inner_provider: string | null;
  inner_model: string | null;
  outer_provider: string | null;
  outer_model: string | null;
}

export interface ProjectBackendInput {
  inner_backend: string;
  outer_backend: string;
  inner_provider: string | null;
  inner_model: string | null;
  outer_provider: string | null;
  outer_model: string | null;
}

export interface EffectiveBackend {
  backend: BackendType;
  provider?: string;
  model?: string;
}

/**
 * Resolve the effective backend for a given surface.
 * Resolution: project value > 'global' sentinel falls back to global > absent project row uses global.
 */
export function resolveEffectiveBackend(
  global: GlobalBackendInput,
  project: ProjectBackendInput | null,
  surface: 'inner' | 'outer',
): EffectiveBackend {
  const globalBackend = surface === 'inner' ? global.inner_backend : global.outer_backend;
  const globalProvider = surface === 'inner' ? global.inner_provider : global.outer_provider;
  const globalModel = surface === 'inner' ? global.inner_model : global.outer_model;

  if (!project) {
    return {
      backend: globalBackend,
      ...(globalProvider ? { provider: globalProvider } : {}),
      ...(globalModel ? { model: globalModel } : {}),
    };
  }

  const backendRaw = surface === 'inner' ? project.inner_backend : project.outer_backend;
  const backend: BackendType = backendRaw === 'global' ? globalBackend : (backendRaw as BackendType);

  const providerRaw = surface === 'inner' ? project.inner_provider : project.outer_provider;
  const provider = (providerRaw == null || providerRaw === 'global') ? globalProvider : providerRaw;

  const modelRaw = surface === 'inner' ? project.inner_model : project.outer_model;
  const model = (modelRaw == null || modelRaw === 'global') ? globalModel : modelRaw;

  return {
    backend,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}
