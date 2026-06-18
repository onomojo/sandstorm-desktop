import path from 'path';

export type TouchpointId =
  | 'outer'
  | 'refine'
  | 'execution'
  | 'review'
  | 'meta_review'
  | 'merge_conflict'
  | 'pr_description';

export const TOUCHPOINTS: readonly TouchpointId[] = [
  'outer',
  'refine',
  'execution',
  'review',
  'meta_review',
  'merge_conflict',
  'pr_description',
] as const;

export type AgentBackendKind = 'claude' | 'opencode';

export interface RoutingAssignment {
  backend: AgentBackendKind;
  model: string;
}

export type PresetId = 'max_quality' | 'balanced' | 'budget';

export const PRESETS: Record<PresetId, Record<TouchpointId, RoutingAssignment>> = {
  balanced: {
    outer:          { backend: 'claude', model: 'opus' },
    refine:         { backend: 'claude', model: 'sonnet' },
    execution:      { backend: 'claude', model: 'sonnet' },
    review:         { backend: 'claude', model: 'opus' },
    meta_review:    { backend: 'claude', model: 'opus' },
    merge_conflict: { backend: 'claude', model: 'sonnet' },
    pr_description: { backend: 'claude', model: 'haiku' },
  },
  max_quality: {
    outer:          { backend: 'claude', model: 'opus' },
    refine:         { backend: 'claude', model: 'opus' },
    execution:      { backend: 'claude', model: 'opus' },
    review:         { backend: 'claude', model: 'opus' },
    meta_review:    { backend: 'claude', model: 'opus' },
    merge_conflict: { backend: 'claude', model: 'opus' },
    pr_description: { backend: 'claude', model: 'sonnet' },
  },
  budget: {
    outer:          { backend: 'claude', model: 'sonnet' },
    refine:         { backend: 'claude', model: 'haiku' },
    execution:      { backend: 'claude', model: 'haiku' },
    review:         { backend: 'claude', model: 'sonnet' },
    meta_review:    { backend: 'claude', model: 'sonnet' },
    merge_conflict: { backend: 'claude', model: 'haiku' },
    pr_description: { backend: 'claude', model: 'haiku' },
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
  hasBackendSecret: (key: string, surface: 'inner' | 'outer') => boolean,
): AvailableModel[] {
  const projectKey = `project:${path.resolve(projectDir)}`;
  const ocAvailable =
    hasBackendSecret(projectKey, 'inner') ||
    hasBackendSecret(projectKey, 'outer') ||
    hasBackendSecret('global', 'inner') ||
    hasBackendSecret('global', 'outer');

  return [
    ...CLAUDE_MODELS,
    ...OPENCODE_MODELS.map((m) => ({ ...m, available: ocAvailable })),
  ];
}
