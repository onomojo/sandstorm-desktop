import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// Mock electron modules before importing backend
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  app: {
    getPath: () => '/tmp',
  },
  shell: {
    openExternal: vi.fn(),
  },
}));

// Mock the tools module
vi.mock('../../src/main/claude/tools', () => ({
  handleToolCall: vi.fn(),
  tools: [],
}));

// Mock cliDir
vi.mock('../../src/main/index', () => ({
  cliDir: '/tmp/sandstorm-cli',
}));

// Track spawned processes for assertions
const spawnedProcesses: MockChildProcess[] = [];

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter() as unknown as Readable;
  stderr = new EventEmitter() as unknown as Readable;
  stdin = {
    write: vi.fn(),
    end: vi.fn(),
    writable: true,
  } as unknown as Writable & { write: ReturnType<typeof vi.fn>; writable: boolean };
  pid = Math.floor(Math.random() * 10000);
  exitCode: number | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => {
      const proc = new MockChildProcess();
      spawnedProcesses.push(proc);
      return proc;
    }),
  };
});

// Mock fs to avoid real file operations
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    readFileSync: vi.fn().mockImplementation(() => {
      throw new Error('File not found');
    }),
    createWriteStream: vi.fn(() => ({
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    })),
    rmSync: vi.fn(),
  };
});

// Mock http server
vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('http');
  return {
    ...actual,
    createServer: vi.fn(() => ({
      listen: vi.fn((_port: number, _host: string, cb: () => void) => {
        cb();
      }),
      address: vi.fn(() => ({ port: 12345 })),
      close: vi.fn(),
    })),
  };
});

import { ClaudeBackend } from '../../src/main/agent/claude-backend';
import type { AgentBackend } from '../../src/main/agent/types';

