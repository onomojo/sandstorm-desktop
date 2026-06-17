import { buildProviderEntry } from '../shared/opencode-providers';

export interface OpencodeConfigInputs {
  /**
   * OpenCode provider ID (e.g. 'anthropic', 'amazon-bedrock', 'ollama').
   * Defaults to 'anthropic' when omitted.
   */
  providerId?: string;
  /**
   * Credential bundle for the selected provider (field key → value).
   * When omitted, env-var placeholders are used (container startup path).
   */
  bundle?: Record<string, string>;
  /**
   * Override model string, e.g. 'anthropic/claude-sonnet-4-6' or
   * 'amazon-bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0'.
   * Defaults to 'anthropic/claude-sonnet-4-6'.
   */
  model?: string;
}

export interface OuterOpencodeConfigInputs {
  /** Absolute path to the compiled orchestration-mcp-shim.cjs */
  shimPath: string;
  /** URL of the in-process bridge server, e.g. http://127.0.0.1:PORT */
  bridgeUrl: string;
  /** Auth token for the bridge */
  bridgeToken: string;
  /** Absolute path to SANDSTORM_OUTER.md (outer orchestrator system prompt) */
  instructionsPath: string;
  /** Provider ID for the outer agent (defaults to 'anthropic') */
  providerId?: string;
  /** Credential bundle for the outer agent's provider */
  bundle?: Record<string, string>;
  /** Override model for the outer agent */
  model?: string;
}

interface McpServer {
  type: 'local';
  command: string[];
  environment: Record<string, string>;
}

export interface OpencodeConfig {
  model: string;
  provider: Record<string, {
    apiKey?: string;
    baseURL?: string;
    region?: string;
    options?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  permission: string;
  instructions: string[];
  mcp: Record<string, McpServer>;
}

export const STATIC_INPUTS: OpencodeConfigInputs = {};

/**
 * Generate the inner OpenCode config (for stack-internal agents).
 * Chrome DevTools MCP only — no bridge shim.
 *
 * When bundle is provided, actual credential values are embedded directly.
 * When bundle is absent, {env:…} placeholders are used — the container
 * entrypoint passes the vars via compose env passthrough.
 */
export function generateOpencodeConfig(inputs: OpencodeConfigInputs = {}): OpencodeConfig {
  const providerId = inputs.providerId ?? 'anthropic';
  const bundle = inputs.bundle ?? {};
  const { providerKey, config: providerConfig } = buildProviderEntry(providerId, bundle);

  return {
    model: inputs.model ?? 'anthropic/claude-sonnet-4-6',
    provider: {
      [providerKey]: providerConfig,
    },
    permission: 'allow',
    instructions: ['/home/claude/.claude/CLAUDE.md'],
    mcp: {
      'chrome-devtools': {
        type: 'local',
        // OpenCode flattens command+args into a single array; renames env→environment
        command: [
          'chrome-devtools-mcp',
          '--headless',
          '--no-usage-statistics',
          '--isolated',
          '--acceptInsecureCerts',
          '--executablePath',
          '/usr/bin/chromium',
          '--chromeArg=--no-sandbox',
          '--chromeArg=--disable-dev-shm-usage',
          '--chromeArg=--allow-insecure-localhost',
        ],
        environment: {
          CHROME_PATH: '/usr/bin/chromium',
          PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium',
        },
      },
    },
  };
}

/**
 * Generate the outer OpenCode config (for the orchestrator agent).
 * Includes the Sandstorm bridge shim as an MCP server so the orchestrator
 * can call create_stack, dispatch_task, etc. via standard MCP tool calls.
 *
 * The McpServer shape is the committed interface: { type:'local'; command:string[];
 * environment: Record<string,string> } — verified at src/main/opencode-config.ts:5-9.
 */
export function generateOuterOpencodeConfig(inputs: OuterOpencodeConfigInputs): OpencodeConfig {
  const shimMcpServer: McpServer = {
    type: 'local',
    command: [process.execPath, inputs.shimPath],
    environment: {
      SANDSTORM_BRIDGE_URL: inputs.bridgeUrl,
      SANDSTORM_BRIDGE_TOKEN: inputs.bridgeToken,
    },
  };

  const providerId = inputs.providerId ?? 'anthropic';
  const bundle = inputs.bundle ?? {};
  const { providerKey, config: providerConfig } = buildProviderEntry(providerId, bundle);

  return {
    model: inputs.model ?? 'anthropic/claude-sonnet-4-6',
    provider: {
      [providerKey]: providerConfig,
    },
    permission: 'allow',
    instructions: [inputs.instructionsPath],
    mcp: {
      'sandstorm-bridge': shimMcpServer,
    },
  };
}

if (require.main === module) {
  process.stdout.write(JSON.stringify(generateOpencodeConfig(STATIC_INPUTS), null, 2) + '\n');
}
