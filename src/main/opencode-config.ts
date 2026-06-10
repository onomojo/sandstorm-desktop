export interface OpencodeConfigInputs {
  // Placeholder for future per-task config: #477 adds model selection, #479 adds provider credentials
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

if (require.main === module) {
  process.stdout.write(JSON.stringify(generateOpencodeConfig(STATIC_INPUTS), null, 2) + '\n');
}