describe('ClaudeBackend (AgentBackend implementation)', () => {
  let backend: AgentBackend;
  let mockWindow: { webContents: { send: ReturnType<typeof vi.fn> } };
  let sentMessages: Array<{ channel: string; args: unknown[] }>;

  beforeEach(async () => {
    spawnedProcesses.length = 0;
    sentMessages = [];
    mockWindow = {
      webContents: {
        send: vi.fn((...args: unknown[]) => {
          sentMessages.push({ channel: args[0] as string, args: args.slice(1) });
        }),
      },
    };

    backend = new ClaudeBackend(1000); // 1s timeout for tests
    backend.setMainWindow(mockWindow as never);
    await backend.initialize();
  });

  afterEach(() => {
    backend.destroy();
    vi.clearAllMocks();
  });

  function getLastProcess(): MockChildProcess {
    return spawnedProcesses[spawnedProcesses.length - 1];
  }

  function findMessages(channelPattern: string): Array<{ channel: string; args: unknown[] }> {
    return sentMessages.filter((m) => m.channel.includes(channelPattern));
  }

  /** Emit the system init event to make the process "ready" */
  function emitInit(proc: MockChildProcess): void {
    const initEvent = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test-session' });
    proc.stdout.emit('data', Buffer.from(initEvent + '\n'));
  }

  /** Emit a result event to signal response completion */
  function emitResult(proc: MockChildProcess, result = 'ok'): void {
    const resultEvent = JSON.stringify({ type: 'result', result, total_cost_usd: 0.01 });
    proc.stdout.emit('data', Buffer.from(resultEvent + '\n'));
  }

  /** Emit an assistant text response */
  function emitAssistant(proc: MockChildProcess, text: string): void {
    const event = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    });
    proc.stdout.emit('data', Buffer.from(event + '\n'));
  }

  it('implements the AgentBackend interface', () => {
    expect(backend.name).toBe('Claude');
    expect(typeof backend.sendMessage).toBe('function');
    expect(typeof backend.getHistory).toBe('function');
    expect(typeof backend.cancelSession).toBe('function');
    expect(typeof backend.resetSession).toBe('function');
    expect(typeof backend.getAuthStatus).toBe('function');
    expect(typeof backend.login).toBe('function');
    expect(typeof backend.syncCredentials).toBe('function');
    expect(typeof backend.initialize).toBe('function');
    expect(typeof backend.destroy).toBe('function');
    expect(typeof backend.setMainWindow).toBe('function');
  });

  describe('persistent process lifecycle', () => {
    it('spawns a process on first message', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      expect(spawnedProcesses.length).toBe(1);
    });

    it('reuses the same process for second message', () => {
      backend.sendMessage('tab1', 'first', '/tmp');
      const proc = getLastProcess();
      emitInit(proc);
      emitAssistant(proc, 'response 1');
      emitResult(proc);

      backend.sendMessage('tab1', 'second', '/tmp');
      // Should NOT spawn a new process
      expect(spawnedProcesses.length).toBe(1);
    });

    it('writes NDJSON to stdin immediately on first message (no init wait)', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();

      // Message should be written to stdin immediately — NOT queued waiting for init
      expect(proc.stdin.write).toHaveBeenCalledWith(
        expect.stringContaining('"type":"user"')
      );
      expect(proc.stdin.write).toHaveBeenCalledWith(
        expect.stringContaining('hello')
      );
    });

    it('cancel keeps process alive and reuses it for next message', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc1 = getLastProcess();
      emitInit(proc1);
      emitAssistant(proc1, 'partial');

      backend.cancelSession('tab1');
      // Process is NOT killed — turn is cancelled, process kept alive
      expect(proc1.killed).toBe(false);

      // Simulate the cancelled turn finishing
      emitResult(proc1);

      // Next message should reuse the same process
      backend.sendMessage('tab1', 'again', '/tmp');
      expect(spawnedProcesses.length).toBe(1);
    });

    it('spawns a new process after reset', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc1 = getLastProcess();
      emitInit(proc1);

      backend.resetSession('tab1');
      expect(proc1.killed).toBe(true);

      backend.sendMessage('tab1', 'fresh start', '/tmp');
      expect(spawnedProcesses.length).toBe(2);
    });
  });

  describe('IPC events', () => {
    it('sends agent:user-message on sendMessage', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const msgs = findMessages('agent:user-message:tab1');
      expect(msgs.length).toBe(1);
      expect(msgs[0].args[0]).toBe('hello');
    });

    it('sends agent:output on assistant text', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();
      emitInit(proc);
      emitAssistant(proc, 'response text');
      const outputs = findMessages('agent:output:tab1');
      expect(outputs.length).toBeGreaterThan(0);
      expect(outputs[0].args[0]).toBe('response text');
    });

    it('sends agent:done on result event', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();
      emitInit(proc);
      emitAssistant(proc, 'response');
      emitResult(proc);
      const dones = findMessages('agent:done:tab1');
      expect(dones.length).toBe(1);
    });

    it('sends agent:error when process dies unexpectedly during processing', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();
      emitInit(proc);

      // Process dies while we're expecting a response
      proc.stderr.emit('data', Buffer.from('segfault'));
      proc.exitCode = 1;
      proc.emit('close', 1);

      const errors = findMessages('agent:error:tab1');
      expect(errors.length).toBe(1);
      expect(errors[0].args[0]).toBe('segfault');
    });

    it('sends agent:queued when message is queued during processing', () => {
      backend.sendMessage('tab1', 'first', '/tmp');
      const proc = getLastProcess();
      emitInit(proc);
      // First message is being processed (fullResponse not empty yet)
      emitAssistant(proc, 'partial');

      backend.sendMessage('tab1', 'second', '/tmp');
      const queued = findMessages('agent:queued:tab1');
      expect(queued.length).toBe(1);
    });
  });

  describe('crash recovery', () => {
    it('spawns new process after unexpected exit', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();
      emitInit(proc);

      // Process crashes
      proc.exitCode = 1;
      proc.emit('close', 1);

      // Next message should spawn a new process
      backend.sendMessage('tab1', 'retry', '/tmp');
      expect(spawnedProcesses.length).toBe(2);
    });

    it('sends generic error when process exits with no stderr', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();
      emitInit(proc);

      proc.exitCode = 2;
      proc.emit('close', 2);

      const errors = findMessages('agent:error:tab1');
      expect(errors.length).toBe(1);
      expect((errors[0].args[0] as string)).toContain('exited unexpectedly');
    });
  });

  describe('process timeout (watchdog)', () => {
    it('kills process after timeout when no result event arrives', async () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();
      emitInit(proc);

      // Wait for the 1s timeout
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(proc.killed).toBe(true);
    });
  });

  describe('spawn error', () => {
    it('sends error on spawn failure', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();
      proc.emit('error', new Error('ENOENT: claude not found'));
      const errors = findMessages('agent:error:tab1');
      expect(errors.length).toBe(1);
      expect(errors[0].args[0]).toBe('ENOENT: claude not found');
    });

    it('resets processing flag on spawn error', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();
      proc.emit('error', new Error('ENOENT: claude not found'));
      const history = backend.getHistory('tab1');
      expect(history.processing).toBe(false);
    });
  });

  describe('queue draining', () => {
    it('processes queued messages after result event', () => {
      backend.sendMessage('tab1', 'first', '/tmp');
      const proc = getLastProcess();
      emitInit(proc);

      // First message sent via stdin
      emitAssistant(proc, 'response 1');

      // Queue second message while first is processing
      backend.sendMessage('tab1', 'second', '/tmp');

      // First completes
      emitResult(proc);

      // Second should have been written to stdin (same process)
      const stdinWrites = proc.stdin.write.mock.calls;
      const secondWrite = stdinWrites.find((call: [string]) =>
        call[0].includes('second')
      );
      expect(secondWrite).toBeDefined();
    });

    it('writes first message to stdin immediately without waiting for init', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();

      // Message should be written to stdin immediately — no init event needed
      expect(proc.stdin.write).toHaveBeenCalledTimes(1);
      expect(proc.stdin.write).toHaveBeenCalledWith(
        expect.stringContaining('hello')
      );

      // Init event arrives later (as it does in real Claude CLI)
      emitInit(proc);

      // No additional writes from init — the message was already sent
      expect(proc.stdin.write).toHaveBeenCalledTimes(1);
    });
  });

  describe('no init-gate deadlock', () => {
    it('does not deadlock when init event requires input first', () => {
      // This test verifies the fix for issue #181:
      // Claude CLI with --input-format stream-json does NOT emit the
      // system init event until it receives input on stdin. The old code
      // waited for init before sending the first message, causing a deadlock.
      backend.sendMessage('tab1', 'count to ten', '/tmp');
      const proc = getLastProcess();

      // Message must be written to stdin BEFORE any init event
      expect(proc.stdin.write).toHaveBeenCalledTimes(1);
      const written = proc.stdin.write.mock.calls[0][0] as string;
      expect(written).toContain('count to ten');
      expect(written).toContain('"type":"user"');

      // Now init arrives (triggered by the input we just sent)
      emitInit(proc);
      expect(proc.stdin.write).toHaveBeenCalledTimes(1); // no extra writes

      // Process responds normally
      emitAssistant(proc, '1 2 3 4 5 6 7 8 9 10');
      emitResult(proc);

      const history = backend.getHistory('tab1');
      expect(history.messages).toHaveLength(2);
      expect(history.messages[1].content).toBe('1 2 3 4 5 6 7 8 9 10');
      expect(history.processing).toBe(false);
    });

    it('still queues messages when a response is in progress', () => {
      backend.sendMessage('tab1', 'first', '/tmp');
      const proc = getLastProcess();
      emitInit(proc);
      emitAssistant(proc, 'partial response');

      // Second message while first is processing (fullResponse is non-empty)
      backend.sendMessage('tab1', 'second', '/tmp');
      const queued = findMessages('agent:queued:tab1');
      expect(queued.length).toBe(1);

      // Complete first response — second should be dequeued
      emitResult(proc);
      const secondWrite = proc.stdin.write.mock.calls.find((call: [string]) =>
        call[0].includes('second')
      );
      expect(secondWrite).toBeDefined();
    });
  });

  describe('getAuthStatus', () => {
    it('returns an AuthStatus shape', async () => {
      const fs = await import('fs');
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const statusPromise = backend.getAuthStatus();

      const authProc = spawnedProcesses[spawnedProcesses.length - 1];
      if (authProc) {
        setTimeout(() => {
          authProc.emit('close', 1);
        }, 10);
      }

      const status = await statusPromise;
      expect(status).toHaveProperty('loggedIn');
      expect(status).toHaveProperty('expired');
    }, 5000);
  });

  describe('syncCredentials', () => {
    it('handles empty stacks list without error', async () => {
      await expect(backend.syncCredentials([])).resolves.toBeUndefined();
    });

    it('skips stacks that are not running', async () => {
      await expect(
        backend.syncCredentials([{ status: 'stopped', services: [] }])
      ).resolves.toBeUndefined();
    });
  });

  describe('outer model wiring', () => {
    it('passes --model flag when modelResolver is provided', async () => {
      const { spawn } = await import('child_process');
      const spawnMock = spawn as ReturnType<typeof vi.fn>;
      spawnMock.mockClear();

      const resolvedBackend = new ClaudeBackend(1000, () => 'opus');
      resolvedBackend.setMainWindow(mockWindow as never);
      await resolvedBackend.initialize();

      resolvedBackend.sendMessage('tab-model', 'hello', '/some/project');

      const callArgs = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
      const spawnedArgs: string[] = callArgs[1];
      const modelIdx = spawnedArgs.indexOf('--model');
      expect(modelIdx).toBeGreaterThan(-1);
      expect(spawnedArgs[modelIdx + 1]).toBe('opus');

      resolvedBackend.destroy();
    });

    it('does not pass --model flag when no modelResolver', async () => {
      const { spawn } = await import('child_process');
      const spawnMock = spawn as ReturnType<typeof vi.fn>;
      spawnMock.mockClear();

      backend.sendMessage('tab-nomodel', 'hello', '/some/project');

      const callArgs = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
      const spawnedArgs: string[] = callArgs[1];
      expect(spawnedArgs.includes('--model')).toBe(false);
    });

    it('does not pass --model flag when no projectDir is given', async () => {
      const { spawn } = await import('child_process');
      const spawnMock = spawn as ReturnType<typeof vi.fn>;
      spawnMock.mockClear();

      const resolvedBackend = new ClaudeBackend(1000, () => 'opus');
      resolvedBackend.setMainWindow(mockWindow as never);
      await resolvedBackend.initialize();

      resolvedBackend.sendMessage('tab-noproj', 'hello');

      const callArgs = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
      const spawnedArgs: string[] = callArgs[1];
      expect(spawnedArgs.includes('--model')).toBe(false);

      resolvedBackend.destroy();
    });
  });

  describe('stream-json flags', () => {
    it('uses --input-format stream-json and --output-format stream-json', async () => {
      const { spawn } = await import('child_process');
      const spawnMock = spawn as ReturnType<typeof vi.fn>;
      spawnMock.mockClear();

      backend.sendMessage('tab-flags', 'hello', '/tmp');

      const callArgs = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
      const spawnedArgs: string[] = callArgs[1];
      expect(spawnedArgs).toContain('--input-format');
      expect(spawnedArgs).toContain('stream-json');
      expect(spawnedArgs).toContain('--output-format');
      expect(spawnedArgs).toContain('--print');
      // Should NOT have --resume or --session-id
      expect(spawnedArgs).not.toContain('--resume');
      expect(spawnedArgs).not.toContain('--session-id');
    });

    it('uses pipe for stdin (not ignore)', async () => {
      const { spawn } = await import('child_process');
      const spawnMock = spawn as ReturnType<typeof vi.fn>;
      spawnMock.mockClear();

      backend.sendMessage('tab-stdio', 'hello', '/tmp');

      const callOpts = spawnMock.mock.calls[spawnMock.mock.calls.length - 1][2];
      expect(callOpts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    });
  });

  describe('--tools allowlist (#256)', () => {
    it('passes --tools with the default allowlist (comma-separated)', async () => {
      const { spawn } = await import('child_process');
      const spawnMock = spawn as ReturnType<typeof vi.fn>;
      spawnMock.mockClear();

      backend.sendMessage('tab-tools-default', 'hello', '/tmp');

      const spawnedArgs: string[] = spawnMock.mock.calls[spawnMock.mock.calls.length - 1][1];
      const toolsIdx = spawnedArgs.indexOf('--tools');
      expect(toolsIdx).toBeGreaterThan(-1);
      expect(spawnedArgs[toolsIdx + 1]).toBe('Bash,Read,Grep,Glob');
    });

    it('places --tools before --system-prompt-file and --mcp-config', async () => {
      const { spawn } = await import('child_process');
      const spawnMock = spawn as ReturnType<typeof vi.fn>;
      spawnMock.mockClear();

      backend.sendMessage('tab-tools-order', 'hello', '/tmp');

      const spawnedArgs: string[] = spawnMock.mock.calls[spawnMock.mock.calls.length - 1][1];
      const toolsIdx = spawnedArgs.indexOf('--tools');
      const mcpIdx = spawnedArgs.indexOf('--mcp-config');
      expect(toolsIdx).toBeGreaterThan(-1);
      expect(mcpIdx).toBeGreaterThan(-1);
      // --tools comes before --mcp-config so it lives in the stable prefix
      // that cache-hits turn-to-turn.
      expect(toolsIdx).toBeLessThan(mcpIdx);
    });

    it('does not include denied tools in the --tools arg', async () => {
      const { spawn } = await import('child_process');
      const spawnMock = spawn as ReturnType<typeof vi.fn>;
      spawnMock.mockClear();

      backend.sendMessage('tab-tools-deny', 'hello', '/tmp');

      const spawnedArgs: string[] = spawnMock.mock.calls[spawnMock.mock.calls.length - 1][1];
      const toolsArg = spawnedArgs[spawnedArgs.indexOf('--tools') + 1];
      for (const denied of [
        'Edit',
        'Write',
        'MultiEdit',
        'NotebookEdit',
        'Agent',
        'TaskCreate',
        'TaskUpdate',
        'TaskList',
        'TaskGet',
        'TaskStop',
        'TaskOutput',
        'WebFetch',
        'WebSearch',
        'LSP',
      ]) {
        expect(toolsArg).not.toContain(denied);
      }
    });

    it('falls back to defaults when no projectDir is given', async () => {
      const { spawn } = await import('child_process');
      const spawnMock = spawn as ReturnType<typeof vi.fn>;
      spawnMock.mockClear();

      backend.sendMessage('tab-tools-noproj', 'hello');

      const spawnedArgs: string[] = spawnMock.mock.calls[spawnMock.mock.calls.length - 1][1];
      const toolsIdx = spawnedArgs.indexOf('--tools');
      expect(spawnedArgs[toolsIdx + 1]).toBe('Bash,Read,Grep,Glob');
    });
  });

  describe('initLogger error handling', () => {
    it('does not throw when createWriteStream fails', () => {
      expect(() => new ClaudeBackend(1000)).not.toThrow();
    });
  });
});

