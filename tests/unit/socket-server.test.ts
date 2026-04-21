import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  SchedulerSocketServer,
  ScheduledDispatchRequest,
  ScheduledDispatchResponse,
} from '../../src/main/scheduler/socket-server';

let tmpDir: string;
let server: SchedulerSocketServer | null = null;

function tmpSocket(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-sock-test-'));
  return path.join(tmpDir, 'test.sock');
}

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function sendRequest(socketPath: string, data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.write(data + '\n');
    });
    let response = '';
    client.on('data', (chunk) => { response += chunk.toString(); });
    client.on('end', () => resolve(response.trim()));
    client.on('error', reject);
  });
}

describe('SchedulerSocketServer', () => {
  it('accepts a valid scheduled-dispatch request', async () => {
    const sockPath = tmpSocket();
    const handler = async (req: ScheduledDispatchRequest): Promise<ScheduledDispatchResponse> => {
      return { ok: true, dispatchId: 'test-dispatch-1' };
    };

    server = new SchedulerSocketServer(handler, sockPath);
    await server.start();

    const request: ScheduledDispatchRequest = {
      type: 'scheduled-dispatch',
      version: 1,
      projectDir: '/home/user/project',
      scheduleId: 'sch_abc',
      prompt: 'Do work',
      firedAt: '2026-01-01T00:00:00Z',
    };

    const response = await sendRequest(sockPath, JSON.stringify(request));
    const parsed = JSON.parse(response);
    expect(parsed.ok).toBe(true);
    expect(parsed.dispatchId).toBe('test-dispatch-1');
  });

  it('rejects unknown request type', async () => {
    const sockPath = tmpSocket();
    const handler = async (): Promise<ScheduledDispatchResponse> => {
      return { ok: true, dispatchId: 'x' };
    };

    server = new SchedulerSocketServer(handler, sockPath);
    await server.start();

    const response = await sendRequest(sockPath, JSON.stringify({ type: 'unknown', version: 1 }));
    const parsed = JSON.parse(response);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('internal-error');
  });

  it('rejects unsupported protocol version', async () => {
    const sockPath = tmpSocket();
    const handler = async (): Promise<ScheduledDispatchResponse> => {
      return { ok: true, dispatchId: 'x' };
    };

    server = new SchedulerSocketServer(handler, sockPath);
    await server.start();

    const response = await sendRequest(sockPath, JSON.stringify({
      type: 'scheduled-dispatch',
      version: 99,
      projectDir: '/p',
      scheduleId: 's',
      prompt: 'p',
      firedAt: 'now',
    }));
    const parsed = JSON.parse(response);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('Unsupported protocol version');
  });

  it('rejects invalid JSON', async () => {
    const sockPath = tmpSocket();
    const handler = async (): Promise<ScheduledDispatchResponse> => {
      return { ok: true, dispatchId: 'x' };
    };

    server = new SchedulerSocketServer(handler, sockPath);
    await server.start();

    const response = await sendRequest(sockPath, 'NOT JSON AT ALL');
    const parsed = JSON.parse(response);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('internal-error');
  });

  it('removes stale socket file on start', async () => {
    const sockPath = tmpSocket();
    // Create a stale socket file
    fs.writeFileSync(sockPath, 'stale');

    const handler = async (): Promise<ScheduledDispatchResponse> => {
      return { ok: true, dispatchId: 'x' };
    };

    server = new SchedulerSocketServer(handler, sockPath);
    await server.start();

    // Should be able to connect
    const request: ScheduledDispatchRequest = {
      type: 'scheduled-dispatch',
      version: 1,
      projectDir: '/p',
      scheduleId: 's',
      prompt: 'p',
      firedAt: 'now',
    };
    const response = await sendRequest(sockPath, JSON.stringify(request));
    const parsed = JSON.parse(response);
    expect(parsed.ok).toBe(true);
  });

  it('cleans up socket file on stop', async () => {
    const sockPath = tmpSocket();
    const handler = async (): Promise<ScheduledDispatchResponse> => {
      return { ok: true, dispatchId: 'x' };
    };

    server = new SchedulerSocketServer(handler, sockPath);
    await server.start();
    expect(fs.existsSync(sockPath)).toBe(true);

    await server.stop();
    server = null;
    expect(fs.existsSync(sockPath)).toBe(false);
  });

  it('returns handler rejection reasons', async () => {
    const sockPath = tmpSocket();
    const handler = async (): Promise<ScheduledDispatchResponse> => {
      return { ok: false, reason: 'rate-limited', message: 'Rate limit reached' };
    };

    server = new SchedulerSocketServer(handler, sockPath);
    await server.start();

    const request: ScheduledDispatchRequest = {
      type: 'scheduled-dispatch',
      version: 1,
      projectDir: '/p',
      scheduleId: 's',
      prompt: 'p',
      firedAt: 'now',
    };

    const response = await sendRequest(sockPath, JSON.stringify(request));
    const parsed = JSON.parse(response);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('rate-limited');
  });
});
