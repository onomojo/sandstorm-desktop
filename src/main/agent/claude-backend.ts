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
  OuterClaudeSessionTokens,
  StackInfo,
  zeroSessionTokens,
} from './types';
import { resolveOuterClaudeTools } from './tools-allowlist';
import {
  TokenTelemetry,
  ToolCallRecord,
  isTelemetryEnabled,
  currentExperimentLabel,
} from './token-telemetry';

/** In-flight per-cycle tracking; tool_use_id is only retained in memory. */
interface InFlightToolCall extends ToolCallRecord {
  tool_use_id: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — must be longer than MCP tool chain (300s ephemeral + 310s bridge)

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
  cancelledTurn: boolean;   // true when the user cancelled the current turn (process kept alive)
  cancelFallback: ReturnType<typeof setTimeout> | null; // fallback kill timer after cancel
  turnIndex: number;            // 0-based index of completed turns in this session
  lastResultAt: number | null;  // Date.now() of the previous `type:"result"` event, for telemetry deltas
  subTurnCount: number;         // count of type:"assistant" events since the last type:"result" (= API calls in the current tool-use chain)
  toolCallsInCycle: InFlightToolCall[]; // MCP tool calls made since the last type:"result"; reset on record
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
  /**
   * Per-tab token totals for the CURRENT orchestrator session.
   * Resets to zero whenever `resetSession(tabId)` is called ("New Session").
   * This is the single source of truth for the orchestrator token counter in
   * the UI — never a cumulative aggregate across sessions.
   */
  private sessionTokens = new Map<string, OuterClaudeSessionTokens>();
  private bridgeServer: Server | null = null;
  private bridgePort = 0;
  private bridgeToken: string;
  private mcpConfigPath: string | null = null;
  private mainWindow: BrowserWindow | null = null;
  private logStream: fs.WriteStream | null = null;
  private timeoutMs: number;
  private modelResolver?: (projectDir: string) => string;
  private telemetry: TokenTelemetry;

  constructor(
    timeoutMs?: number,
    modelResolver?: (projectDir: string) => string
  ) {
    this.bridgeToken = randomUUID();
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.modelResolver = modelResolver;
    this.initLogger();
    this.telemetry = this.initTelemetry();
  }

  /**
   * Opt-in per-turn token telemetry (#262 tactic A). Off unless
   * `SANDSTORM_TOKEN_TELEMETRY=1` is set. Writes JSONL to the app's userData
   * dir so it sits next to the existing claude log.
   */
  private initTelemetry(): TokenTelemetry {
    const enabled = isTelemetryEnabled();
    let filePath = '';
    try {
      const dir = typeof app !== 'undefined' && app.getPath ? app.getPath('userData') : os.tmpdir();
      filePath = path.join(dir, 'sandstorm-desktop-token-telemetry.jsonl');
    } catch {
      filePath = path.join(os.tmpdir(), 'sandstorm-desktop-token-telemetry.jsonl');
    }
    return new TokenTelemetry({ filePath, enabled });
  }

  getSessionTokens(tabId: string): OuterClaudeSessionTokens {
    return this.sessionTokens.get(tabId) ?? zeroSessionTokens();
  }