describe('Watchdog resets on streaming output', () => {
  let backend: AgentBackend;
  let mockWindow: { webContents: { send: ReturnType<typeof vi.fn> } };

  beforeEach(async () => {
    spawnedProcesses.length = 0;
    mockWindow = {
      webContents: {
        send: vi.fn(),
      },
    };
    // Use 2s watchdog for this test
    backend = new ClaudeBackend(2000);
    backend.setMainWindow(mockWindow as never);
    await backend.initialize();
  });

  afterEach(() => {
    backend.destroy();
    vi.clearAllMocks();
  });

  it('does not kill the process when streaming text arrives within timeout', async () => {
    backend.sendMessage('tab1', 'hello', '/tmp');
    const proc = spawnedProcesses[spawnedProcesses.length - 1];

    const initEvent = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' });
    proc.stdout.emit('data', Buffer.from(initEvent + '\n'));

    // Stream text at 1.5s intervals — each should reset the 2s watchdog
    await new Promise((r) => setTimeout(r, 1500));
    const assistantEvent = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'chunk1' }] },
    });
    proc.stdout.emit('data', Buffer.from(assistantEvent + '\n'));

    await new Promise((r) => setTimeout(r, 1500));
    const assistantEvent2 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'chunk2' }] },
    });
    proc.stdout.emit('data', Buffer.from(assistantEvent2 + '\n'));

    // Total time: 3s > 2s watchdog, but process should be alive since watchdog was reset
    expect(proc.killed).toBe(false);
  }, 10000);
});

