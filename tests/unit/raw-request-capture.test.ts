import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { request as httpRequest } from 'http';
import {
  createRawCaptureSupervisor,
  isRawCaptureEnabled,
} from '../../src/main/agent/raw-request-capture';

/**
 * Pure-function tests for #299 raw API-request capture. No mocking — the
 * module is electron-free, tests target a real temp directory and a real
 * local echo server in place of api.anthropic.com.
 */

interface CapturedUpstream {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function startEchoServer(): Promise<{
  server: Server;
  port: number;
  captured: CapturedUpstream[];
}> {
  return new Promise((resolve) => {
    const captured: CapturedUpstream[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        captured.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: { ...req.headers },
          body: Buffer.concat(chunks).toString('utf-8'),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, seen: captured.length }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port, captured });
    });
  });
}

function postJson(
  baseUrl: string,
  bodyObj: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL('/v1/messages', baseUrl);
    const body = Buffer.from(JSON.stringify(bodyObj), 'utf-8');
    const req = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        method: 'POST',
        path: url.pathname,
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.length),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function readIndex(rootDir: string): Record<string, unknown>[] {
  const p = path.join(rootDir, 'index.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('raw-request-capture (#299)', () => {
  let tmpDir: string;
  let rootDir: string;
  let echo: { server: Server; port: number; captured: CapturedUpstream[] };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-raw-capture-'));
    rootDir = path.join(tmpDir, 'session');
    echo = await startEchoServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => echo.server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('disabled supervisor returns a stub with empty baseUrl and writes nothing', async () => {
    const sup = createRawCaptureSupervisor({ rootDir, enabled: false });
    const session = await sup.registerTab('tab-x');
    expect(session.baseUrl).toBe('');
    session.markTurnComplete();
    await session.close();
    await sup.closeAll();
    expect(fs.existsSync(rootDir)).toBe(false);
  });

  it('enabled supervisor forwards requests to upstream and dumps them to disk', async () => {
    const sup = createRawCaptureSupervisor({
      rootDir,
      enabled: true,
      upstreamHost: '127.0.0.1',
      upstreamPort: echo.port,
      upstreamProtocol: 'http',
    });
    const session = await sup.registerTab('tab-1');
    expect(session.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const payload = { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }] };
    const res = await postJson(session.baseUrl, payload);
    expect(res.status).toBe(200);

    expect(echo.captured).toHaveLength(1);
    expect(echo.captured[0].method).toBe('POST');
    expect(echo.captured[0].url).toBe('/v1/messages');
    expect(JSON.parse(echo.captured[0].body)).toEqual(payload);

    const index = readIndex(rootDir);
    expect(index).toHaveLength(1);
    expect(index[0].method).toBe('POST');
    expect(index[0].path).toBe('/v1/messages');
    expect(index[0].tabId).toBe('tab-1');
    expect(index[0].turnIndex).toBe(0);
    expect(index[0].subTurnSeq).toBe(0);

    const dumpFile = path.join(rootDir, index[0].file as string);
    const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf-8')) as Record<string, unknown>;
    expect(dump.tabId).toBe('tab-1');
    expect(dump.body).toEqual(payload);
    expect(dump.bodyBytes).toBe(JSON.stringify(payload).length);

    await session.close();
    await sup.closeAll();
  });

  it('redacts Authorization/x-api-key headers in dumps (zero secret leakage)', async () => {
    const sup = createRawCaptureSupervisor({
      rootDir,
      enabled: true,
      upstreamHost: '127.0.0.1',
      upstreamPort: echo.port,
      upstreamProtocol: 'http',
    });
    const session = await sup.registerTab('tab-r');
    const secret = 'sk-ant-super-secret-value-12345';
    await postJson(
      session.baseUrl,
      { model: 'x', messages: [] },
      {
        Authorization: `Bearer ${secret}`,
        'x-api-key': secret,
        'anthropic-api-key': secret,
        'Set-Cookie': 'session=xyz',
        'x-stainless-arch': 'x64',
      }
    );

    const index = readIndex(rootDir);
    const dumpFile = path.join(rootDir, index[0].file as string);
    const rawDump = fs.readFileSync(dumpFile, 'utf-8');

    expect(rawDump).not.toContain('sk-ant-super-secret');
    expect(rawDump).not.toContain(`Bearer ${secret}`);
    expect(rawDump).toMatch(/\[REDACTED len=\d+\]/);

    const dump = JSON.parse(rawDump) as Record<string, unknown>;
    const headers = dump.headers as Record<string, unknown>;
    const hdr = (name: string): unknown =>
      headers[name] ?? headers[name.toLowerCase()];
    expect(String(hdr('authorization'))).toMatch(/^\[REDACTED len=/);
    expect(String(hdr('x-api-key'))).toMatch(/^\[REDACTED len=/);
    expect(String(hdr('anthropic-api-key'))).toMatch(/^\[REDACTED len=/);
    expect(String(hdr('set-cookie'))).toMatch(/^\[REDACTED len=/);
    // Non-sensitive headers pass through
    expect(String(hdr('x-stainless-arch'))).toBe('x64');

    // The forwarded request to upstream MUST still carry the un-redacted
    // headers — otherwise upstream rejects auth.
    const forwarded = echo.captured[0].headers;
    expect(String(forwarded['authorization'])).toBe(`Bearer ${secret}`);

    await session.close();
    await sup.closeAll();
  });

  it('markTurnComplete increments turn index for subsequent dumps', async () => {
    const sup = createRawCaptureSupervisor({
      rootDir,
      enabled: true,
      upstreamHost: '127.0.0.1',
      upstreamPort: echo.port,
      upstreamProtocol: 'http',
    });
    const session = await sup.registerTab('tab-t');

    await postJson(session.baseUrl, { n: 0 });
    await postJson(session.baseUrl, { n: 1 }); // same turn, next sub-turn
    session.markTurnComplete();
    await postJson(session.baseUrl, { n: 2 });

    const index = readIndex(rootDir);
    expect(index).toHaveLength(3);
    expect(index[0].turnIndex).toBe(0);
    expect(index[0].subTurnSeq).toBe(0);
    expect(index[1].turnIndex).toBe(0);
    expect(index[1].subTurnSeq).toBe(1);
    expect(index[2].turnIndex).toBe(1);
    expect(index[2].subTurnSeq).toBe(0);

    await session.close();
    await sup.closeAll();
  });

  it('close() releases the ephemeral port', async () => {
    const sup = createRawCaptureSupervisor({
      rootDir,
      enabled: true,
      upstreamHost: '127.0.0.1',
      upstreamPort: echo.port,
      upstreamProtocol: 'http',
    });
    const session = await sup.registerTab('tab-c');
    const port = Number(new URL(session.baseUrl).port);
    expect(port).toBeGreaterThan(0);

    await session.close();

    // The port should be free now; a new server can bind to it (race-free
    // because we wait for the close() promise before asserting).
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => {
        probe.close(() => resolve());
      });
    });

    await sup.closeAll();
  });

  it('safely handles non-JSON bodies (stores them as a raw string)', async () => {
    const sup = createRawCaptureSupervisor({
      rootDir,
      enabled: true,
      upstreamHost: '127.0.0.1',
      upstreamPort: echo.port,
      upstreamProtocol: 'http',
    });
    const session = await sup.registerTab('tab-n');

    await new Promise<void>((resolve, reject) => {
      const url = new URL('/v1/anything', session.baseUrl);
      const body = Buffer.from('not a json payload', 'utf-8');
      const req = httpRequest(
        {
          host: url.hostname,
          port: Number(url.port),
          method: 'POST',
          path: url.pathname,
          headers: { 'content-length': String(body.length) },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const index = readIndex(rootDir);
    expect(index).toHaveLength(1);
    const dumpFile = path.join(rootDir, index[0].file as string);
    const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf-8')) as Record<string, unknown>;
    expect(dump.body).toBe('not a json payload');

    await session.close();
    await sup.closeAll();
  });

  it('closeAll shuts every registered tab down', async () => {
    const sup = createRawCaptureSupervisor({
      rootDir,
      enabled: true,
      upstreamHost: '127.0.0.1',
      upstreamPort: echo.port,
      upstreamProtocol: 'http',
    });
    const s1 = await sup.registerTab('a');
    const s2 = await sup.registerTab('b');
    expect(s1.baseUrl).not.toBe(s2.baseUrl);

    await sup.closeAll();

    // Subsequent requests should fail (ECONNREFUSED) since ports are closed.
    await expect(postJson(s1.baseUrl, {})).rejects.toBeTruthy();
    await expect(postJson(s2.baseUrl, {})).rejects.toBeTruthy();
  });
});

describe('isRawCaptureEnabled (#299)', () => {
  it('returns true when the env var is exactly "1"', () => {
    expect(isRawCaptureEnabled({ SANDSTORM_RAW_REQUEST_CAPTURE: '1' })).toBe(true);
  });

  it('returns false when the env var is unset', () => {
    expect(isRawCaptureEnabled({})).toBe(false);
  });

  it('returns false for truthy-looking but non-"1" values', () => {
    expect(isRawCaptureEnabled({ SANDSTORM_RAW_REQUEST_CAPTURE: 'true' })).toBe(false);
    expect(isRawCaptureEnabled({ SANDSTORM_RAW_REQUEST_CAPTURE: 'yes' })).toBe(false);
    expect(isRawCaptureEnabled({ SANDSTORM_RAW_REQUEST_CAPTURE: 'on' })).toBe(false);
    expect(isRawCaptureEnabled({ SANDSTORM_RAW_REQUEST_CAPTURE: '0' })).toBe(false);
    expect(isRawCaptureEnabled({ SANDSTORM_RAW_REQUEST_CAPTURE: '' })).toBe(false);
  });
});
