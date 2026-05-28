/**
 * Structured timing log for ephemeral agent spawns.
 *
 * Pure, electron-free module. Writes JSON Lines to a caller-supplied path so
 * tests can target a temp file without any mocking. The production wiring
 * lives in claude-backend.ts.
 *
 * Schema (one line per ephemeral agent close):
 *   {
 *     "ts": ISO-8601,
 *     "spawnedAt": number (ms epoch),
 *     "firstChunkAt": number | null (ms epoch, null if no output before close),
 *     "closedAt": number (ms epoch),
 *     "elapsedMs": number,
 *     "exitCode": number | null,
 *     "promptChars": number,
 *     "turnCount": number (count of type:"assistant" records seen),
 *     "cancelled": boolean,
 *     "errorMessage"?: string (only on startup error)
 *   }
 */

import { appendFileSync } from 'fs';

export interface EphemeralTimingRecord {
  ts: string;
  spawnedAt: number;
  firstChunkAt: number | null;
  closedAt: number;
  elapsedMs: number;
  exitCode: number | null;
  promptChars: number;
  turnCount: number;
  cancelled: boolean;
  errorMessage?: string;
}

export function appendEphemeralTiming(filePath: string, record: EphemeralTimingRecord): void {
  try {
    appendFileSync(filePath, JSON.stringify(record) + '\n');
  } catch {
    // Best effort — swallow write failures
  }
}