describe('Watchdog timeout is longer than MCP tool chain', () => {
  it('default timeout is 600s (10 minutes), longer than ephemeral 300s + bridge 310s', async () => {
    const backend = new ClaudeBackend();
    // Access the private timeoutMs via type assertion
    const timeoutMs = (backend as unknown as { timeoutMs: number }).timeoutMs;
    expect(timeoutMs).toBe(600_000);
    expect(timeoutMs).toBeGreaterThan(310_000); // Must exceed bridge timeout
    backend.destroy();
  });
});

describe('Token telemetry wiring (#262 tactic A)', () => {
  let origFlag: string | undefined;

  beforeEach(() => {
    origFlag = process.env.SANDSTORM_TOKEN_TELEMETRY;
  });

  afterEach(() => {
    if (origFlag === undefined) delete process.env.SANDSTORM_TOKEN_TELEMETRY;
    else process.env.SANDSTORM_TOKEN_TELEMETRY = origFlag;
  });

  it('does not emit telemetry appends when the flag is off', async () => {
    delete process.env.SANDSTORM_TOKEN_TELEMETRY;
    const fs = await import('fs');
    vi.mocked(fs.appendFileSync).mockClear();

    const backend = new ClaudeBackend();
    // A full turn lifecycle — any telemetry append would happen inside the
    // result handler. With the flag off, zero appends to the telemetry path.
    backend.sendMessage('tel-off', 'hi', '/tmp');
    const proc = spawnedProcesses[spawnedProcesses.length - 1];
    proc.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'result',
          result: 'ok',
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 0,
          },
        }) + '\n'
      )
    );

    const telemetryAppends = vi
      .mocked(fs.appendFileSync)
      .mock.calls.filter((c) => String(c[0]).endsWith('sandstorm-desktop-token-telemetry.jsonl'));
    expect(telemetryAppends.length).toBe(0);

    backend.destroy();
  });

  it('writes a per-turn telemetry line when the flag is on', async () => {
    process.env.SANDSTORM_TOKEN_TELEMETRY = '1';
    const fs = await import('fs');
    vi.mocked(fs.appendFileSync).mockClear();

    const backend = new ClaudeBackend();
    backend.sendMessage('tel-on', 'hi', '/proj');
    const proc = spawnedProcesses[spawnedProcesses.length - 1];
    proc.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'result',
          result: 'ok',
          usage: {
            input_tokens: 1234,
            output_tokens: 56,
            cache_creation_input_tokens: 28_000,
            cache_read_input_tokens: 0,
          },
        }) + '\n'
      )
    );

    const telemetryAppends = vi
      .mocked(fs.appendFileSync)
      .mock.calls.filter((c) => String(c[0]).endsWith('sandstorm-desktop-token-telemetry.jsonl'));
    expect(telemetryAppends.length).toBe(1);
    const jsonLine = telemetryAppends[0][1] as string;
    const event = JSON.parse(jsonLine.trim());
    expect(event.tabId).toBe('tel-on');
    expect(event.projectDir).toBe('/proj');
    expect(event.turn_index).toBe(0);
    expect(event.seconds_since_prev_turn).toBeNull();
    expect(event.input_tokens).toBe(1234);
    expect(event.output_tokens).toBe(56);
    expect(event.cache_creation_input_tokens).toBe(28_000);
    expect(event.cache_read_input_tokens).toBe(0);

    backend.destroy();
  });
});

