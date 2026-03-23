import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

// Mock electron modules before importing session manager
vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  app: {
    getPath: () => '/tmp',
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

import { ClaudeSessionManager } from '../../src/main/claude/session-manager';

describe('ClaudeSessionManager', () => {
  let manager: ClaudeSessionManager;
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

    manager = new ClaudeSessionManager(1000); // 1s timeout for tests
    manager.setMainWindow(mockWindow as never);
    await manager.initialize();
  });

  afterEach(() => {
    manager.destroy();
    vi.clearAllMocks();
  });

  function getLastProcess(): MockChildProcess {
    return spawnedProcesses[spawnedProcesses.length - 1];
  }

  function findMessages(channelPattern: string): Array<{ channel: string; args: unknown[] }> {
    return sentMessages.filter((m) => m.channel.includes(channelPattern));
  }

  describe('stderr forwarding', () => {
    it('sends stderr as error when process exits non-zero with no stdout', () => {
      manager.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();

      proc.stderr.emit('data', Buffer.from('Authentication failed'));
      proc.exitCode = 1;
      proc.emit('close', 1);

      const errors = findMessages('claude:error:tab1');
      expect(errors.length).toBe(1);
      expect(errors[0].args[0]).toBe('Authentication failed');
    });

    it('sends done (not error) when process exits non-zero but has output', () => {
      manager.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();

      // Emit some valid stdout
      proc.stdout.emit('data', Buffer.from('some output\n'));
      proc.stderr.emit('data', Buffer.from('some warning'));
      proc.exitCode = 1;
      proc.emit('close', 1);

      const errors = findMessages('claude:error:tab1');
      const dones = findMessages('claude:done:tab1');
      expect(errors.length).toBe(0);
      expect(dones.length).toBe(1);
    });

    it('sends generic error message when exit non-zero with no stderr', () => {
      manager.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();

      proc.exitCode = 2;
      proc.emit('close', 2);

      const errors = findMessages('claude:error:tab1');
      expect(errors.length).toBe(1);
      expect(errors[0].args[0]).toBe('Claude exited with code 2');
    });
  });

  describe('process timeout', () => {
    it('kills process after timeout and sends error', async () => {
      manager.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();

      // Wait for timeout (1s in test)
      await new Promise((resolve) => setTimeout(resolve, 1200));

      expect(proc.killed).toBe(true);
      const errors = findMessages('claude:error:tab1');
      expect(errors.length).toBe(1);
      expect((errors[0].args[0] as string)).toContain('timed out');
    });
  });

  describe('queue visibility', () => {
    it('sends claude:queued event when message is queued', () => {
      manager.sendMessage('tab1', 'first message', '/tmp');
      // Process is now running — send another message
      manager.sendMessage('tab1', 'second message', '/tmp');

      const queued = findMessages('claude:queued:tab1');
      expect(queued.length).toBe(1);
    });

    it('does not send queued event for the first message', () => {
      manager.sendMessage('tab1', 'first message', '/tmp');

      const queued = findMessages('claude:queued:tab1');
      expect(queued.length).toBe(0);
    });
  });

  describe('exit code handling', () => {
    it('sends done on zero exit code', () => {
      manager.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();

      proc.exitCode = 0;
      proc.emit('close', 0);

      const dones = findMessages('claude:done:tab1');
      expect(dones.length).toBe(1);
      const errors = findMessages('claude:error:tab1');
      expect(errors.length).toBe(0);
    });
  });

  describe('spawn error', () => {
    it('sends error on spawn failure', () => {
      manager.sendMessage('tab1', 'hello', '/tmp');
      const proc = getLastProcess();

      proc.emit('error', new Error('ENOENT: claude not found'));

      const errors = findMessages('claude:error:tab1');
      expect(errors.length).toBe(1);
      expect(errors[0].args[0]).toBe('ENOENT: claude not found');
    });
  });

  describe('queue draining', () => {
    it('processes queued messages after first completes', () => {
      manager.sendMessage('tab1', 'first', '/tmp');
      manager.sendMessage('tab1', 'second', '/tmp');

      expect(spawnedProcesses.length).toBe(1);

      // Complete first process
      const proc = getLastProcess();
      proc.exitCode = 0;
      proc.emit('close', 0);

      // Second process should be spawned
      expect(spawnedProcesses.length).toBe(2);
    });
  });
});
