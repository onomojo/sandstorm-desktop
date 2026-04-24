/**
 * Raw Anthropic-API request capture for the outer Claude orchestrator (#299).
 *
 * Pure, electron-free module. Stands up one localhost HTTP proxy per tab so
 * the child `claude` subprocess can be pointed at it via `ANTHROPIC_BASE_URL`.
 * The proxy dumps every outbound request body to disk (headers redacted),
 * then forwards to `https://api.anthropic.com` and pipes the SSE response
 * back unchanged. This gives us ground-truth visibility into what the CLI
 * actually sends — something telemetry alone cannot reveal.
 *
 * Off by default. Opt in with the env var `SANDSTORM_RAW_REQUEST_CAPTURE=1`.
 *
 * Redaction contract:
 *   Authorization, x-api-key, anthropic-api-key, anthropic-auth-token,
 *   proxy-authorization, cookie, set-cookie, and any header whose name
 *   matches /token|secret|key/i are replaced with "[REDACTED len=<n>]"
 *   before writing to disk. The original headers are used in-memory only
 *   to construct the forwarded request.
 */
import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'fs';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import path from 'path';

const REDACT_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'anthropic-api-key',
  'anthropic-auth-token',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);

const REDACT_HEADER_PATTERN = /token|secret|key/i;

function redactHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const mustRedact =
      REDACT_HEADER_NAMES.has(lower) || REDACT_HEADER_PATTERN.test(lower);
    if (!mustRedact) {
      out[name] = value;
      continue;
    }
    const raw = Array.isArray(value) ? value.join(',') : value ?? '';
    out[name] = `[REDACTED len=${raw.length}]`;
  }
  return out;
}

function safeFileSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown';
}

function pad(n: number, width = 4): string {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

export interface RawCaptureSession {
  /** URL the child should use as ANTHROPIC_BASE_URL. Empty when disabled. */
  readonly baseUrl: string;
  /** Called when a user-message turn completes (outer `type:"result"`). */
  markTurnComplete(): void;
  /** Release the listener and stop accepting requests. */
  close(): Promise<void>;
}

export interface RawCaptureSupervisor {
  /**
   * True when capture is armed. Callers can use this to skip the entire
   * async registerTab path and keep their code synchronous when capture
   * is off (the common production case).
   */
  readonly enabled: boolean;
  registerTab(tabId: string): Promise<RawCaptureSession>;
  closeAll(): Promise<void>;
}

export interface RawCaptureOptions {
  /** Absolute path to the session root directory. Will be created lazily. */
  rootDir: string;
  /** When false, `registerTab` returns a no-op stub (zero overhead). */
  enabled: boolean;
  /** Upstream host to forward to. Overridable for tests. */
  upstreamHost?: string;
  /** Upstream port. Overridable for tests (e.g. a local echo http server). */
  upstreamPort?: number;
  /** Upstream protocol. 'https' (default, prod) or 'http' (tests only). */
  upstreamProtocol?: 'http' | 'https';
}

/**
 * Reads the opt-in flag. Default off — the flag must be explicitly set to
 * `1`. Any other value (including `true`, `yes`) is ignored, matching the
 * contract used by `SANDSTORM_TOKEN_TELEMETRY`.
 */
export function isRawCaptureEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.SANDSTORM_RAW_REQUEST_CAPTURE === '1';
}

const DISABLED_SESSION: RawCaptureSession = {
  baseUrl: '',
  markTurnComplete: () => { /* no-op */ },
  close: async () => { /* no-op */ },
};

const DISABLED_SUPERVISOR: RawCaptureSupervisor = {
  enabled: false,
  registerTab: async () => DISABLED_SESSION,
  closeAll: async () => { /* no-op */ },
};

/**
 * Build a supervisor. When `enabled` is false, returns a stub that never
 * touches the filesystem or network — the capture path vanishes entirely
 * so production runs pay no cost.
 */