describe('cancelSession — turn cancellation', () => {
  let backend: AgentBackend;
  let mockWindow: { webContents: { send: ReturnType<typeof vi.fn> } };
  let sentMessages: Array<{ channel: string; args: unknown[] }>;

  beforeEach(async () => {
    spawnedProcesses.length = 0;
    sentMessages = [];
    mockWindow = {
      webContents: {
        send: vi.fn((...args: unknown[]) => {
          sentMessages.push({ channel: args[0] as string, args: args.slice(1) });
        }),
      },
    };
    backend = new ClaudeBackend(60_000);
    backend.setMainWindow(mockWindow as never);
    await backend.initialize();
  });

  afterEach(() => {
    backend.destroy();
    vi.clearAllMocks();
  });

  function findMessages(channelPattern: string): Array<{ channel: string; args: unknown[] }> {
    return sentMessages.filter((m) => m.channel.includes(channelPattern));
  }

  it('sends agent:done and keeps process alive on cancel', () => {
    backend.sendMessage('tab1', 'hello', '/tmp');
    const proc = spawnedProcesses[0];
    const initEvent = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' });
    proc.stdout.emit('data', Buffer.from(initEvent + '\n'));
    const assistantEvent = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'partial' }] },
    });
    proc.stdout.emit('data', Buffer.from(assistantEvent + '\n'));

    backend.cancelSession('tab1');

    expect(proc.killed).toBe(false);
    const dones = findMessages('agent:done:tab1');
    expect(dones.length).toBe(1);
  });

  it('discards output from cancelled turn and dequeues next message on result', () => {
    backend.sendMessage('tab1', 'first', '/tmp');
    const proc = spawnedProcesses[0];
    const initEvent = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' });
    proc.stdout.emit('data', Buffer.from(initEvent + '\n'));
    const assistantEvent = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'old response' }] },
    });
    proc.stdout.emit('data', Buffer.from(assistantEvent + '\n'));

    // Cancel and queue a new message
    backend.cancelSession('tab1');
    backend.sendMessage('tab1', 'second', '/tmp');

    // The cancelled turn finishes
    const resultEvent = JSON.stringify({ type: 'result', result: 'ok' });
    proc.stdout.emit('data', Buffer.from(resultEvent + '\n'));

    // Second message should have been written to stdin
    const stdinWrites = proc.stdin.write.mock.calls;
    const secondWrite = stdinWrites.find((call: [string]) =>
      call[0].includes('second')
    );
    expect(secondWrite).toBeDefined();

    // The cancelled turn's response should NOT be in history
    const history = backend.getHistory('tab1');
    const assistantMessages = history.messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages.length).toBe(0);
  });

  it('resetSession still kills the process', () => {
    backend.sendMessage('tab1', 'hello', '/tmp');
    const proc = spawnedProcesses[0];
    const initEvent = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' });
    proc.stdout.emit('data', Buffer.from(initEvent + '\n'));

    backend.resetSession('tab1');
    expect(proc.killed).toBe(true);
  });
});

