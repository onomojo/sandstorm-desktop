/**
 * Disk persistence for in-flight refinement sessions.
 * Survives app restarts — on load, any 'running' sessions are marked
 * 'interrupted' so the renderer can surface a retry affordance.
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { SpecGateResult } from './ticket-spec';

export type RefinementStatus = 'running' | 'ready' | 'errored' | 'interrupted';
export type RefinementPhase = 'check' | 'refine';

export interface RefinementSession {
  id: string;
  ticketId: string;
  projectDir: string;
  status: RefinementStatus;
  phase: RefinementPhase;
  result?: SpecGateResult;
  error?: string;
  startedAt: number;
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'refinements.json');
}

function readAll(): RefinementSession[] {
  try {
    const raw = fs.readFileSync(storePath(), 'utf-8');
    return JSON.parse(raw) as RefinementSession[];
  } catch {
    return [];
  }
}

function writeAll(sessions: RefinementSession[]): void {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(sessions, null, 2), 'utf-8');
  } catch {
    // non-fatal
  }
}

/** Load persisted sessions, converting any 'running' entries to 'interrupted'. */
export function loadRefinements(): RefinementSession[] {
  return readAll().map((s) =>
    s.status === 'running' ? { ...s, status: 'interrupted' as RefinementStatus } : s
  );
}

/** Upsert a session record on disk. */
export function persistRefinement(session: RefinementSession): void {
  const all = readAll();
  const idx = all.findIndex((s) => s.id === session.id);
  if (idx >= 0) all[idx] = session;
  else all.push(session);
  writeAll(all);
}

/** Remove a session record from disk. */
export function deleteRefinement(id: string): void {
  writeAll(readAll().filter((s) => s.id !== id));
}

const LIVE_REFINEMENT_COLUMNS = new Set(['refining', 'spec_ready']);

/**
 * Pure helper: partition sessions into those that should be kept vs pruned.
 * A session is kept only when its ticket's board column is 'refining' or 'spec_ready'.
 * Sessions whose ticket row is absent (getColumn returns null) are pruned.
 */
export function filterSessionsByBoardState(
  sessions: RefinementSession[],
  getColumn: (ticketId: string, projectDir: string) => string | null,
): { keep: RefinementSession[]; prune: RefinementSession[] } {
  const keep: RefinementSession[] = [];
  const prune: RefinementSession[] = [];
  for (const session of sessions) {
    const col = getColumn(session.ticketId, session.projectDir);
    if (col !== null && LIVE_REFINEMENT_COLUMNS.has(col)) {
      keep.push(session);
    } else {
      prune.push(session);
    }
  }
  return { keep, prune };
}
