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

    default:
      return {
        providerKey: providerId,
        config: bundle.apiKey
          ? { apiKey: bundle.apiKey }
          : { apiKey: `{env:${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY}` },
      };
  }
}