describe('Tool use event logging', () => {
  let backend: ClaudeBackend;
  let logSpy: ReturnType<typeof vi.fn>;
  let mockWindow: { webContents: { send: ReturnType<typeof vi.fn> } };

  beforeEach(async () => {
    spawnedProcesses.length = 0;
    mockWindow = {
      webContents: {
        send: vi.fn(),
      },
    };
    backend = new ClaudeBackend(60_000);
    backend.setMainWindow(mockWindow as never);
    await backend.initialize();
    // Spy on the log method
    logSpy = vi.fn();
    (backend as unknown as { log: ReturnType<typeof vi.fn> }).log = logSpy;
  });

  afterEach(() => {
    backend.destroy();
    vi.clearAllMocks();
  });

  it('logs content_block_start tool_use events', () => {
    backend.sendMessage('tab1', 'hello', '/tmp');
    const proc = spawnedProcesses[0];
    const initEvent = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test' });
    proc.stdout.emit('data', Buffer.from(initEvent + '\n'));

    const toolEvent = JSON.stringify({
      type: 'content_block_start',
      content_block: { type: 'tool_use', name: 'spec_check', id: 'tool_123' },
    });
    proc.stdout.emit('data', Buffer.from(toolEvent + '\n'));

    const toolLogCalls = logSpy.mock.calls.filter(
      (call: [string]) => call[0].includes('Tool call:')
    );
    expect(toolLogCalls.length).toBe(1);
    expect(toolLogCalls[0][0]).toContain('spec_check');
    expect(toolLogCalls[0][0]).toContain('tool_123');
  });
});