  /** Push the current session token totals to the renderer for the given tab. */
  private emitSessionTokens(tabId: string): void {
    const tokens = this.getSessionTokens(tabId);
    this.mainWindow?.webContents.send(`agent:token-usage:${tabId}`, tokens);
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
      timeout: 310_000,
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
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Bridge request timed out after 310s'));
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
        cancelledTurn: false,
        cancelFallback: null,
        turnIndex: 0,
        lastResultAt: null,
        subTurnCount: 0,
        toolCallsInCycle: [],
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

    // If process is alive and currently processing a response (or finishing a cancelled turn), queue the message
    if (session.process && (session.fullResponse !== '' || session.cancelledTurn)) {
      session.pendingMessages.push(message);
      this.log(`Message queued for tab=${tabId} (queue size: ${session.pendingMessages.length})`);
      this.mainWindow?.webContents.send(`agent:queued:${tabId}`);
      return;
    }

    // Ensure persistent process exists, then send the message immediately.
    // Note: Claude CLI with --input-format stream-json does NOT emit the
    // system init event until it receives input on stdin, so we must write
    // the message first — not wait for init.
    this.ensureProcess(tabId);
    this.writeMessage(tabId, message);
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
    if (session.cancelFallback) clearTimeout(session.cancelFallback);
    session.cancelFallback = null;

    if (session.process && session.processing) {
      // Cancel the current turn without killing the process.
      // The process continues running; output from the cancelled turn is discarded.
      // When the result event arrives, the process becomes available for new messages.
      session.cancelledTurn = true;
      session.processing = false;
      session.pendingMessages = [];
      this.mainWindow?.webContents.send(`agent:done:${tabId}`);
      this.log(`Turn cancelled for tab=${tabId} (process kept alive, pid=${session.process.pid})`);

      // Fallback: if the process produces no result within 30s, kill it
      session.cancelFallback = setTimeout(() => {
        if (session.cancelledTurn && session.process) {
          this.log(`Cancel fallback: killing stuck process for tab=${tabId} after 30s`);
          session.process.kill();
        }
      }, 30_000);
    } else if (session.process && !session.processing) {
      // Not processing — nothing to cancel
      session.pendingMessages = [];
    } else {
      // No process — just clean up
      session.pendingMessages = [];
    }
  }

  resetSession(tabId: string): void {
    const session = this.sessions.get(tabId);
    if (session) {
      if (session.watchdog) clearTimeout(session.watchdog);
      session.watchdog = null;
      if (session.cancelFallback) clearTimeout(session.cancelFallback);
      session.cancelFallback = null;
      if (session.process) {
        session.process.kill();
        session.process = null;
      }
    }
    this.sessions.delete(tabId);

    // Reset token counter to zero for the new session — and push the zero
    // value to the renderer immediately so the UI updates without a poll.
    this.sessionTokens.delete(tabId);
    this.emitSessionTokens(tabId);
  }

  // --- Ephemeral agent (one-shot Claude process) ---

