/**
 * Tests that actually invoke the wrapper shell script (sandstorm-scheduled-run.sh)
 * with SANDSTORM_SOCK override pointing at a test socket.
 *
 * Covers:
 * - app-not-running skip (exit 0) — socket does not exist
 * - ok-false skip (exit 0) — server responds with { ok: false }
 * - ok-true dispatch (exit 0) — server responds with { ok: true }
 * - malformed JSON (exit 1) — server responds with garbage
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const execFileAsync = promisify(execFile);
const WRAPPER_PATH = path.resolve(__dirname, '../../resources/bin/sandstorm-scheduled-run.sh');

// Skip on Windows — wrapper is POSIX shell only
const isWindows = os.platform() === 'win32';

/**
 * Start a Unix domain socket server that sends a fixed response to the first connection.
 */
function startMockServer(
  sockPath: string,
  response: string
): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((conn) => {
      let data = '';
      conn.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('\n')) {
          conn.write(response + '\n');
          conn.end();
        }
      });
    });
    server.on('error', reject);
    server.listen(sockPath, () => resolve(server));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

describe.skipIf(isWindows)('wrapper script (sandstorm-scheduled-run.sh)', () => {
  let tmpDir: string;

  beforeAll(() => {
    // Ensure wrapper exists and is executable
    expect(fs.existsSync(WRAPPER_PATH)).toBe(true);
    fs.chmodSync(WRAPPER_PATH, 0o755);
  });

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-wrapper-test-'));
    return tmpDir;
  }

  async function runWrapper(
    sockPath: string,
    args: string[] = ['/tmp/test-project', 'sch_test123']
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
      const result = await execFileAsync('/bin/sh', [WRAPPER_PATH, ...args], {
        env: {
          ...process.env,
          SANDSTORM_SOCK: sockPath,
          HOME: os.homedir(),
          PATH: process.env.PATH,
        },
        timeout: 10000,
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (err: unknown) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string };
      if (typeof e.code === 'number') {
        return { exitCode: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
      }
      // execFile sets code to the exit code on non-zero
      const exitCode =
        (err as { status?: number }).status ??
        (typeof e.code === 'string' ? 1 : 1);
      return { exitCode, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  it('--protocol-version outputs version number', async () => {
    const result = await runWrapper('/nonexistent', ['--protocol-version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1');
  });

  it('app-not-running: exits 0 when socket does not exist', async () => {
    const dir = makeTmpDir();
    const sockPath = path.join(dir, 'nonexistent.sock');
    const result = await runWrapper(sockPath);
    expect(result.exitCode).toBe(0);
  });

  it('ok-true: exits 0 when server responds with ok: true', async () => {
    const dir = makeTmpDir();
    const sockPath = path.join(dir, 'test.sock');
    const server = await startMockServer(
      sockPath,
      JSON.stringify({ ok: true, dispatchId: 'dispatch_test_1' })
    );
    try {
      const result = await runWrapper(sockPath);
      expect(result.exitCode).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it('ok-false: exits 0 when server responds with ok: false', async () => {
    const dir = makeTmpDir();
    const sockPath = path.join(dir, 'test.sock');
    const server = await startMockServer(
      sockPath,
      JSON.stringify({ ok: false, reason: 'rate-limited', message: 'Rate limit reached' })
    );
    try {
      const result = await runWrapper(sockPath);
      expect(result.exitCode).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it('malformed JSON: exits 1 when server responds with garbage', async () => {
    const dir = makeTmpDir();
    const sockPath = path.join(dir, 'test.sock');
    const server = await startMockServer(sockPath, 'NOT_VALID_JSON_AT_ALL');
    try {
      const result = await runWrapper(sockPath);
      expect(result.exitCode).toBe(1);
    } finally {
      await closeServer(server);
    }
  });
});
