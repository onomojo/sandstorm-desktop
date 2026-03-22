/**
 * Manages embedded Claude Code CLI sessions.
 * Each tab (All + per-project) gets its own session that persists across messages.
 * Claude is spawned with --print mode, one invocation per user message,
 * using --session-id / --resume for conversation continuity.
 * MCP tools are exposed via a local HTTP bridge server.
 */

import { spawn, ChildProcess } from 'child_process';
import { createServer, Server } from 'http';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { BrowserWindow } from 'electron';
import { handleToolCall, tools } from './tools';
import { cliDir } from '../index';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ClaudeSession {
  id: string;
  tabId: string;
  process: ChildProcess | null;
  messageCount: number;
  pendingMessages: string[];
  messages: ChatMessage[];
  processing: boolean;
  projectDir?: string;
}

export class ClaudeSessionManager {
  private sessions = new Map<string, ClaudeSession>();
  private bridgeServer: Server | null = null;
  private bridgePort = 0;
  private bridgeToken: string;
  private mcpConfigPath: string | null = null;
  private mainWindow: BrowserWindow | null = null;

  constructor() {
    this.bridgeToken = randomUUID();
  }

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win;
  }

  async initialize(): Promise<void> {
    await this.startBridgeServer();
    this.writeMcpConfig();
  }

  private startBridgeServer(): Promise<void> {
    return new Promise((resolve) => {
      this.bridgeServer = createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/tool-call') {
          res.writeHead(404);
          res.end();
          return;
        }

        const authToken = req.headers['x-auth-token'];
        if (authToken !== this.bridgeToken) {
          res.writeHead(403);
          res.end();
          return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk;
        });
        req.on('end', async () => {
          try {
            const { name, input } = JSON.parse(body);
            const result = await handleToolCall(name, input);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
      });

      this.bridgeServer.listen(0, '127.0.0.1', () => {
        const addr = this.bridgeServer!.address() as { port: number };
        this.bridgePort = addr.port;
        resolve();
      });
    });
  }

  private writeMcpConfig(): void {
    const tmpDir = path.join(os.tmpdir(), 'sandstorm-mcp');
    fs.mkdirSync(tmpDir, { recursive: true });

    // MCP server script — standalone Node.js process that bridges to our HTTP server
    const serverScriptPath = path.join(tmpDir, 'mcp-server.mjs');
    const serverScript = `import http from 'http';
import { createInterface } from 'readline';

const BRIDGE_PORT = ${this.bridgePort};
const BRIDGE_TOKEN = '${this.bridgeToken}';
const TOOLS = ${JSON.stringify(tools)};

const rl = createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

async function callBridge(name, input) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ name, input });
    const req = http.request({
      hostname: '127.0.0.1',
      port: BRIDGE_PORT,
      path: '/tool-call',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': BRIDGE_TOKEN,
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.error) reject(new Error(parsed.error));
          else resolve(parsed.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

rl.on('line', async (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'sandstorm-tools', version: '1.0.0' },
      }});
    } else if (msg.method === 'notifications/initialized') {
      // No response needed
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      }});
    } else if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params;
      try {
        const result = await callBridge(name, args || {});
        send({ jsonrpc: '2.0', id: msg.id, result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        }});
      } catch (err) {
        send({ jsonrpc: '2.0', id: msg.id, result: {
          content: [{ type: 'text', text: 'Error: ' + err.message }],
          isError: true,
        }});
      }
    }
  } catch {
    // Ignore malformed input
  }
});
`;
    fs.writeFileSync(serverScriptPath, serverScript);

    // MCP config JSON for claude CLI
    this.mcpConfigPath = path.join(tmpDir, 'mcp-config.json');
    const mcpConfig = {
      mcpServers: {
        'sandstorm-tools': {
          command: 'node',
          args: [serverScriptPath],
        },
      },
    };
    fs.writeFileSync(this.mcpConfigPath, JSON.stringify(mcpConfig));
  }

  sendMessage(
    tabId: string,
    message: string,
    projectDir?: string
  ): void {
    let session = this.sessions.get(tabId);

    if (!session) {
      session = {
        id: randomUUID(),
        tabId,
        process: null,
        messageCount: 0,
        pendingMessages: [],
        messages: [],
        processing: false,
        projectDir,
      };
      this.sessions.set(tabId, session);
    }

    // Record user message and mark processing
    session.messages.push({ role: 'user', content: message });
    session.processing = true;
    this.mainWindow?.webContents.send(`claude:user-message:${tabId}`, message);

    // If a process is already running, queue the message
    if (session.process) {
      session.pendingMessages.push(message);
      return;
    }

    if (projectDir) {
      session.projectDir = projectDir;
    }

    this.spawnClaude(tabId, message, session.projectDir);
  }

  getHistory(tabId: string): { messages: ChatMessage[]; processing: boolean } {
    const session = this.sessions.get(tabId);
    if (!session) {
      return { messages: [], processing: false };
    }
    return { messages: [...session.messages], processing: session.processing };
  }

  private spawnClaude(tabId: string, message: string, projectDir?: string): void {
    const session = this.sessions.get(tabId);
    if (!session) return;

    const systemPromptFile = path.join(cliDir, 'SANDSTORM_OUTER.md');

    const args: string[] = [
      '-p', message,
      '--output-format', 'stream-json',
    ];

    if (session.messageCount === 0) {
      args.push('--session-id', session.id);
      if (fs.existsSync(systemPromptFile)) {
        args.push('--system-prompt-file', systemPromptFile);
      }
    } else {
      args.push('--resume', session.id);
    }

    if (this.mcpConfigPath) {
      args.push('--mcp-config', this.mcpConfigPath);
    }

    args.push('--dangerously-skip-permissions');

    const cwd = projectDir || process.cwd();
    const claudeBin = process.env.HOME ? path.join(process.env.HOME, '.local', 'bin', 'claude') : 'claude';
    const child = spawn(claudeBin, args, {
      cwd,
      env: {
        ...process.env,
        PATH: [
          `${process.env.HOME}/.local/bin`,
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/local/sbin',
          process.env.PATH,
        ].join(':'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    session.process = child;
    session.messageCount++;

    const send = (channel: string, ...data: unknown[]): void => {
      this.mainWindow?.webContents.send(channel, ...data);
    };

    let outputBuffer = '';
    let fullResponse = '';

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      outputBuffer += text;

      // Parse stream-json: one JSON object per line
      const lines = outputBuffer.split('\n');
      outputBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const extracted = this.extractText(parsed);
          if (extracted) {
            fullResponse += extracted;
            send(`claude:output:${tabId}`, extracted);
          }
        } catch {
          // Not valid JSON — send raw
          if (line.trim()) {
            fullResponse += line;
            send(`claude:output:${tabId}`, line);
          }
        }
      }
    });

    child.stderr?.on('data', (_data: Buffer) => {
      // stderr contains debug/progress info — ignore
    });

    child.on('close', (_code) => {
      if (session) session.process = null;
      // Flush remaining buffer
      if (outputBuffer.trim()) {
        try {
          const parsed = JSON.parse(outputBuffer);
          const extracted = this.extractText(parsed);
          if (extracted) {
            fullResponse += extracted;
            send(`claude:output:${tabId}`, extracted);
          }
        } catch {
          fullResponse += outputBuffer;
          send(`claude:output:${tabId}`, outputBuffer);
        }
      }

      // Store assistant message
      if (session && fullResponse) {
        session.messages.push({ role: 'assistant', content: fullResponse });
      }

      send(`claude:done:${tabId}`);

      // Drain pending messages queue
      if (session && session.pendingMessages.length > 0) {
        const next = session.pendingMessages.shift()!;
        this.spawnClaude(tabId, next, session.projectDir);
      } else if (session) {
        session.processing = false;
      }
    });

    child.on('error', (err) => {
      if (session) session.process = null;
      send(`claude:error:${tabId}`, err.message);
    });
  }

  /** Extract text content from various stream-json message formats */
  private extractText(parsed: Record<string, unknown>): string | null {
    // Format: {"type":"assistant","message":{"role":"assistant","content":[...]}}
    if (parsed.type === 'assistant') {
      const msg = parsed.message as Record<string, unknown> | undefined;
      if (msg?.content && Array.isArray(msg.content)) {
        const texts: string[] = [];
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            texts.push(block.text);
          }
        }
        if (texts.length > 0) return texts.join('');
      }
    }
    // Format: {"type":"content_block_delta","delta":{"text":"..."}}
    if (parsed.type === 'content_block_delta') {
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (delta?.text) return delta.text as string;
    }
    return null;
  }

  cancelSession(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (session?.process) {
      session.process.kill();
      session.process = null;
    }
  }

  resetSession(tabId: string): void {
    this.cancelSession(tabId);
    this.sessions.delete(tabId);
  }

  destroy(): void {
    for (const session of this.sessions.values()) {
      if (session.process) {
        session.process.kill();
      }
    }
    this.sessions.clear();
    this.bridgeServer?.close();
    if (this.mcpConfigPath) {
      const tmpDir = path.dirname(this.mcpConfigPath);
      try {
        fs.rmSync(tmpDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
