import { ReactNode } from 'react';

export interface ConfigPane {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: string;
  disabled?: boolean;
  render: () => ReactNode;
}

export interface ModelRoutingApi {
  getEffective: (projectDir: string) => Promise<Record<string, { backend: string; model: string }>>;
  getProject: (projectDir: string) => Promise<{ assignments: Record<string, { backend: string; model: string }>; preset: string | null } | null>;
  setProject: (projectDir: string, config: { assignments?: Record<string, { backend: string; model: string }>; preset?: string | null }) => Promise<void>;
  removeProject: (projectDir: string) => Promise<void>;
  getGlobal: () => Promise<{ assignments: Record<string, { backend: string; model: string }>; preset: string | null }>;
  setGlobal: (config: { assignments?: Record<string, { backend: string; model: string }>; preset?: string | null }) => Promise<void>;
  applyPreset: (projectDir: string, presetId: string) => Promise<void>;
  getAvailableModels: (projectDir: string) => Promise<Array<{ backend: string; model: string; label: string; version: string; provider: string; needsKey?: boolean; available: boolean }>>;
}

export interface ConfigPaneContext {
  projectDir: string;
  routing: ModelRoutingApi;
  onDirtyChange: (dirty: boolean) => void;
  registerSave: (save: () => Promise<void>) => void;
}