describe('ClaudeBackend.runEphemeralAgent — promise settlement', () => {
  beforeEach(() => {
    spawnedProcesses.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function getEphemeralProcess(): MockChildProcess {
    return spawnedProcesses[spawnedProcesses.length - 1];
  }

  it('resolves exactly once on normal exit', async () => {
    const backendUnderTest = new ClaudeBackend(60_000);

    const resultPromise = backendUnderTest.runEphemeralAgent('test prompt', '/tmp', 5_000);

    const proc = getEphemeralProcess();
    const resultLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'output text' }] } });
    proc.stdout.emit('data', Buffer.from(resultLine + '\n'));
    proc.exitCode = 0;
    proc.emit('close', 0);

    // Advance timers — timeout fires after close, should be a no-op
    vi.advanceTimersByTime(6_000);

    const result = await resultPromise;
    expect(result).toBe('output text');

    backendUnderTest.destroy();
  });

  it('rejects exactly once on timeout and does not double-settle when close fires later', async () => {
    const backendUnderTest = new ClaudeBackend(60_000);

    const resultPromise = backendUnderTest.runEphemeralAgent('test prompt', '/tmp', 3_000);
    const proc = getEphemeralProcess();

    // Timeout fires before the process exits
    vi.advanceTimersByTime(3_100);

    // Now the process exits — this close event must NOT cause a second settlement
    proc.exitCode = 143;
    proc.emit('close', 143);

    await expect(resultPromise).rejects.toThrow('Ephemeral agent timed out after 3000ms');

    backendUnderTest.destroy();
  });

  it('settles exactly once when both error and close events fire', async () => {
    const backendUnderTest = new ClaudeBackend(60_000);

    const resultPromise = backendUnderTest.runEphemeralAgent('test prompt', '/tmp', 5_000);
    const proc = getEphemeralProcess();

    // Emit both error and close — only first settlement should count
    proc.emit('error', new Error('ENOENT: spawn failed'));
    proc.exitCode = 1;
    proc.emit('close', 1);

    await expect(resultPromise).rejects.toThrow('ENOENT: spawn failed');

    backendUnderTest.destroy();
  });
});

