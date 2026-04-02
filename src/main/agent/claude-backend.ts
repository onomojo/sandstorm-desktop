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
  tabId: string;
  process: ChildProcess | null;
  ready: boolean;           // true after the system init event is received
  pendingMessages: string[];
  messages: ChatMessage[];
  processing: boolean;
  projectDir?: string;
  watchdog: ReturnType<typeof setTimeout> | null;
  outputBuffer: string;     // partial line buffer for stdout parsing
  fullResponse: string;     // accumulated response text for current turn
  stderrBuffer: string;
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
  private modelResolver?: (projectDir: string) => string;

  constructor(
    timeoutMs?: number,
    modelResolver?: (projectDir: string) => string
  ) {
    this.bridgeToken = randomUUID();
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.modelResolver = modelResolver;
    this.initLogger();
  }

  private initLogger(): void {
    try {
      const logDir = typeof app !== 'undefined' && app.getPath
        ? app.getPath('userData')
        : os.tmpdir();
      const logPath = path.join(logDir, 'sandstorm-desktop-claude.log');
      this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
      this.logStream.on('error', () => {
        // Silently disable logging if the file is not writable
        this.logStream = null;
      });
    } catch {
      // If we can't create a log stream at all, disable logging
      this.logStream = null;
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
        tabId,
        process: null,
        ready: false,
        pendingMessages: [],
        messages: [],
        processing: false,
        projectDir,
        watchdog: null,
        outputBuffer: '',
        fullResponse: '',
        stderrBuffer: '',
      };
      this.sessions.set(tabId, session);
    }

    if (projectDir) {
      session.projectDir = projectDir;
    }

    session.messages.push({ role: 'user', content: message });
    session.processing = true;
    this.mainWindow?.webContents.send(`agent:user-message:${tabId}`, message);
    this.log(`Message received for tab=${tabId}`);

    // If process is alive and currently processing a response, queue the message
    if (session.process && session.fullResponse !== '' || (session.process && !session.ready)) {
      session.pendingMessages.push(message);
      this.log(`Message queued for tab=${tabId} (queue size: ${session.pendingMessages.length})`);
      this.mainWindow?.webContents.send(`agent:queued:${tabId}`);
      return;
    }

    // Ensure persistent process exists, then send the message
    this.ensureProcess(tabId);

    if (session.process && session.ready) {
      this.writeMessage(tabId, message);
    } else {
      // Process is starting up — queue and it'll be sent after init
      session.pendingMessages.push(message);
    }
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
    if (!session) return;
    if (session.watchdog) clearTimeout(session.watchdog);
    session.watchdog = null;
    if (session.process) {
      session.process.kill();
      session.process = null;
    }
    session.ready = false;
    session.fullResponse = '';
    session.outputBuffer = '';
    session.stderrBuffer = '';
    session.pendingMessages = [];
  }

  resetSession(tabId: string): void {
    this.cancelSession(tabId);
    this.sessions.delete(tabId);
  }

  // --- Ephemeral agent (one-shot Claude process) ---

  /**
   * Spawn a one-shot Claude process that evaluates a prompt and returns the text result.
   * Uses -p (pipe/print) mode — no session persistence, no MCP tools.
   * Used for spec quality gate evaluation to avoid inflating the outer session.
   */
  runEphemeralAgent(prompt: string, projectDir: string, timeoutMs = 120_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const claudeBin = getClaudeBin();
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--dangerously-skip-permissions',
        '--verbose',
      ];

      const child = spawn(claudeBin, args, {
        cwd: projectDir,
        env: getClaudeEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let outputBuffer = '';
      let fullText = '';
      let stderrBuffer = '';

      const timer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill();
          reject(new Error(`Ephemeral agent timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      child.stdout?.on('data', (data: Buffer) => {
        outputBuffer += data.toString();
        const lines = outputBuffer.split('\n');
        outputBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            const text = this.extractText(parsed);
            if (text) fullText += text;
          } catch {
            // Skip non-JSON lines
          }
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderrBuffer += data.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        // Process any remaining buffer
        if (outputBuffer.trim()) {
          try {
            const parsed = JSON.parse(outputBuffer);
            const text = this.extractText(parsed);
            if (text) fullText += text;
          } catch {
            // Skip
          }
        }

        if (code !== 0 && !fullText.trim()) {
          reject(new Error(
            `Ephemeral agent exited with code ${code}: ${stderrBuffer.trim() || 'unknown error'}`
          ));
        } else {
          resolve(fullText);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
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

  // --- Private: persistent Claude process management ---

  /**
   * Write an NDJSON user message to the persistent process's stdin.
   */
  private writeMessage(tabId: string, message: string): void {
    const session = this.sessions.get(tabId);
    if (!session?.process?.stdin?.writable) return;

    // Reset response state for the new turn
    session.fullResponse = '';

    const ndjson = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    });
    session.process.stdin.write(ndjson + '\n');
    this.log(`Wrote message to stdin for tab=${tabId} (${message.length} chars)`);

    // Start watchdog timer for this turn
    this.resetWatchdog(tabId);
  }

  private resetWatchdog(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    if (session.watchdog) clearTimeout(session.watchdog);
    session.watchdog = setTimeout(() => {
      this.log(`Watchdog timeout for tab=${tabId} after ${this.timeoutMs}ms — killing process`);
      if (session.process) {
        session.process.kill();
      }
    }, this.timeoutMs);
  }

  /**
   * Ensure a persistent Claude process is running for the given tab.
   * Spawns one if none exists. The process stays alive across messages.
   */
  private ensureProcess(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (!session || session.process) return;

    const systemPromptFile = path.join(cliDir, 'SANDSTORM_OUTER.md');
    const claudeBin = getClaudeBin();

    const args: string[] = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
    ];

    if (fs.existsSync(systemPromptFile)) {
      args.push('--system-prompt-file', systemPromptFile);
    }

    if (this.mcpConfigPath) {
      args.push('--mcp-config', this.mcpConfigPath);
    }

    if (this.modelResolver && session.projectDir) {
      const outerModel = this.modelResolver(session.projectDir);
      args.push('--model', outerModel);
    }

    const cwd = session.projectDir || process.cwd();

    const child = spawn(claudeBin, args, {
      cwd,
      env: getClaudeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    session.process = child;
    session.ready = false;
    session.outputBuffer = '';
    session.fullResponse = '';
    session.stderrBuffer = '';

    this.log(`Persistent Claude process spawned for tab=${tabId} pid=${child.pid}`);

    const send = (channel: string, ...data: unknown[]): void => {
      this.mainWindow?.webContents.send(channel, ...data);
    };

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      session.outputBuffer += text;

      const lines = session.outputBuffer.split('\n');
      session.outputBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);

          // Detect init event — process is ready to accept messages
          if (parsed.type === 'system' && parsed.subtype === 'init' && !session.ready) {
            session.ready = true;
            this.log(`Claude process ready for tab=${tabId}`);
            // Send any queued messages
            if (session.pendingMessages.length > 0) {
              const next = session.pendingMessages.shift()!;
              this.log(`Dequeuing message after init for tab=${tabId} (remaining: ${session.pendingMessages.length})`);
              this.writeMessage(tabId, next);
            }
            continue;
          }

          // Detect result event — response complete for this turn
          if (parsed.type === 'result') {
            if (session.watchdog) clearTimeout(session.watchdog);
            session.watchdog = null;

            if (session.fullResponse) {
              session.messages.push({ role: 'assistant', content: session.fullResponse });
            }
            send(`agent:done:${tabId}`);

            // Dequeue next pending message
            if (session.pendingMessages.length > 0) {
              const next = session.pendingMessages.shift()!;
              this.log(`Dequeuing message after result for tab=${tabId} (remaining: ${session.pendingMessages.length})`);
              this.writeMessage(tabId, next);
            } else {
              session.processing = false;
              session.fullResponse = '';
            }
            continue;
          }

          // Detect error events
          if (parsed.type === 'error') {
            const errorMsg = (parsed as { error?: { message?: string } }).error?.message || 'Unknown error';
            this.log(`Claude error for tab=${tabId}: ${errorMsg}`);
            // Don't kill the process on API errors — it may recover
            continue;
          }

          // Extract text for streaming output
          const extracted = this.extractText(parsed);
          if (extracted) {
            session.fullResponse += extracted;
            send(`agent:output:${tabId}`, extracted);
          }
        } catch {
          // Non-JSON line — skip
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      session.stderrBuffer += text;
      this.log(`stderr [tab=${tabId}]: ${text.trimEnd()}`);
    });

    child.on('close', (code) => {
      if (session.watchdog) clearTimeout(session.watchdog);
      session.watchdog = null;
      session.process = null;
      session.ready = false;
      this.log(`Persistent Claude process exited for tab=${tabId} code=${code}`);

      if (session.processing) {
        // Process died while we were expecting a response
        const errorMsg = session.stderrBuffer.trim()
          || `Claude process exited unexpectedly (code ${code})`;
        send(`agent:error:${tabId}`, errorMsg);
        session.processing = false;
        session.pendingMessages = [];
      }

      session.outputBuffer = '';
      session.fullResponse = '';
      session.stderrBuffer = '';
    });

    child.on('error', (err) => {
      if (session.watchdog) clearTimeout(session.watchdog);
      session.watchdog = null;
      session.process = null;
      session.ready = false;
      session.processing = false;
      session.pendingMessages = [];
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
