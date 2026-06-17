import { describe, it, expect } from 'vitest';
import {
  PROVIDER_METADATA,
  getProviderMeta,
  buildProviderEntry,
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
