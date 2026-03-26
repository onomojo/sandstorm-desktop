/**
 * Claude implementation of AgentBackend.
 * Manages embedded Claude Code CLI sessions with MCP tool bridge.
 * Consolidates session management + auth logic behind the AgentBackend interface.
 */

import { spawn, ChildProcess } from 'child_process';
import { createServer, Server } from 'http';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { BrowserWindow, shell } from 'electron';
import { app } from 'electron';
import { handleToolCall, tools } from '../claude/tools';
import { cliDir } from '../index';
import {
  AgentBackend,
  ChatMessage,
  AuthStatus,
  AgentSessionHistory,
  StackInfo,
} from './types';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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

function getClaudeBin(): string {
  return process.env.HOME
    ? path.join(process.env.HOME, '.local', 'bin', 'claude')
    : 'claude';
}

function getClaudeEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    PATH: [
      `${process.env.HOME}/.local/bin`,
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/local/sbin',
      process.env.PATH,
    ].join(':'),
  };
}

export class ClaudeBackend implements AgentBackend {
  readonly name = 'Claude';

  private sessions = new Map<string, ClaudeSession>();
  private bridgeServer: Server | null = null;
  private bridgePort = 0;
  private bridgeToken: string;
  private mcpConfigPath: string | null = null;
  private mainWindow: BrowserWindow | null = null;
  private logStream: fs.WriteStream | null = null;
  private timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.bridgeToken = randomUUID();
    this.timeoutMs = timeoutMs;
    this.initLogger();
  }

  private initLogger(): void {
    try {
      const logDir = typeof app !== 'undefined' && app.getPath
        ? app.getPath('userData')
        : os.tmpdir();
      const logPath = path.join(logDir, 'sandstorm-desktop-claude.log');
      this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
    } catch {
      const logPath = path.join(os.tmpdir(), 'sandstorm-desktop-claude.log');
      this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
    }
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    this.logStream?.write(line);
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
    const tmpDir = path.join(os.tmpdir(), `sandstorm-mcp-${process.pid}`);
    fs.mkdirSync(tmpDir, { recursive: true });

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

  // --- Session management (AgentBackend interface) ---

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

    session.messages.push({ role: 'user', content: message });
    session.processing = true;
    this.mainWindow?.webContents.send(`agent:user-message:${tabId}`, message);
    this.log(`Message received for tab=${tabId}`);

    if (session.process) {
      session.pendingMessages.push(message);
      this.log(`Message queued for tab=${tabId} (queue size: ${session.pendingMessages.length})`);
      this.mainWindow?.webContents.send(`agent:queued:${tabId}`);
      return;
    }

    if (projectDir) {
      session.projectDir = projectDir;
    }

    this.spawnClaude(tabId, message, session.projectDir);
  }

  getHistory(tabId: string): AgentSessionHistory {
    const session = this.sessions.get(tabId);
    if (!session) {
      return { messages: [], processing: false };
    }
    return { messages: [...session.messages], processing: session.processing };
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

  // --- Auth (AgentBackend interface) ---

  async getAuthStatus(): Promise<AuthStatus> {
    const credsPath = path.join(process.env.HOME || '', '.claude', '.credentials.json');
    let expired = false;
    let expiresAt: number | undefined;

    try {
      const raw = fs.readFileSync(credsPath, 'utf-8');
      const creds = JSON.parse(raw);
      const oauthData = creds.claudeAiOauth;
      if (oauthData?.expiresAt) {
        expiresAt = oauthData.expiresAt;
        expired = Date.now() > oauthData.expiresAt;
      }
    } catch {
      return { loggedIn: false, expired: false };
    }

    try {
      const result = await new Promise<{ stdout: string; exitCode: number }>((resolve) => {
        const child = spawn(getClaudeBin(), ['auth', 'status', '--output', 'json'], {
          env: getClaudeEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.on('close', (code) => resolve({ stdout, exitCode: code ?? 1 }));
        child.on('error', () => resolve({ stdout: '', exitCode: 1 }));
      });

      if (result.exitCode === 0 && result.stdout.trim()) {
        const status = JSON.parse(result.stdout.trim());
        return {
          loggedIn: status.loggedIn ?? false,
          email: status.email,
          expired,
          expiresAt,
        };
      }
    } catch {
      // Fall through
    }

    return { loggedIn: true, expired, expiresAt };
  }

  async login(mainWindow?: BrowserWindow): Promise<{ success: boolean; error?: string }> {
    const win = mainWindow ?? this.mainWindow;
    return new Promise((resolve) => {
      const child = spawn(getClaudeBin(), ['auth', 'login'], {
        env: getClaudeEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let urlOpened = false;

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
        const urlMatch = stdout.match(/(https:\/\/[^\s]+)/);
        if (urlMatch && !urlOpened) {
          urlOpened = true;
          shell.openExternal(urlMatch[1]);
          win?.webContents.send('auth:url-opened', urlMatch[1]);
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      setTimeout(() => {
        try { child.stdin.write('\n'); } catch { /* Process may have exited */ }
      }, 1000);

      child.on('close', async (code) => {
        if (code === 0) {
          win?.webContents.send('auth:completed', true);
          resolve({ success: true });
        } else {
          win?.webContents.send('auth:completed', false);
          resolve({ success: false, error: stderr.trim() || 'Auth login failed' });
        }
      });

      child.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });

      setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve({ success: false, error: 'Auth login timed out' });
      }, 5 * 60 * 1000);
    });
  }

  async syncCredentials(stacks: StackInfo[]): Promise<void> {
    const credsPath = path.join(process.env.HOME || '', '.claude', '.credentials.json');
    let creds: string;
    try {
      creds = fs.readFileSync(credsPath, 'utf-8');
    } catch {
      return;
    }

    try {
      for (const stack of stacks) {
        if (stack.status !== 'running' && stack.status !== 'up') continue;
        const claudeService = stack.services?.find(
          (s) => s.name === 'claude'
        );
        if (!claudeService?.containerId) continue;

        try {
          const child = spawn('docker', [
            'exec', '-i', '-u', 'claude', claudeService.containerId,
            'bash', '-c', 'mkdir -p ~/.claude && cat > ~/.claude/.credentials.json',
          ], { stdio: ['pipe', 'ignore', 'ignore'] });
          child.stdin.write(creds);
          child.stdin.end();
          await new Promise<void>((resolve) => child.on('close', () => resolve()));
        } catch {
          // Best effort per container
        }
      }
    } catch {
      // Best effort
    }
  }

  // --- Private: Claude CLI spawning ---

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

    let claudeBin = 'claude';
    const pathExtras: string[] = [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/local/sbin',
    ];
    if (process.env.HOME) {
      const homeLocalBin = path.join(process.env.HOME, '.local', 'bin');
      const homeClaudePath = path.join(homeLocalBin, 'claude');
      try {
        if (fs.existsSync(homeClaudePath)) {
          claudeBin = homeClaudePath;
          pathExtras.unshift(homeLocalBin);
        }
      } catch {
        // Home directory not accessible
      }
    }

    const child = spawn(claudeBin, args, {
      cwd,
      env: {
        ...process.env,
        PATH: [...pathExtras, process.env.PATH].filter(Boolean).join(':'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    session.process = child;
    session.messageCount++;

    this.log(`Claude CLI spawned for tab=${tabId} pid=${child.pid} args=[${args.join(', ')}]`);

    const send = (channel: string, ...data: unknown[]): void => {
      this.mainWindow?.webContents.send(channel, ...data);
    };

    let outputBuffer = '';
    let fullResponse = '';
    let stderrBuffer = '';

    const timeout = setTimeout(() => {
      if (child.exitCode === null) {
        this.log(`Timeout reached for tab=${tabId} pid=${child.pid} after ${this.timeoutMs}ms`);
        child.kill();
        send(`agent:error:${tabId}`, `Claude process timed out after ${Math.round(this.timeoutMs / 1000)} seconds`);
      }
    }, this.timeoutMs);

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      outputBuffer += text;

      const lines = outputBuffer.split('\n');
      outputBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const extracted = this.extractText(parsed);
          if (extracted) {
            fullResponse += extracted;
            send(`agent:output:${tabId}`, extracted);
          }
        } catch {
          if (line.trim()) {
            fullResponse += line;
            send(`agent:output:${tabId}`, line);
          }
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderrBuffer += text;
      this.log(`stderr [tab=${tabId}]: ${text.trimEnd()}`);
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (session) session.process = null;
      this.log(`Claude CLI exited for tab=${tabId} code=${code}`);

      if (outputBuffer.trim()) {
        try {
          const parsed = JSON.parse(outputBuffer);
          const extracted = this.extractText(parsed);
          if (extracted) {
            fullResponse += extracted;
            send(`agent:output:${tabId}`, extracted);
          }
        } catch {
          fullResponse += outputBuffer;
          send(`agent:output:${tabId}`, outputBuffer);
        }
      }

      if (code !== 0 && !fullResponse.trim()) {
        const errorMsg = stderrBuffer.trim()
          || `Claude exited with code ${code}`;
        this.log(`Sending error for tab=${tabId}: ${errorMsg}`);
        send(`agent:error:${tabId}`, errorMsg);
      } else {
        if (session && fullResponse) {
          session.messages.push({ role: 'assistant', content: fullResponse });
        }
        send(`agent:done:${tabId}`);
      }

      if (session && session.pendingMessages.length > 0) {
        const next = session.pendingMessages.shift()!;
        this.log(`Dequeuing message for tab=${tabId} (remaining: ${session.pendingMessages.length})`);
        this.spawnClaude(tabId, next, session.projectDir);
      } else if (session) {
        session.processing = false;
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      if (session) {
        session.process = null;
        if (session.pendingMessages.length > 0) {
          const next = session.pendingMessages.shift()!;
          this.log(`Dequeuing message after error for tab=${tabId} (remaining: ${session.pendingMessages.length})`);
          this.spawnClaude(tabId, next, session.projectDir);
        } else {
          session.processing = false;
        }
      }
      this.log(`Spawn error for tab=${tabId}: ${err.message}`);
      send(`agent:error:${tabId}`, err.message);
    });
  }

  private extractText(parsed: Record<string, unknown>): string | null {
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
    if (parsed.type === 'content_block_delta') {
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (delta?.text) return delta.text as string;
    }
    return null;
  }

  destroy(): void {
    for (const session of this.sessions.values()) {
      if (session.process) {
        session.process.kill();
      }
    }
    this.sessions.clear();
    this.bridgeServer?.close();
    this.logStream?.end();
    this.logStream = null;
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
