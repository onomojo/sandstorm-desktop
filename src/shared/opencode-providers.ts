/**
 * Provider→required-fields metadata for OpenCode providers.
 * Single owner: this file. Consumers (config modal, syncCredentials, config generator) import from here.
 */

export interface ProviderField {
  /** Key in the credential bundle stored in backend_secrets */
  key: string;
  label: string;
  type: 'password' | 'text' | 'url';
  required: boolean;
  /** Corresponding env var name for compose passthrough (undefined = config-only, no env var) */
  envVar?: string;
  placeholder?: string;
}

export interface ProviderMeta {
  id: string;
  label: string;
  fields: ProviderField[];
}

/**
 * Minimal shape of a provider entry returned by the OpenCode SDK's
 * `client.provider.list()`. We only declare the fields we use.
 */
export interface CatalogProvider {
  id: string;
  name: string;
  env: string[];
  models?: Record<string, unknown>;
}

/**
 * Full result shape from `client.provider.list()`.
 */
export interface CatalogProviderList {
  all: CatalogProvider[];
  default: Record<string, string>;
  connected: string[];
}

/**
 * Provider overrides: providers that need a different `providerKey` or fixed
 * credential in the OpenCode config. Only Ollama needs this — it routes to
 * the OpenAI-compatible endpoint with a fixed dummy API key.
 */
export const PROVIDER_OVERRIDES: Record<string, { providerKey: string; apiKeyOverride?: string }> = {
  'ollama': { providerKey: 'openai', apiKeyOverride: 'ollama' },
};

/**
 * Well-known provider metadata kept for backward compatibility and for
 * providers that need custom field labels / validation beyond what the
 * catalog env[] array alone can express.
 */
export const PROVIDER_METADATA: readonly ProviderMeta[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        envVar: 'ANTHROPIC_API_KEY',
        placeholder: 'sk-ant-...',
      },
    ],
  },
  {
    id: 'amazon-bedrock',
    label: 'Amazon Bedrock',
    fields: [
      {
        key: 'region',
        label: 'AWS Region',
        type: 'text',
        required: true,
        envVar: 'AWS_REGION',
        placeholder: 'us-east-1',
      },
      {
        key: 'accessKeyId',
        label: 'Access Key ID',
        type: 'text',
        required: false,
        envVar: 'AWS_ACCESS_KEY_ID',
        placeholder: 'AKIA...',
      },
      {
        key: 'secretAccessKey',
        label: 'Secret Access Key',
        type: 'password',
        required: false,
        envVar: 'AWS_SECRET_ACCESS_KEY',
      },
      {
        key: 'bearerToken',
        label: 'Bearer Token (alternative to access keys)',
        type: 'password',
        required: false,
        envVar: 'AWS_BEARER_TOKEN_BEDROCK',
      },
      {
        key: 'profile',
        label: 'AWS Profile (alternative to access keys)',
        type: 'text',
        required: false,
        envVar: 'AWS_PROFILE',
      },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    fields: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'url',
        required: true,
        placeholder: 'http://host:11434/v1',
      },
    ],
  },
] as const;

export function getProviderMeta(id: string): ProviderMeta | undefined {
  return PROVIDER_METADATA.find((p) => p.id === id);
}

/**
 * Derive ProviderField[] from a catalog provider's env[] array.
 * Type inference rules:
 *   - /KEY|TOKEN|SECRET|PASSWORD/i → 'password'
 *   - /*_BASE_URL|*URL$/i          → 'url'
 *   - everything else              → 'text'
 *
 * The field key is camelCased from the env var name.
 * All derived fields are required by default (conservative).
 */
export function deriveFieldsFromCatalogProvider(provider: CatalogProvider): ProviderField[] {
  return provider.env.map((envVar) => {
    const type: ProviderField['type'] =
      /KEY|TOKEN|SECRET|PASSWORD/i.test(envVar)
        ? 'password'
        : /BASE_URL|_URL$/i.test(envVar)
          ? 'url'
          : 'text';

    // Normalize _API_KEY suffix to 'apiKey' so buildProviderEntry's default
    // case can find the credential via bundle.apiKey regardless of provider name.
    const key = /_API_KEY$/i.test(envVar)
      ? 'apiKey'
      : envVar
          .toLowerCase()
          .replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

    const label = envVar
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());

    return {
      key,
      label,
      type,
      required: true,
      envVar,
    };
  });
}

/**
 * Build ProviderMeta for any catalog provider.
 * Returns well-known metadata for recognised IDs; derives fields from
 * env[] for unknown providers.
 */
export function buildProviderMetaFromCatalog(provider: CatalogProvider): ProviderMeta {
  const known = getProviderMeta(provider.id);
  if (known) return known;
  return {
    id: provider.id,
    label: provider.name || provider.id,
    fields: deriveFieldsFromCatalogProvider(provider),
  };
}

/**
 * Returns { providerKey, config } where providerKey is the key used in the OpenCode
 * config's provider map, and config is the value object for that provider.
 *
 * Bedrock uses 'amazon-bedrock', Ollama uses 'openai' (custom OpenAI-compatible endpoint).
 * Falls back to `{env:…}` placeholders when no bundle fields are present (container startup path).
 */
export function buildProviderEntry(
  providerId: string,
  bundle: Record<string, string>,
): { providerKey: string; config: Record<string, unknown> } {
  switch (providerId) {
    case 'anthropic':
      return {
        providerKey: 'anthropic',
        config: bundle.apiKey
          ? { apiKey: bundle.apiKey }
          : { apiKey: '{env:ANTHROPIC_API_KEY}' },
      };

    case 'amazon-bedrock': {
      const options: Record<string, string> = {};
      if (bundle.region) options.region = bundle.region;
      if (bundle.bearerToken) {
        options.bearerToken = bundle.bearerToken;
      } else {
        if (bundle.accessKeyId) options.accessKeyId = bundle.accessKeyId;
        if (bundle.secretAccessKey) options.secretAccessKey = bundle.secretAccessKey;
        if (bundle.profile) options.profile = bundle.profile;
      }
      return {
        providerKey: 'amazon-bedrock',
        config: Object.keys(options).length > 0 ? { options } : {},
      };
    }

    case 'ollama':
      return {
        providerKey: 'openai',
        config: {
          apiKey: 'ollama',
          ...(bundle.baseUrl ? { baseURL: bundle.baseUrl } : {}),
        },
      };

    default: {
      // Check PROVIDER_OVERRIDES for providers that need a different providerKey
      const override = PROVIDER_OVERRIDES[providerId];
      if (override) {
        return {
          providerKey: override.providerKey,
          config: {
            ...(override.apiKeyOverride ? { apiKey: override.apiKeyOverride } : {}),
            ...(bundle.baseUrl ? { baseURL: bundle.baseUrl } : {}),
          },
        };
      }
      // Generic env-var path: use apiKey from bundle, or env var placeholder
      return {
        providerKey: providerId,
        config: bundle.apiKey
          ? { apiKey: bundle.apiKey }
          : { apiKey: `{env:${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY}` },
      };
    }
  }
}

/**
 * Collect all env var names for a provider's fields.
 * Used by the compose generator to build the dynamic env var passthrough list.
 */
export function getProviderEnvVars(meta: ProviderMeta): string[] {
  return meta.fields.filter((f) => f.envVar).map((f) => f.envVar as string);
}
