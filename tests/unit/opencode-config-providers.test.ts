import { describe, it, expect } from 'vitest';
import { generateOpencodeConfig, generateOuterOpencodeConfig } from '../../src/main/opencode-config';

describe('generateOpencodeConfig — provider credential mapping', () => {
  it('anthropic with apiKey bundle embeds the actual key', () => {
    const config = generateOpencodeConfig({
      providerId: 'anthropic',
      bundle: { apiKey: 'sk-ant-test-123' },
    });
    expect(config.provider['anthropic']?.apiKey).toBe('sk-ant-test-123');
    expect(config.provider['anthropic']?.apiKey).not.toMatch(/^\{env:/);
  });

  it('anthropic with no bundle uses env placeholder', () => {
    const config = generateOpencodeConfig({ providerId: 'anthropic', bundle: {} });
    expect(config.provider['anthropic']?.apiKey).toBe('{env:ANTHROPIC_API_KEY}');
  });

  it('amazon-bedrock with access keys produces options block', () => {
    const config = generateOpencodeConfig({
      providerId: 'amazon-bedrock',
      bundle: { region: 'us-east-1', accessKeyId: 'AKID', secretAccessKey: 'SAK' },
    });
    expect(config.provider['amazon-bedrock']).toBeDefined();
    const opts = config.provider['amazon-bedrock']?.options as Record<string, string>;
    expect(opts.region).toBe('us-east-1');
    expect(opts.accessKeyId).toBe('AKID');
    expect(opts.secretAccessKey).toBe('SAK');
  });

  it('amazon-bedrock bearer token takes precedence over access keys', () => {
    const config = generateOpencodeConfig({
      providerId: 'amazon-bedrock',
      bundle: {
        region: 'us-west-2',
        accessKeyId: 'AKID',
        secretAccessKey: 'SAK',
        bearerToken: 'bt-real',
      },
    });
    const opts = config.provider['amazon-bedrock']?.options as Record<string, string>;
    expect(opts.bearerToken).toBe('bt-real');
    expect(opts.accessKeyId).toBeUndefined();
    expect(opts.secretAccessKey).toBeUndefined();
  });

  it('ollama maps to provider key "openai" with baseURL', () => {
    const config = generateOpencodeConfig({
      providerId: 'ollama',
      bundle: { baseUrl: 'http://myhost:11434/v1' },
      model: 'openai/llama3',
    });
    expect(config.provider['openai']).toBeDefined();
    expect(config.provider['openai']?.apiKey).toBe('ollama');
    expect(config.provider['openai']?.baseURL).toBe('http://myhost:11434/v1');
    expect(config.model).toBe('openai/llama3');
    expect(config.provider['anthropic']).toBeUndefined();
  });

  it('custom model override is respected', () => {
    const config = generateOpencodeConfig({
      model: 'amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0',
      providerId: 'amazon-bedrock',
      bundle: { region: 'eu-west-1' },
    });
    expect(config.model).toBe('amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0');
  });

  it('default model is anthropic/claude-sonnet-4-6 when unspecified', () => {
    const config = generateOpencodeConfig({});
    expect(config.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('clean-auth: no embedded OAuth credentials for any provider', () => {
    const configs = [
      generateOpencodeConfig({ providerId: 'anthropic', bundle: { apiKey: 'sk-test' } }),
      generateOpencodeConfig({ providerId: 'amazon-bedrock', bundle: { region: 'us-east-1', bearerToken: 'bt' } }),
      generateOpencodeConfig({ providerId: 'ollama', bundle: { baseUrl: 'http://host:11434/v1' } }),
    ];
    for (const config of configs) {
      const json = JSON.stringify(config);
      expect(json).not.toContain('refresh_token');
      expect(json).not.toContain('access_token');
      expect(json).not.toContain('oauth_token');
    }
  });

  it('non-Anthropic provider is selected when specified (mocked-transport: config env selects active credential)', () => {
    // This is the "mocked-transport" assertion from Q3: given a non-Anthropic bundle,
    // the generated config references the active credential — not the Anthropic placeholder.
    const bedrockConfig = generateOpencodeConfig({
      providerId: 'amazon-bedrock',
      bundle: { region: 'us-east-1', bearerToken: 'bt-active' },
    });
    // Active credential is embedded; no Anthropic env placeholder present
    expect(JSON.stringify(bedrockConfig)).not.toContain('{env:ANTHROPIC_API_KEY}');
    expect(JSON.stringify(bedrockConfig)).toContain('bt-active');
    expect(bedrockConfig.provider['anthropic']).toBeUndefined();
    expect(bedrockConfig.provider['amazon-bedrock']).toBeDefined();
  });
});

describe('generateOuterOpencodeConfig — provider support', () => {
  const baseInputs = {
    shimPath: '/dist/main/orchestration-mcp-shim.cjs',
    bridgeUrl: 'http://127.0.0.1:9999',
    bridgeToken: 'tok-test',
    instructionsPath: '/home/user/.sandstorm/SANDSTORM_OUTER.md',
  };

  it('anthropic outer config uses env placeholder when no bundle', () => {
    const config = generateOuterOpencodeConfig({ ...baseInputs });
    expect(config.provider['anthropic']?.apiKey).toBe('{env:ANTHROPIC_API_KEY}');
  });

  it('outer bedrock config embeds credentials from bundle', () => {
    const config = generateOuterOpencodeConfig({
      ...baseInputs,
      providerId: 'amazon-bedrock',
      bundle: { region: 'us-east-1', accessKeyId: 'AKID', secretAccessKey: 'SAK' },
    });
    const opts = config.provider['amazon-bedrock']?.options as Record<string, string>;
    expect(opts.region).toBe('us-east-1');
    expect(opts.accessKeyId).toBe('AKID');
  });

  it('outer ollama config maps to openai provider', () => {
    const config = generateOuterOpencodeConfig({
      ...baseInputs,
      providerId: 'ollama',
      bundle: { baseUrl: 'http://host:11434/v1' },
    });
    expect(config.provider['openai']?.baseURL).toBe('http://host:11434/v1');
  });
});
