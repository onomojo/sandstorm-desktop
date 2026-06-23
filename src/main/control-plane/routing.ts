import path from 'path';
import type { CatalogProvider } from '../../shared/opencode-providers';

export type TouchpointId =
  | 'outer'
  | 'refine'
  | 'contract_generator'
  | 'execution'
  | 'review'
  | 'meta_review'
  | 'merge_conflict'
  | 'pr_description';

export const TOUCHPOINTS: readonly TouchpointId[] = [
  'outer',
  'refine',
  'contract_generator',
  'execution',
  'review',
  'meta_review',
  'merge_conflict',
  'pr_description',
] as const;

export type AgentBackendKind = 'claude' | 'opencode';

export interface RoutingAssignment {
  backend: AgentBackendKind;
  provider: string;
  model: string;
}

export type PresetId = 'max_quality' | 'balanced' | 'budget';

export const PRESETS: Record<PresetId, Record<TouchpointId, RoutingAssignment>> = {
  balanced: {
    outer:          { backend: 'claude', provider: 'anthropic', model: 'opus' },
    refine:         { backend: 'claude', provider: 'anthropic', model: 'sonnet' },
    contract_generator: { backend: 'claude', provider: 'anthropic', model: 'sonnet' },
    execution:      { backend: 'claude', provider: 'anthropic', model: 'sonnet' },
    review:         { backend: 'claude', provider: 'anthropic', model: 'opus' },
    meta_review:    { backend: 'claude', provider: 'anthropic', model: 'opus' },
    merge_conflict: { backend: 'claude', provider: 'anthropic', model: 'sonnet' },
    pr_description: { backend: 'claude', provider: 'anthropic', model: 'haiku' },
  },
  max_quality: {
    outer:          { backend: 'claude', provider: 'anthropic', model: 'opus' },
    refine:         { backend: 'claude', provider: 'anthropic', model: 'opus' },
    contract_generator: { backend: 'claude', provider: 'anthropic', model: 'opus' },
    execution:      { backend: 'claude', provider: 'anthropic', model: 'opus' },
    review:         { backend: 'claude', provider: 'anthropic', model: 'opus' },
    meta_review:    { backend: 'claude', provider: 'anthropic', model: 'opus' },
    merge_conflict: { backend: 'claude', provider: 'anthropic', model: 'opus' },
    pr_description: { backend: 'claude', provider: 'anthropic', model: 'sonnet' },
  },
  budget: {
    outer:          { backend: 'claude', provider: 'anthropic', model: 'sonnet' },
    refine:         { backend: 'claude', provider: 'anthropic', model: 'haiku' },
    contract_generator: { backend: 'claude', provider: 'anthropic', model: 'sonnet' },
    execution:      { backend: 'claude', provider: 'anthropic', model: 'haiku' },
    review:         { backend: 'claude', provider: 'anthropic', model: 'sonnet' },
    meta_review:    { backend: 'claude', provider: 'anthropic', model: 'sonnet' },
    merge_conflict: { backend: 'claude', provider: 'anthropic', model: 'haiku' },
    pr_description: { backend: 'claude', provider: 'anthropic', model: 'haiku' },
  },
};

export interface AvailableModel {
  backend: AgentBackendKind;
  model: string;
  label: string;
  version: string;
  provider: string;
  needsKey?: boolean;
  available: boolean;
}

export const CLAUDE_MODELS: AvailableModel[] = [
  { backend: 'claude', model: 'opus',   label: 'Opus 4.8',   version: 'claude-opus-4-8',   provider: 'anthropic', available: true },
  { backend: 'claude', model: 'sonnet', label: 'Sonnet 4.6', version: 'claude-sonnet-4-6', provider: 'anthropic', available: true },
  { backend: 'claude', model: 'haiku',  label: 'Haiku 4.5',  version: 'claude-haiku-4-5',  provider: 'anthropic', available: true },
  { backend: 'claude', model: 'auto',   label: 'Auto',       version: 'auto',              provider: 'anthropic', available: true },
];

export const OPENCODE_MODELS: AvailableModel[] = [
  {
    backend: 'opencode',
    model: 'anthropic/claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6 — Anthropic',
    version: 'anthropic/claude-sonnet-4-6',
    provider: 'anthropic',
    needsKey: true,
    available: false,
  },
  {
    backend: 'opencode',
    model: 'amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0',
    label: 'Claude 3.5 Sonnet — Amazon Bedrock',
    version: 'amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0',
    provider: 'amazon-bedrock',
    needsKey: true,
    available: false,
  },
];

export function getAvailableModels(
  projectDir: string,
  hasProviderSecret: (key: string, provider: string) => boolean,
  catalogProviders?: CatalogProvider[],
): AvailableModel[] {
  const projectKey = `project:${path.resolve(projectDir)}`;

  // Build opencode models list: start from static list, then augment with catalog
  const opencodeModels = buildOpencodeModels(hasProviderSecret, projectKey, catalogProviders);

  return [
    ...CLAUDE_MODELS,
    ...opencodeModels,
  ];
}

/**
 * Build the list of available OpenCode models. When catalog providers are
 * supplied, the list is extended with all models from all catalog providers
 * that have project-scoped credentials configured.
 */
export function buildOpencodeModels(
  hasProviderSecret: (key: string, provider: string) => boolean,
  projectKey: string,
  catalogProviders?: CatalogProvider[],
): AvailableModel[] {
  if (!catalogProviders || catalogProviders.length === 0) {
    // Fall back to static list
    return OPENCODE_MODELS.map((m) => ({
      ...m,
      available: hasProviderSecret(projectKey, m.provider),
    }));
  }

  const models: AvailableModel[] = [];
  for (const provider of catalogProviders) {
    const isAvailable = hasProviderSecret(projectKey, provider.id);
    const providerModels = provider.models
      ? Object.entries(provider.models as Record<string, { name?: string }>)
      : [];

    for (const [modelId, modelInfo] of providerModels) {
      const modelLabel = modelInfo?.name
        ? `${modelInfo.name} — ${provider.name}`
        : `${modelId} — ${provider.name}`;
      const fullModelId = `${provider.id}/${modelId}`;
      models.push({
        backend: 'opencode',
        model: fullModelId,
        label: modelLabel,
        version: fullModelId,
        provider: provider.id,
        needsKey: true,
        available: isAvailable,
      });
    }

    // If provider has no models in catalog, add a placeholder entry so it's
    // visible in the routing UI
    if (providerModels.length === 0 && isAvailable) {
      models.push({
        backend: 'opencode',
        model: `${provider.id}/default`,
        label: `${provider.name} (default)`,
        version: `${provider.id}/default`,
        provider: provider.id,
        needsKey: true,
        available: isAvailable,
      });
    }
  }

  return models;
}
