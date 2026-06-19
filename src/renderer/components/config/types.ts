import { ReactNode } from 'react';

export interface ConfigPane {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: string;
  disabled?: boolean;
  render: () => ReactNode;
}

export interface ProviderSecretsApi {
  status: (scope: string, provider: string) => Promise<{ set: boolean }>;
  setBundle: (scope: string, provider: string, bundle: Record<string, string>) => Promise<void>;
  remove: (scope: string, provider: string) => Promise<void>;
}

export interface ModelRoutingApi {
  getEffective: (projectDir: string) => Promise<Record<string, { backend: string; provider: string; model: string }>>;
  getProject: (projectDir: string) => Promise<{ assignments: Record<string, { backend: string; provider: string; model: string }>; preset: string | null } | null>;
  setProject: (projectDir: string, config: { assignments?: Record<string, { backend: string; provider: string; model: string }>; preset?: string | null }) => Promise<void>;
  removeProject: (projectDir: string) => Promise<void>;
  getGlobal: () => Promise<{ assignments: Record<string, { backend: string; provider: string; model: string }>; preset: string | null }>;
  setGlobal: (config: { assignments?: Record<string, { backend: string; provider: string; model: string }>; preset?: string | null }) => Promise<void>;
  applyPreset: (projectDir: string, presetId: string) => Promise<void>;
  getAvailableModels: (projectDir: string) => Promise<Array<{ backend: string; model: string; label: string; version: string; provider: string; needsKey?: boolean; available: boolean }>>;
}

export interface DarkFactoryApi {
  getConfig: (projectDir: string) => Promise<{ level: string; merge_strategy: string }>;
  setConfig: (projectDir: string, config: { level: string; merge_strategy: string }) => Promise<void>;
}

export type TicketProvider = 'github' | 'jira';

export interface ProjectTicketConfig {
  provider: TicketProvider;
  jira_url?: string | null;
  jira_username?: string | null;
  jira_api_token?: string | null;
  jira_project_key?: string | null;
  jira_issue_type?: string | null;
  ticket_prefix?: string | null;
  filter_mode?: 'assisted' | 'advanced' | null;
  filter_ownership?: 'created' | 'assigned' | null;
  filter_open_only?: boolean | null;
  filter_query?: string | null;
}

export interface TicketingApi {
  get: (projectDir: string) => Promise<ProjectTicketConfig | null>;
  set: (projectDir: string, config: ProjectTicketConfig) => Promise<void>;
}

export interface ConfigPaneContext {
  projectDir: string;
  routing: ModelRoutingApi;
  darkFactory: DarkFactoryApi;
  ticketing: TicketingApi;
  providerSecrets: ProviderSecretsApi;
  onDirtyChange: (dirty: boolean) => void;
  registerSave: (save: () => Promise<void>) => void;
}