  /**
   * Spawn a one-shot Claude process that evaluates a prompt and returns the text result.
   * Uses -p (pipe/print) mode — no session persistence, no MCP tools.
   * Used for spec quality gate evaluation to avoid inflating the outer session.
   */
  runEphemeralAgent(prompt: string, projectDir: string, timeoutMs = 300_000): Promise<string> {
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
      let settled = false;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          setTimeout(() => {
            if (child.exitCode === null) {
              child.kill('SIGKILL');
            }
          }, 5_000);
          settle(() => reject(new Error(`Ephemeral agent timed out after ${timeoutMs}ms`)));
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

        settle(() => {
          if (code !== 0 && !fullText.trim()) {
            reject(new Error(
              `Ephemeral agent exited with code ${code}: ${stderrBuffer.trim() || 'unknown error'}`
            ));
          } else {
            resolve(fullText);
          }
        });
      });

      child.on('error', (err) => {
        settle(() => reject(err));
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

    // Investigation switches — throwaway branch only. Set via env var.
    const skipSystemPrompt = process.env.SANDSTORM_EXP_NO_SYSTEM_PROMPT === '1';
    const skipMcp = process.env.SANDSTORM_EXP_NO_MCP === '1';

    const args: string[] = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      // Restrict the orchestrator to an allowlist of built-in tools. Every
      // denied tool's schema drops out of the context the CLI re-sends on
      // every turn — the single largest static-bloat lever per #254. #256.
      // SANDSTORM_EXP_ENABLE_AGENT=1 expands the allowlist for experiment 2/5.
      '--tools', resolveOuterClaudeTools(session.projectDir).join(','),
    ];

    if (!skipSystemPrompt && fs.existsSync(systemPromptFile)) {
      args.push('--system-prompt-file', systemPromptFile);
    }

    if (!skipMcp && this.mcpConfigPath) {
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
    session.cancelledTurn = false;
    if (session.cancelFallback) clearTimeout(session.cancelFallback);
    session.cancelFallback = null;

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

          // Detect init event — process confirmed ready
          if (parsed.type === 'system' && parsed.subtype === 'init' && !session.ready) {
            session.ready = true;
            this.log(`Claude process ready for tab=${tabId}`);
            continue;
          }

          // Detect result event — response complete for this turn
          if (parsed.type === 'result') {
            if (session.watchdog) clearTimeout(session.watchdog);
            session.watchdog = null;

            if (session.cancelledTurn) {
              // Cancelled turn finished — discard its output, dequeue if needed
              if (session.cancelFallback) clearTimeout(session.cancelFallback);
              session.cancelFallback = null;
              session.cancelledTurn = false;
              session.fullResponse = '';
              this.log(`Cancelled turn finished for tab=${tabId}`);
              if (session.pendingMessages.length > 0) {
                const next = session.pendingMessages.shift()!;
                session.processing = true;
                this.log(`Dequeuing message after cancelled turn for tab=${tabId}`);
                this.writeMessage(tabId, next);
              }
              continue;
            }

            // Accumulate token usage for this turn into the current
            // orchestrator session's running totals. Include cache
            // creation/read tokens so the counter reflects honest usage.
            const usage = parsed.usage as
              | {
                  input_tokens?: number;
                  output_tokens?: number;
                  cache_creation_input_tokens?: number;
                  cache_read_input_tokens?: number;
                }
              | undefined;
            if (usage) {
              const prev = this.sessionTokens.get(tabId) ?? zeroSessionTokens();
              // Copy-on-write: avoid mutating the previously-emitted object so
              // downstream consumers always see a fresh reference.
              this.sessionTokens.set(tabId, {
                input_tokens: prev.input_tokens + (usage.input_tokens ?? 0),
                output_tokens: prev.output_tokens + (usage.output_tokens ?? 0),
                cache_creation_input_tokens:
                  prev.cache_creation_input_tokens + (usage.cache_creation_input_tokens ?? 0),
                cache_read_input_tokens:
                  prev.cache_read_input_tokens + (usage.cache_read_input_tokens ?? 0),
              });
              this.emitSessionTokens(tabId);

              // Per-turn telemetry (#262 tactic A). No-op when the opt-in
              // env flag is off. Measurement lands first so later tactics
              // have a baseline.
              if (this.telemetry.active) {
                const now = Date.now();
                const secondsSincePrev =
                  session.lastResultAt === null
                    ? null
                    : (now - session.lastResultAt) / 1000;
                const experiment = currentExperimentLabel();
                this.telemetry.record({
                  ts: new Date(now).toISOString(),
                  tabId,
                  projectDir: session.projectDir,
                  turn_index: session.turnIndex,
                  seconds_since_prev_turn: secondsSincePrev,
                  input_tokens: usage.input_tokens ?? 0,
                  output_tokens: usage.output_tokens ?? 0,
                  cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
                  cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
                  sub_turn_count: session.subTurnCount,
                  tool_calls: session.toolCallsInCycle.map((c) => ({
                    name: c.name,
                    tool_result_bytes: c.tool_result_bytes,
                  })),
                  ...(experiment !== undefined ? { experiment } : {}),
                });
              }
              session.turnIndex += 1;
              session.lastResultAt = Date.now();
              // Reset per-cycle counters for the next user-message turn.
              session.subTurnCount = 0;
              session.toolCallsInCycle = [];
            }

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

          // Log tool_use events for observability + telemetry (#262 sub-turn instrumentation)
          if (parsed.type === 'content_block_start') {
            const contentBlock = (parsed as { content_block?: { type?: string; name?: string; id?: string } }).content_block;
            if (contentBlock?.type === 'tool_use') {
              this.log(`Tool call: tab=${tabId} tool=${contentBlock.name} id=${contentBlock.id}`);
              if (contentBlock.name && contentBlock.id) {
                session.toolCallsInCycle.push({
                  name: contentBlock.name,
                  tool_use_id: contentBlock.id,
                  tool_result_bytes: 0,
                });
              }
            }
          }
          if (parsed.type === 'content_block_stop') {
            const idx = (parsed as { index?: number }).index;
            this.log(`Tool call ended: tab=${tabId} block_index=${idx}`);
          }

          // Count sub-API-calls: each type:"assistant" event is one API response.
          // A direct reply has sub_turn_count=1; a tool-use chain produces >= 2.
          // Also walk the assistant message content for tool_use blocks —
          // some CLI builds (observed on the orchestrator path) emit tool_use
          // here instead of via separate content_block_start events, so we
          // capture from both paths and dedupe by tool_use_id.
          if (parsed.type === 'assistant') {
            session.subTurnCount += 1;
            const assistantMsg = (parsed as { message?: { content?: unknown } }).message;
            const assistantContent = assistantMsg?.content;
            if (Array.isArray(assistantContent)) {
              for (const block of assistantContent as Array<Record<string, unknown>>) {
                if (block?.type !== 'tool_use') continue;
                const id = typeof block.id === 'string' ? block.id : undefined;
                const name = typeof block.name === 'string' ? block.name : undefined;
                if (!id || !name) continue;
                if (session.toolCallsInCycle.some((c) => c.tool_use_id === id)) continue;
                session.toolCallsInCycle.push({
                  name,
                  tool_use_id: id,
                  tool_result_bytes: 0,
                });
                this.log(`Tool call: tab=${tabId} tool=${name} id=${id}`);
              }
            }
          }

          // type:"user" carries tool_result blocks that the bridge returned to
          // the model. Associate each tool_result's text size with its
          // originating tool_use_id so we can see which tools fed the biggest
          // payloads into the transcript.
          if (parsed.type === 'user') {
            const msg = (parsed as { message?: { content?: unknown } }).message;
            const content = msg?.content;
            if (Array.isArray(content)) {
              for (const block of content as Array<Record<string, unknown>>) {
                if (block?.type !== 'tool_result') continue;
                const toolUseId = block.tool_use_id as string | undefined;
                if (!toolUseId) continue;
                const record = session.toolCallsInCycle.find(
                  (c) => c.tool_use_id === toolUseId
                );
                if (!record) continue;
                const blockContent = block.content;
                let bytes = 0;
                if (typeof blockContent === 'string') {
                  bytes = Buffer.byteLength(blockContent, 'utf8');
                } else if (Array.isArray(blockContent)) {
                  for (const inner of blockContent as Array<Record<string, unknown>>) {
                    if (typeof inner?.text === 'string') {
                      bytes += Buffer.byteLength(inner.text, 'utf8');
                    }
                  }
                }
                // Accumulate in case a tool_result arrives in chunks
                record.tool_result_bytes += bytes;
              }
            }
          }

          // Extract text for streaming output
          const extracted = this.extractText(parsed);
          if (extracted) {
            if (session.cancelledTurn) {
              // Discard output from cancelled turn, but still accumulate for queue detection
              session.fullResponse += extracted;
            } else {
              session.fullResponse += extracted;
              send(`agent:output:${tabId}`, extracted);
            }
            // Reset watchdog on any streaming output — only fire during TRUE silence
            this.resetWatchdog(tabId);
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
      if (session.cancelFallback) clearTimeout(session.cancelFallback);
      session.cancelFallback = null;
      session.process = null;
      session.ready = false;
      session.cancelledTurn = false;
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
      if (session.cancelFallback) clearTimeout(session.cancelFallback);
      session.cancelFallback = null;
      session.process = null;
      session.ready = false;
      session.processing = false;
      session.cancelledTurn = false;
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
    this.telemetry.close();
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
