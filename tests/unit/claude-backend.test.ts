import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

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
  stdin = { write: vi.fn(), end: vi.fn() };
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

  describe('IPC events use agent: prefix', () => {
    it('sends agent:user-message on sendMessage', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const msgs = findMessages('agent:user-message:tab1');
      expect(msgs.length).toBe(1);
      expect(msgs[0].args[0]).toBe('hello');
    });

    it('sends agent:output on stdout data', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();
      proc.stdout.emit('data', Buffer.from('some text\n'));
      const outputs = findMessages('agent:output:tab1');
      expect(outputs.length).toBeGreaterThan(0);
    });

    it('sends agent:done on successful exit', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();
      proc.exitCode = 0;
      proc.emit('close', 0);
      const dones = findMessages('agent:done:tab1');
      expect(dones.length).toBe(1);
    });

    it('sends agent:error on non-zero exit with no output', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();
      proc.stderr.emit('data', Buffer.from('Authentication failed'));
      proc.exitCode = 1;
      proc.emit('close', 1);
      const errors = findMessages('agent:error:tab1');
      expect(errors.length).toBe(1);
      expect(errors[0].args[0]).toBe('Authentication failed');
    });

    it('sends agent:queued when message is queued', () => {
      backend.sendMessage('tab1', 'first', '/tmp');
      backend.sendMessage('tab1', 'second', '/tmp');
      const queued = findMessages('agent:queued:tab1');
      expect(queued.length).toBe(1);
    });
  });

  describe('stderr forwarding', () => {
    it('sends done (not error) when process exits non-zero but has output', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();
      proc.stdout.emit('data', Buffer.from('some output\n'));
      proc.stderr.emit('data', Buffer.from('some warning'));
      proc.exitCode = 1;
      proc.emit('close', 1);
      const errors = findMessages('agent:error:tab1');
      const dones = findMessages('agent:done:tab1');
      expect(errors.length).toBe(0);
      expect(dones.length).toBe(1);
    });

    it('sends generic error message when exit non-zero with no stderr', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();
      proc.exitCode = 2;
      proc.emit('close', 2);
      const errors = findMessages('agent:error:tab1');
      expect(errors.length).toBe(1);
      expect(errors[0].args[0]).toBe('Claude exited with code 2');
    });
  });

  describe('process timeout', () => {
    it('kills process after timeout and sends error', async () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(proc.killed).toBe(true);
      const errors = findMessages('agent:error:tab1');
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect((errors[0].args[0] as string)).toContain('timed out');
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

    it('resets processing flag on spawn error (fixes #28)', () => {
      backend.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();
      proc.emit('error', new Error('ENOENT: claude not found'));
      const history = backend.getHistory('tab1');
      expect(history.processing).toBe(false);
    });

    it('drains pending queue after spawn error (fixes #28)', () => {
      backend.sendMessage('tab1', 'first', '/tmp');
      backend.sendMessage('tab1', 'second', '/tmp');
      expect(spawnedProcesses.length).toBe(1);
      const proc = getLastProcess();
      proc.emit('error', new Error('ENOENT'));
      expect(spawnedProcesses.length).toBe(2);
    });

    it('sets processing=false when queue is empty after spawn error (fixes #28)', () => {
      backend.sendMessage('tab1', 'only-message', '/tmp');
      const proc = getLastProcess();
      proc.emit('error', new Error('ENOENT'));
      const history = backend.getHistory('tab1');
      expect(history.processing).toBe(false);
    });
  });

  describe('queue draining', () => {
    it('processes queued messages after first completes', () => {
      backend.sendMessage('tab1', 'first', '/tmp');
      backend.sendMessage('tab1', 'second', '/tmp');
      expect(spawnedProcesses.length).toBe(1);
      const proc = getLastProcess();
      proc.exitCode = 0;
      proc.emit('close', 0);
      expect(spawnedProcesses.length).toBe(2);
    });
  });

  describe('getAuthStatus', () => {
    it('returns an AuthStatus shape', async () => {
      // Mock readFileSync to throw for credentials file, but also
      // ensure the spawned process resolves quickly
      const fs = await import('fs');
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const statusPromise = backend.getAuthStatus();

      // The auth status spawns a claude process — make it exit immediately
      // (readFileSync throws so we should get loggedIn=false before spawning,
      // but if it does spawn, resolve it)
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
});
