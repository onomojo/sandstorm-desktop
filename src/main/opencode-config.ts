export interface OpencodeConfigInputs {
  // Placeholder for future per-task config: #477 adds model selection, #479 adds provider credentials
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
}

interface McpServer {
  type: 'local';
  command: string[];
  environment: Record<string, string>;
}

export interface OpencodeConfig {
  model: string;
  provider: Record<string, { apiKey: string }>;
  permission: string;
  instructions: string[];
  mcp: Record<string, McpServer>;
}

export const STATIC_INPUTS: OpencodeConfigInputs = {};

/**
 * Generate the inner OpenCode config (for stack-internal agents).
 * Chrome DevTools MCP only — no bridge shim.
 */
export function generateOpencodeConfig(_inputs: OpencodeConfigInputs): OpencodeConfig {
  return {
    model: 'anthropic/claude-sonnet-4-6',
    provider: {
      anthropic: {
        // Concrete var name finalized in #479; {env:…} placeholder keeps auth clean
        apiKey: '{env:ANTHROPIC_API_KEY}',
      },
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

  return {
    model: 'anthropic/claude-sonnet-4-6',
    provider: {
      anthropic: {
        apiKey: '{env:ANTHROPIC_API_KEY}',
      },
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
