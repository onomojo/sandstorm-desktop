/**
 * Unix domain socket server for receiving scheduled dispatch requests
 * from the cron wrapper script.
 *
 * Protocol: single newline-terminated JSON request → single newline-terminated
 * JSON response → close. No streaming.
 *
 * Socket path: ~/.sandstorm/orchestrator.sock (0600)
 */

import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import {
  ScheduledDispatchRequest,
  ScheduledDispatchResponse,
} from './types';

const SOCKET_DIR = path.join(os.homedir(), '.sandstorm');
const SOCKET_PATH = path.join(SOCKET_DIR, 'orchestrator.sock');
const MAX_REQUEST_SIZE = 64 * 1024; // 64KB should be more than enough

export type DispatchHandler = (
  request: ScheduledDispatchRequest
) => Promise<ScheduledDispatchResponse>;

export class SchedulerSocketServer extends EventEmitter {
  private server: net.Server | null = null;
  private handler: DispatchHandler;
  private socketPath: string;

  constructor(handler: DispatchHandler, socketPath?: string) {
    super();
    this.handler = handler;
    this.socketPath = socketPath ?? SOCKET_PATH;
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Start listening on the Unix domain socket.
   * Removes stale socket files before binding.
   */
  async start(): Promise<void> {
    // Ensure socket directory exists with proper permissions
    const socketDir = path.dirname(this.socketPath);
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });

    // Remove stale socket if present
    if (fs.existsSync(this.socketPath)) {
      try {
        fs.unlinkSync(this.socketPath);
        console.log('[scheduler] Removed stale socket file');
      } catch (err) {
        console.error('[scheduler] Failed to remove stale socket:', err);
        throw err;
      }
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((conn) => this.handleConnection(conn));

      let settled = false;

      this.server.on('error', (err) => {
        console.error('[scheduler] Socket server error:', err);
        this.emit('error', err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      this.server.listen(this.socketPath, () => {
        settled = true;
        // Set socket permissions to 0600
        try {
          fs.chmodSync(this.socketPath, 0o600);
        } catch (err) {
          console.warn('[scheduler] Failed to set socket permissions:', err);
        }
        console.log(`[scheduler] Socket server listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  /**
   * Stop the socket server and clean up.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.cleanupSocket();
          resolve();
        });
        this.server = null;
      } else {
        this.cleanupSocket();
        resolve();
      }
    });
  }

  private cleanupSocket(): void {
    try {
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }
    } catch {
      // Best-effort cleanup
    }
  }

  private handleConnection(conn: net.Socket): void {
    let buffer = '';
    let handled = false;

    const timeout = setTimeout(() => {
      conn.destroy();
    }, 10000); // 10s timeout

    conn.on('data', (data) => {
      if (handled) return;
      buffer += data.toString();

      if (buffer.length > MAX_REQUEST_SIZE) {
        handled = true;
        clearTimeout(timeout);
        this.sendResponse(conn, {
          ok: false,
          reason: 'internal-error',
          message: 'Request too large',
        });
        return;
      }

      // Look for newline-terminated JSON
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return;

      handled = true;
      const line = buffer.slice(0, newlineIdx);
      clearTimeout(timeout);

      this.processRequest(conn, line).catch((err) => {
        console.error('[scheduler] Request processing error:', err);
        this.sendResponse(conn, {
          ok: false,
          reason: 'internal-error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    });

    conn.on('error', () => {
      clearTimeout(timeout);
    });
  }

  private async processRequest(conn: net.Socket, line: string): Promise<void> {
    let request: ScheduledDispatchRequest;
    try {
      request = JSON.parse(line);
    } catch {
      this.sendResponse(conn, {
        ok: false,
        reason: 'internal-error',
        message: 'Invalid JSON in request',
      });
      return;
    }

    // Validate request shape
    if (request.type !== 'scheduled-dispatch') {
      this.sendResponse(conn, {
        ok: false,
        reason: 'internal-error',
        message: `Unknown request type: ${request.type}`,
      });
      return;
    }

    if (request.version !== 1) {
      this.sendResponse(conn, {
        ok: false,
        reason: 'internal-error',
        message: `Unsupported protocol version: ${request.version}`,
      });
      return;
    }

    if (!request.projectDir || !request.scheduleId || !request.firedAt) {
      this.sendResponse(conn, {
        ok: false,
        reason: 'internal-error',
        message: 'Missing required fields: projectDir, scheduleId, firedAt',
      });
      return;
    }

    // Delegate to handler
    const response = await this.handler(request);
    this.sendResponse(conn, response);
  }

  private sendResponse(conn: net.Socket, response: ScheduledDispatchResponse): void {
    try {
      conn.end(JSON.stringify(response) + '\n');
    } catch {
      // Connection may already be closed
    }
  }
}

/**
 * Get the default socket path.
 */
export function getSocketPath(): string {
  return SOCKET_PATH;
}
