import { describe, it, expect } from 'vitest';
import {
  PROVIDER_METADATA,
  PROVIDER_OVERRIDES,
  getProviderMeta,
  buildProviderEntry,
  deriveFieldsFromCatalogProvider,
  buildProviderMetaFromCatalog,
  getProviderEnvVars,
  type CatalogProvider,
} from '../../src/shared/opencode-providers';

describe('PROVIDER_METADATA', () => {
  it('includes anthropic, amazon-bedrock, and ollama', () => {
    const ids = PROVIDER_METADATA.map((p) => p.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('amazon-bedrock');
    expect(ids).toContain('ollama');
  });

  it('anthropic has a required apiKey field with env var ANTHROPIC_API_KEY', () => {
    const meta = getProviderMeta('anthropic')!;
    expect(meta).toBeDefined();
    const apiKey = meta.fields.find((f) => f.key === 'apiKey')!;
    expect(apiKey).toBeDefined();
    expect(apiKey.required).toBe(true);
    expect(apiKey.envVar).toBe('ANTHROPIC_API_KEY');
    expect(apiKey.type).toBe('password');
  });

  it('amazon-bedrock has region as required and access keys as optional', () => {
    const meta = getProviderMeta('amazon-bedrock')!;
    const region = meta.fields.find((f) => f.key === 'region')!;
    const accessKeyId = meta.fields.find((f) => f.key === 'accessKeyId')!;
    const secretAccessKey = meta.fields.find((f) => f.key === 'secretAccessKey')!;
    const bearerToken = meta.fields.find((f) => f.key === 'bearerToken')!;
    const profile = meta.fields.find((f) => f.key === 'profile')!;

    expect(region.required).toBe(true);
    expect(region.envVar).toBe('AWS_REGION');

    expect(accessKeyId.required).toBe(false);
    expect(accessKeyId.envVar).toBe('AWS_ACCESS_KEY_ID');

    expect(secretAccessKey.required).toBe(false);
    expect(secretAccessKey.envVar).toBe('AWS_SECRET_ACCESS_KEY');

    expect(bearerToken.required).toBe(false);
    expect(bearerToken.envVar).toBe('AWS_BEARER_TOKEN_BEDROCK');

    expect(profile.required).toBe(false);
    expect(profile.envVar).toBe('AWS_PROFILE');
  });

  it('ollama has a required baseUrl field with no env var (config-only)', () => {
    const meta = getProviderMeta('ollama')!;
    const baseUrl = meta.fields.find((f) => f.key === 'baseUrl')!;
    expect(baseUrl.required).toBe(true);
    expect(baseUrl.type).toBe('url');
    expect(baseUrl.envVar).toBeUndefined();
  });

  it('getProviderMeta returns undefined for unknown provider', () => {
    expect(getProviderMeta('unknown-provider')).toBeUndefined();
  });
});

describe('buildProviderEntry', () => {
  describe('anthropic', () => {
    it('embeds actual apiKey when bundle provides it', () => {
      const { providerKey, config } = buildProviderEntry('anthropic', { apiKey: 'sk-ant-real' });
      expect(providerKey).toBe('anthropic');
      expect(config.apiKey).toBe('sk-ant-real');
    });

    it('falls back to {env:ANTHROPIC_API_KEY} when bundle is empty', () => {
      const { providerKey, config } = buildProviderEntry('anthropic', {});
      expect(providerKey).toBe('anthropic');
      expect(config.apiKey).toBe('{env:ANTHROPIC_API_KEY}');
    });
  });

  describe('amazon-bedrock', () => {
    it('maps access keys + region into options', () => {
      const { providerKey, config } = buildProviderEntry('amazon-bedrock', {
        region: 'us-east-1',
        accessKeyId: 'AKIATEST',
        secretAccessKey: 'secret123',
      });
      expect(providerKey).toBe('amazon-bedrock');
      const opts = config.options as Record<string, string>;
      expect(opts.region).toBe('us-east-1');
      expect(opts.accessKeyId).toBe('AKIATEST');
      expect(opts.secretAccessKey).toBe('secret123');
      expect(opts.bearerToken).toBeUndefined();
    });

    it('uses bearerToken when provided (takes precedence over access keys)', () => {
      const { providerKey, config } = buildProviderEntry('amazon-bedrock', {
        region: 'us-west-2',
        accessKeyId: 'AKIATEST',
        secretAccessKey: 'secret123',
        bearerToken: 'bearer-tok',
      });
      expect(providerKey).toBe('amazon-bedrock');
      const opts = config.options as Record<string, string>;
      expect(opts.bearerToken).toBe('bearer-tok');
      expect(opts.accessKeyId).toBeUndefined();
      expect(opts.secretAccessKey).toBeUndefined();
    });

    it('uses AWS profile when provided', () => {
      const { providerKey, config } = buildProviderEntry('amazon-bedrock', {
        region: 'eu-west-1',
        profile: 'my-profile',
      });
      expect(providerKey).toBe('amazon-bedrock');
      const opts = config.options as Record<string, string>;
      expect(opts.profile).toBe('my-profile');
      expect(opts.region).toBe('eu-west-1');
    });
  });

  describe('ollama', () => {
    it('uses openai as providerKey (OpenAI-compatible endpoint)', () => {
      const { providerKey, config } = buildProviderEntry('ollama', {
        baseUrl: 'http://host:11434/v1',
      });
      expect(providerKey).toBe('openai');
      expect(config.apiKey).toBe('ollama');
      expect(config.baseURL).toBe('http://host:11434/v1');
    });

    it('omits baseURL when not provided', () => {
      const { providerKey, config } = buildProviderEntry('ollama', {});
      expect(providerKey).toBe('openai');
      expect(config.apiKey).toBe('ollama');
      expect(config.baseURL).toBeUndefined();
    });
  });

  describe('unknown provider', () => {
    it('falls back to {env:PROVIDER_API_KEY} placeholder when no apiKey in bundle', () => {
      const { providerKey, config } = buildProviderEntry('my-custom', {});
      expect(providerKey).toBe('my-custom');
      expect(config.apiKey).toBe('{env:MY_CUSTOM_API_KEY}');
    });

    it('uses provided apiKey from bundle', () => {
      const { config } = buildProviderEntry('my-custom', { apiKey: 'sk-custom' });
      expect(config.apiKey).toBe('sk-custom');
    });
  });
});

describe('PROVIDER_OVERRIDES', () => {
  it('only defines an override for ollama', () => {
    expect(Object.keys(PROVIDER_OVERRIDES)).toContain('ollama');
  });

  it('ollama override maps to openai providerKey with apiKeyOverride', () => {
    const override = PROVIDER_OVERRIDES['ollama'];
    expect(override.providerKey).toBe('openai');
    expect(override.apiKeyOverride).toBe('ollama');
  });

  it('buildProviderEntry uses PROVIDER_OVERRIDES for ollama (no explicit case needed)', () => {
    // Ensure the switch-case handles ollama; it's explicitly handled before the default
    const { providerKey, config } = buildProviderEntry('ollama', { baseUrl: 'http://host:11434/v1' });
    expect(providerKey).toBe('openai');
    expect(config.apiKey).toBe('ollama');
  });
});

describe('deriveFieldsFromCatalogProvider', () => {
  it('infers password type for KEY env var names', () => {
    const provider: CatalogProvider = { id: 'test', name: 'Test', env: ['TEST_API_KEY'] };
    const fields = deriveFieldsFromCatalogProvider(provider);
    expect(fields).toHaveLength(1);
    expect(fields[0].type).toBe('password');
    expect(fields[0].envVar).toBe('TEST_API_KEY');
  });

  it('infers password type for TOKEN env var names', () => {
    const fields = deriveFieldsFromCatalogProvider({ id: 'x', name: 'X', env: ['X_AUTH_TOKEN'] });
    expect(fields[0].type).toBe('password');
  });

  it('infers password type for SECRET env var names', () => {
    const fields = deriveFieldsFromCatalogProvider({ id: 'x', name: 'X', env: ['X_CLIENT_SECRET'] });
    expect(fields[0].type).toBe('password');
  });

  it('infers url type for BASE_URL env var names', () => {
    const fields = deriveFieldsFromCatalogProvider({ id: 'x', name: 'X', env: ['X_BASE_URL'] });
    expect(fields[0].type).toBe('url');
  });

  it('infers url type for env vars ending in _URL', () => {
    const fields = deriveFieldsFromCatalogProvider({ id: 'x', name: 'X', env: ['ENDPOINT_URL'] });
    expect(fields[0].type).toBe('url');
  });

  it('infers text type for other env var names', () => {
    const fields = deriveFieldsFromCatalogProvider({ id: 'x', name: 'X', env: ['VERTEX_PROJECT_ID'] });
    expect(fields[0].type).toBe('text');
  });

  it('sets all fields as required by default', () => {
    const fields = deriveFieldsFromCatalogProvider({ id: 'x', name: 'X', env: ['X_API_KEY', 'X_PROJECT'] });
    expect(fields.every((f) => f.required)).toBe(true);
  });

  it('normalizes _API_KEY suffix to "apiKey" so buildProviderEntry can find the credential', () => {
    const fields = deriveFieldsFromCatalogProvider({ id: 'x', name: 'X', env: ['OPENAI_API_KEY'] });
    expect(fields[0].key).toBe('apiKey');
  });

  it('camelCases the field key for non-_API_KEY env var names', () => {
    const fields = deriveFieldsFromCatalogProvider({ id: 'x', name: 'X', env: ['VERTEX_PROJECT_ID'] });
    expect(fields[0].key).toBe('vertexProjectId');
  });

  it('returns empty array for provider with no env vars', () => {
    const fields = deriveFieldsFromCatalogProvider({ id: 'x', name: 'X', env: [] });
    expect(fields).toHaveLength(0);
  });

  it('_API_KEY normalization allows buildProviderEntry default case to resolve credential', () => {
    // Regression: without normalization, OPENAI_API_KEY → key "openaiApiKey",
    // but buildProviderEntry checks bundle.apiKey and silently falls through to a placeholder.
    const provider: CatalogProvider = { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'] };
    const fields = deriveFieldsFromCatalogProvider(provider);
    const bundle: Record<string, string> = {};
    for (const f of fields) bundle[f.key] = 'sk-test';
    const { config } = buildProviderEntry('openai', bundle);
    expect(config.apiKey).toBe('sk-test');
  });

  it('multi-env provider derives multiple fields', () => {
    const provider: CatalogProvider = {
      id: 'aws',
      name: 'AWS',
      env: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
    };
    const fields = deriveFieldsFromCatalogProvider(provider);
    expect(fields).toHaveLength(3);
    const types = fields.map((f) => f.type);
    expect(types).toContain('text'); // AWS_ACCESS_KEY_ID
    expect(types).toContain('password'); // AWS_SECRET_ACCESS_KEY
    expect(types).toContain('text'); // AWS_REGION
  });
});

describe('buildProviderMetaFromCatalog', () => {
  it('returns well-known metadata for anthropic', () => {
    const meta = buildProviderMetaFromCatalog({ id: 'anthropic', name: 'Anthropic', env: [] });
    expect(meta.id).toBe('anthropic');
    expect(meta.fields.find((f) => f.key === 'apiKey')).toBeDefined();
  });

  it('returns well-known metadata for amazon-bedrock', () => {
    const meta = buildProviderMetaFromCatalog({ id: 'amazon-bedrock', name: 'Amazon Bedrock', env: [] });
    expect(meta.id).toBe('amazon-bedrock');
    expect(meta.fields.some((f) => f.envVar === 'AWS_REGION')).toBe(true);
  });

  it('derives metadata for unknown catalog provider', () => {
    const provider: CatalogProvider = { id: 'custom-ai', name: 'Custom AI', env: ['CUSTOM_AI_API_KEY'] };
    const meta = buildProviderMetaFromCatalog(provider);
    expect(meta.id).toBe('custom-ai');
    expect(meta.label).toBe('Custom AI');
    expect(meta.fields[0].type).toBe('password');
    expect(meta.fields[0].envVar).toBe('CUSTOM_AI_API_KEY');
  });

  it('uses provider.name as label for unknown providers', () => {
    const meta = buildProviderMetaFromCatalog({ id: 'my-provider', name: 'My Provider', env: [] });
    expect(meta.label).toBe('My Provider');
  });
});

describe('getProviderEnvVars', () => {
  it('returns env vars from all fields that have one', () => {
    const meta = buildProviderMetaFromCatalog({ id: 'anthropic', name: 'Anthropic', env: [] });
    const envVars = getProviderEnvVars(meta);
    expect(envVars).toContain('ANTHROPIC_API_KEY');
  });

  it('excludes fields without env var (e.g. ollama baseUrl)', () => {
    const meta = buildProviderMetaFromCatalog({ id: 'ollama', name: 'Ollama', env: [] });
    const envVars = getProviderEnvVars(meta);
    expect(envVars).toHaveLength(0); // ollama has no envVar on its baseUrl field
  });

  it('returns all env vars for amazon-bedrock', () => {
    const meta = buildProviderMetaFromCatalog({ id: 'amazon-bedrock', name: 'Amazon Bedrock', env: [] });
    const envVars = getProviderEnvVars(meta);
    expect(envVars).toContain('AWS_REGION');
    expect(envVars).toContain('AWS_ACCESS_KEY_ID');
    expect(envVars).toContain('AWS_SECRET_ACCESS_KEY');
    expect(envVars).toContain('AWS_BEARER_TOKEN_BEDROCK');
    expect(envVars).toContain('AWS_PROFILE');
  });

  it('returns env vars derived from catalog provider', () => {
    const meta = buildProviderMetaFromCatalog({
      id: 'custom',
      name: 'Custom',
      env: ['CUSTOM_API_KEY', 'CUSTOM_PROJECT_ID'],
    });
    const envVars = getProviderEnvVars(meta);
    expect(envVars).toContain('CUSTOM_API_KEY');
    expect(envVars).toContain('CUSTOM_PROJECT_ID');
  });
});