export function createRawCaptureSupervisor(
  opts: RawCaptureOptions
): RawCaptureSupervisor {
  if (!opts.enabled) return DISABLED_SUPERVISOR;

  const upstreamHost = opts.upstreamHost ?? 'api.anthropic.com';
  const upstreamPort = opts.upstreamPort ?? 443;
  const upstreamProtocol = opts.upstreamProtocol ?? 'https';
  const rootDir = opts.rootDir;
  const indexPath = path.join(rootDir, 'index.jsonl');
  const sessions = new Set<{ close: () => Promise<void> }>();

  const ensureRootDir = (): void => {
    if (!existsSync(rootDir)) mkdirSync(rootDir, { recursive: true });
  };

  function forward(
    req: IncomingMessage,
    body: Buffer,
    res: ServerResponse
  ): void {
    if (upstreamProtocol === 'https') {
      const upstream = httpsRequest(
        {
          host: upstreamHost,
          port: upstreamPort,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: upstreamHost },
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        }
      );
      upstream.on('error', (err) => {
        try {
          res.writeHead(502);
          res.end(String(err.message || err));
        } catch {
          /* connection already torn down */
        }
      });
      upstream.write(body);
      upstream.end();
      return;
    }
    // Plain http upstream — only for tests. Use dynamic require to avoid
    // paying the import cost in production.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const httpRequest = require('http').request;
    const upstream = httpRequest(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: upstreamHost },
      },
      (upstreamRes: IncomingMessage) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on('error', (err: Error) => {
      try {
        res.writeHead(502);
        res.end(String(err.message || err));
      } catch {
        /* connection already torn down */
      }
    });
    upstream.write(body);
    upstream.end();
  }

  async function registerTab(tabId: string): Promise<RawCaptureSession> {
    ensureRootDir();
    const tabSafe = safeFileSegment(tabId);
    let seq = 0;
    let turnIndex = 0;
    let subTurnSeq = 0;

    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        seq += 1;
        const thisSeq = seq;
        const thisSubTurn = subTurnSeq;
        subTurnSeq += 1;

        const redacted = redactHeaders(req.headers as Record<string, string | string[] | undefined>);
        const ts = new Date().toISOString();

        let parsedBody: unknown;
        try {
          parsedBody = body.length > 0 ? JSON.parse(body.toString('utf-8')) : null;
        } catch {
          parsedBody = body.toString('utf-8');
        }

        const entry = {
          seq: thisSeq,
          ts,
          tabId,
          turnIndex,
          subTurnSeq: thisSubTurn,
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          headers: redacted,
          bodyBytes: body.length,
          body: parsedBody,
        };

        const fileName = `${pad(thisSeq)}-${tabSafe}-turn${turnIndex}-sub${thisSubTurn}-req.json`;
        const filePath = path.join(rootDir, fileName);

        try {
          writeFileSync(filePath, JSON.stringify(entry, null, 2));
          const indexLine = JSON.stringify({
            seq: thisSeq,
            ts,
            tabId,
            turnIndex,
            subTurnSeq: thisSubTurn,
            method: entry.method,
            path: entry.path,
            bodyBytes: body.length,
            file: fileName,
          }) + '\n';
          appendFileSync(indexPath, indexLine);
        } catch {
          // Best-effort: never let disk failures break the orchestrator
        }

        forward(req, body, res);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    const port =
      address && typeof address === 'object' && 'port' in address
        ? (address as { port: number }).port
        : 0;
    if (!port) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error('raw-request-capture: failed to obtain ephemeral port');
    }

    const handle = {
      close: async (): Promise<void> => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
    sessions.add(handle);

    const session: RawCaptureSession = {
      baseUrl: `http://127.0.0.1:${port}`,
      markTurnComplete(): void {
        turnIndex += 1;
        subTurnSeq = 0;
      },
      async close(): Promise<void> {
        sessions.delete(handle);
        await handle.close();
      },
    };

    return session;
  }

  async function closeAll(): Promise<void> {
    const all = Array.from(sessions);
    sessions.clear();
    await Promise.all(all.map((h) => h.close().catch(() => { /* ignore */ })));
  }

  return { enabled: true, registerTab, closeAll };
}
