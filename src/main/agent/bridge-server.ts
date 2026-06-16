/**
 * Shared, backend-neutral HTTP bridge singleton.
 *
 * Both ClaudeBackend and OpenCodeBackend call acquireBridge() in initialize().
 * The first caller starts the server; subsequent callers reuse it (ref-counted).
 * The last caller to release() shuts it down.
 *
 * The bridge accepts POST /tool-call with an X-Auth-Token header and dispatches
 * to the provided ToolHandler. This lets skill scripts (curl-based) reach the
 * Sandstorm control-plane tools without importing Electron.
 */

import { createServer, Server } from 'http';
import { randomUUID } from 'crypto';

export type ToolHandler = (name: string, input: Record<string, unknown>) => Promise<unknown>;

export interface BridgeHandle {
  /** Full URL of the bridge, e.g. http://127.0.0.1:PORT */
  url: string;
  /** Auth token; pass as X-Auth-Token in requests */
  token: string;
  /** Decrement ref-count; shuts down the bridge when the last holder releases */
  release(): void;
}

// --- Singleton state ---
let _server: Server | null = null;
let _port = 0;
let _token = '';
let _refCount = 0;
let _startPromise: Promise<void> | null = null;
let _handler: ToolHandler | null = null;

/**
 * Acquire a reference to the shared bridge server.
 *
 * @param handler  Tool handler to register (only used by the first caller;
 *                 subsequent callers reuse the already-running bridge).
 * @returns  BridgeHandle with url, token, and a release() teardown callback.
 */
export async function acquireBridge(handler: ToolHandler): Promise<BridgeHandle> {
  _refCount++;
  if (!_startPromise) {
    _handler = handler;
    _startPromise = _startBridge();
  }
  await _startPromise;

  const url = `http://127.0.0.1:${_port}`;
  const token = _token;
  let released = false;

  return {
    url,
    token,
    release() {
      if (released) return;
      released = true;
      _refCount--;
      if (_refCount <= 0) {
        _refCount = 0;
        _server?.close();
        _server = null;
        _port = 0;
        _token = '';
        _startPromise = null;
        _handler = null;
      }
    },
  };
}

function _startBridge(): Promise<void> {
  _token = randomUUID();
  return new Promise<void>((resolve) => {
    _server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/tool-call') {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.headers['x-auth-token'] !== _token) {
        res.writeHead(403);
        res.end();
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { name, input } = JSON.parse(body) as {
            name: string;
            input: Record<string, unknown>;
          };
          const result = await _handler!(name, input);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    });

    _server.listen(0, '127.0.0.1', () => {
      const addr = _server!.address() as { port: number };
      _port = addr.port;
      resolve();
    });
  });
}
