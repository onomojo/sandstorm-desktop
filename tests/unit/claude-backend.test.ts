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

    it('writes NDJSON to stdin for messages after init', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();
      emitInit(proc);

      // The queued message should have been written to stdin
      expect(proc.stdin.write).toHaveBeenCalledWith(
        expect.stringContaining('"type":"user"')
      );
      expect(proc.stdin.write).toHaveBeenCalledWith(
        expect.stringContaining('hello')
      );
    });

    it('spawns a new process after cancel', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc1 = getLastProcess();
      emitInit(proc1);

      backend.cancelSession('tab1');
      expect(proc1.killed).toBe(true);

      backend.sendMessage('tab1', 'again', '/tmp');
      expect(spawnedProcesses.length).toBe(2);
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

    it('sends queued message after init event', () => {
      // Send message before init event
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();

      // Message should be queued, not written yet
      const writesBeforeInit = proc.stdin.write.mock.calls.length;

      // Now emit init
      emitInit(proc);

      // Message should have been written
      expect(proc.stdin.write.mock.calls.length).toBeGreaterThan(writesBeforeInit);
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

  describe('initLogger error handling', () => {
    it('does not throw when createWriteStream fails', () => {
      expect(() => new ClaudeBackend(1000)).not.toThrow();
    });
  });
});
