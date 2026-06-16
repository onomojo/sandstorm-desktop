/**
 * Sandstorm Orchestration Bridge — stdio MCP shim.
 *
 * Spawned by OpenCodeBackend as a local MCP server. Reads SANDSTORM_BRIDGE_URL
 * and SANDSTORM_BRIDGE_TOKEN from env, then proxies MCP tool/call requests to
 * the in-process HTTP bridge.
 *
 * Protocol: newline-delimited JSON-RPC 2.0 on stdio (MCP stdio transport).
 * Each message is a single line; notifications have no id and expect no reply.
 */

import * as http from 'http';
import * as readline from 'readline';

const BRIDGE_URL = process.env.SANDSTORM_BRIDGE_URL ?? '';
const BRIDGE_TOKEN = process.env.SANDSTORM_BRIDGE_TOKEN ?? '';

// ---------------------------------------------------------------------------
// Static tool manifest — mirrors handleToolCall's switch cases.
// Schemas are intentionally minimal: the LLM needs names/descriptions but the
// bridge accepts any JSON object as input and validates server-side.
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'create_stack',
    description: 'Create a new Sandstorm agent stack',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        projectDir: { type: 'string' },
        ticket: { type: 'string' },
        branch: { type: 'string' },
        description: { type: 'string' },
        runtime: { type: 'string', enum: ['docker', 'podman'] },
        task: { type: 'string' },
        model: { type: 'string' },
        gateApproved: { type: 'boolean' },
        forceBypass: { type: 'boolean' },
      },
      required: ['name', 'projectDir'],
    },
  },
  {
    name: 'list_stacks',
    description: 'List all active Sandstorm stacks',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'dispatch_task',
    description: 'Dispatch a task to an existing stack',
    inputSchema: {
      type: 'object',
      properties: {
        stackId: { type: 'string' },
        prompt: { type: 'string' },
        model: { type: 'string' },
        gateApproved: { type: 'boolean' },
        forceBypass: { type: 'boolean' },
      },
      required: ['stackId', 'prompt'],
    },
  },
  {
    name: 'get_diff',
    description: 'Get the git diff for a stack',
    inputSchema: {
      type: 'object',
      properties: { stackId: { type: 'string' } },
      required: ['stackId'],
    },
  },
  {
    name: 'push_stack',
    description: 'Push a stack\'s changes to git',
    inputSchema: {
      type: 'object',
      properties: { stackId: { type: 'string' }, message: { type: 'string' } },
      required: ['stackId'],
    },
  },
  {
    name: 'get_task_status',
    description: 'Get the current task status for a stack',
    inputSchema: {
      type: 'object',
      properties: { stackId: { type: 'string' } },
      required: ['stackId'],
    },
  },
  {
    name: 'get_task_output',
    description: 'Get the task output log for a stack',
    inputSchema: {
      type: 'object',
      properties: { stackId: { type: 'string' }, lines: { type: 'number' } },
      required: ['stackId'],
    },
  },
  {
    name: 'teardown_stack',
    description: 'Tear down a Sandstorm stack',
    inputSchema: {
      type: 'object',
      properties: { stackId: { type: 'string' } },
      required: ['stackId'],
    },
  },
  {
    name: 'get_logs',
    description: 'Get container logs for a stack',
    inputSchema: {
      type: 'object',
      properties: { stackId: { type: 'string' }, service: { type: 'string' } },
      required: ['stackId'],
    },
  },
  {
    name: 'set_pr',
    description: 'Associate a pull request with a stack',
    inputSchema: {
      type: 'object',
      properties: {
        stackId: { type: 'string' },
        prUrl: { type: 'string' },
        prNumber: { type: 'number' },
      },
      required: ['stackId', 'prUrl', 'prNumber'],
    },
  },
  {
    name: 'spec_check',
    description: 'Run the spec quality gate check for a ticket',
    inputSchema: {
      type: 'object',
      properties: { ticketId: { type: 'string' }, projectDir: { type: 'string' } },
      required: ['ticketId', 'projectDir'],
    },
  },
  {
    name: 'spec_refine',
    description: 'Refine a ticket spec with AI assistance',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string' },
        projectDir: { type: 'string' },
        userAnswers: { type: 'string' },
      },
      required: ['ticketId', 'projectDir'],
    },
  },
  {
    name: 'schedule_create',
    description: 'Create a scheduled action',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: { type: 'string' },
        label: { type: 'string' },
        cronExpression: { type: 'string' },
        action: { type: 'object' },
        enabled: { type: 'boolean' },
      },
      required: ['projectDir', 'cronExpression', 'action'],
    },
  },
  {
    name: 'schedule_list',
    description: 'List scheduled actions for a project',
    inputSchema: {
      type: 'object',
      properties: { projectDir: { type: 'string' } },
      required: ['projectDir'],
    },
  },
  {
    name: 'schedule_update',
    description: 'Update a scheduled action',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: { type: 'string' },
        id: { type: 'string' },
        patch: { type: 'object' },
      },
      required: ['projectDir', 'id', 'patch'],
    },
  },
  {
    name: 'schedule_delete',
    description: 'Delete a scheduled action',
    inputSchema: {
      type: 'object',
      properties: { projectDir: { type: 'string' }, id: { type: 'string' } },
      required: ['projectDir', 'id'],
    },
  },
];

// ---------------------------------------------------------------------------
// Bridge proxy
// ---------------------------------------------------------------------------

// Export for unit testing (allows callers to inject bridgeUrl/bridgeToken)
export function callBridge(
  name: string,
  input: Record<string, unknown>,
  bridgeUrl: string = BRIDGE_URL,
  bridgeToken: string = BRIDGE_TOKEN,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!bridgeUrl) {
      reject(new Error('SANDSTORM_BRIDGE_URL is not set'));
      return;
    }
    const payload = JSON.stringify({ name, input });
    const url = new URL('/tool-call', bridgeUrl);
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: '/tool-call',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-auth-token': bridgeToken,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as { result?: unknown; error?: string };
            if (parsed.error) reject(new Error(parsed.error));
            else resolve(parsed.result);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC handler
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse = Record<string, unknown>;

// Exported so unit tests can call handleMessage directly with a faked bridge.
// bridgeUrl/bridgeToken default to the module-level env constants when omitted.
export async function handleMessage(
  msg: JsonRpcMessage,
  bridgeUrl: string = BRIDGE_URL,
  bridgeToken: string = BRIDGE_TOKEN,
): Promise<JsonRpcResponse | null> {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'sandstorm-bridge', version: '1.0.0' },
        },
      };

    case 'notifications/initialized':
    case 'initialized':
      return null;

    case 'ping':
      if (isNotification) return null;
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

    case 'tools/call': {
      const p = params as { name: string; arguments?: Record<string, unknown> } | undefined;
      if (!p?.name) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'Missing tool name' },
        };
      }
      try {
        const result = await callBridge(p.name, p.arguments ?? {}, bridgeUrl, bridgeToken);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            isError: false,
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: String(err) }],
            isError: true,
          },
        };
      }
    }

    default:
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// Export TOOLS manifest so tests can verify the tool list without spawning the shim
export { TOOLS };

// ---------------------------------------------------------------------------
// Main loop — only runs when the shim is executed directly, not when imported
// ---------------------------------------------------------------------------

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return;
    }
    void handleMessage(msg).then((response) => {
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    }).catch(() => {});
  });

  rl.on('close', () => {
    process.exit(0);
  });
}