describe('Outer-Claude session token accumulation (agent:token-usage IPC)', () => {
  let backend: AgentBackend;
  let mockWindow: { webContents: { send: ReturnType<typeof vi.fn> } };
  let sentMessages: Array<{ channel: string; args: unknown[] }>;

  beforeEach(async () => {
    spawnedProcesses.length = 0;
    sentMessages = [];
    mockWindow = {
      webContents: {
        send: vi.fn((...args: unknown[]) => {
          sentMessages.push({ channel: args[0] as string, args: args.slice(1) });
        }),
      },
    };
    backend = new ClaudeBackend(60_000);
    backend.setMainWindow(mockWindow as never);
    await backend.initialize();
  });

  afterEach(() => {
    backend.destroy();
    vi.clearAllMocks();
  });

  function findMessages(channelPattern: string): Array<{ channel: string; args: unknown[] }> {
    return sentMessages.filter((m) => m.channel.includes(channelPattern));
  }

  /** Emit a result event with an optional usage payload. */
  function emitResultWithUsage(
    proc: MockChildProcess,
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    }
  ): void {
    const event: Record<string, unknown> = { type: 'result', result: 'ok', total_cost_usd: 0.01 };
    if (usage) event.usage = usage;
    proc.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  }

  function emitInit(proc: MockChildProcess): void {
    const initEvent = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test-session' });
    proc.stdout.emit('data', Buffer.from(initEvent + '\n'));
  }

  it('emits accumulated token usage on agent:token-usage:<tabId> across multiple result events', () => {
    backend.sendMessage('tab1', 'first', '/tmp');
    const proc = spawnedProcesses[spawnedProcesses.length - 1];
    emitInit(proc);

    // Turn 1
    emitResultWithUsage(proc, {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
    });

    // Turn 2
    backend.sendMessage('tab1', 'second', '/tmp');
    emitResultWithUsage(proc, {
      input_tokens: 200,
      output_tokens: 75,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 15,
    });

    const usageMessages = findMessages('agent:token-usage:tab1');
    expect(usageMessages.length).toBe(2);

    // First emission: just turn 1's totals
    expect(usageMessages[0].args[0]).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
    });

    // Second emission: accumulated across both turns
    expect(usageMessages[1].args[0]).toEqual({
      input_tokens: 300,
      output_tokens: 125,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 20,
    });
  });

  it('resetSession emits a zero-token payload on agent:token-usage:<tabId>', () => {
    backend.sendMessage('tab1', 'hello', '/tmp');
    const proc = spawnedProcesses[spawnedProcesses.length - 1];
    emitInit(proc);

    // Seed non-zero session tokens
    emitResultWithUsage(proc, {
      input_tokens: 1234,
      output_tokens: 567,
      cache_creation_input_tokens: 89,
      cache_read_input_tokens: 42,
    });

    const beforeReset = findMessages('agent:token-usage:tab1');
    expect(beforeReset.length).toBe(1);
    expect(beforeReset[0].args[0]).toEqual({
      input_tokens: 1234,
      output_tokens: 567,
      cache_creation_input_tokens: 89,
      cache_read_input_tokens: 42,
    });

    backend.resetSession('tab1');

    const afterReset = findMessages('agent:token-usage:tab1');
    expect(afterReset.length).toBe(2);
    // Last emission must be zeros — this is what the renderer relies on
    // to clear the counter when the user clicks "New Session".
    expect(afterReset[afterReset.length - 1].args[0]).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });

  it('passes through cache_creation_input_tokens and cache_read_input_tokens fields', () => {
    backend.sendMessage('tab1', 'cache-heavy', '/tmp');
    const proc = spawnedProcesses[spawnedProcesses.length - 1];
    emitInit(proc);

    // Cache fields are the newly-wired layer — verify each is summed
    // independently. Use distinct values so a regression that drops
    // one field (or aliases two together) is caught.
    emitResultWithUsage(proc, {
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 4444,
      cache_read_input_tokens: 8888,
    });

    const usageMessages = findMessages('agent:token-usage:tab1');
    expect(usageMessages.length).toBe(1);
    const payload = usageMessages[0].args[0] as {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
    expect(payload.cache_creation_input_tokens).toBe(4444);
    expect(payload.cache_read_input_tokens).toBe(8888);
    expect(payload.input_tokens).toBe(1);
    expect(payload.output_tokens).toBe(2);
  });

  it('isolates token totals per tabId — emissions on one tab do not leak into another', () => {
    backend.sendMessage('tabA', 'hello', '/tmp');
    const procA = spawnedProcesses[spawnedProcesses.length - 1];
    emitInit(procA);

    backend.sendMessage('tabB', 'hello', '/tmp');
    const procB = spawnedProcesses[spawnedProcesses.length - 1];
    emitInit(procB);

    emitResultWithUsage(procA, { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    emitResultWithUsage(procB, { input_tokens: 999, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

    const aMessages = findMessages('agent:token-usage:tabA');
    const bMessages = findMessages('agent:token-usage:tabB');
    expect(aMessages.length).toBe(1);
    expect(bMessages.length).toBe(1);
    expect((aMessages[0].args[0] as { input_tokens: number }).input_tokens).toBe(100);
    expect((bMessages[0].args[0] as { input_tokens: number }).input_tokens).toBe(999);
  });
});
