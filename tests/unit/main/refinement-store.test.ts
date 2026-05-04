import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Use vi.hoisted so tmpDir is available at mock factory time
const { tmpDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _os = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _path = require('path') as typeof import('path');
  return {
    tmpDir: _fs.mkdtempSync(_path.join(_os.tmpdir(), 'refinement-store-test-')),
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue(tmpDir),
  },
}));

import {
  loadRefinements,
  persistRefinement,
  deleteRefinement,
  type RefinementSession,
} from '../../../src/main/control-plane/refinement-store';

function makeSession(overrides: Partial<RefinementSession> = {}): RefinementSession {
  return {
    id: 'test-id-1',
    ticketId: '123',
    projectDir: '/proj',
    status: 'running',
    phase: 'check',
    startedAt: Date.now(),
    ...overrides,
  };
}

const storePath = path.join(tmpDir, 'refinements.json');

describe('refinement-store', () => {
  beforeEach(() => {
    try { fs.unlinkSync(storePath); } catch { /* file may not exist */ }
  });

  afterEach(() => {
    try { fs.unlinkSync(storePath); } catch { /* ignore */ }
  });

  it('returns empty array when no store file exists', () => {
    expect(loadRefinements()).toEqual([]);
  });

  it('persists and loads a session', () => {
    const session = makeSession({ status: 'ready' });
    persistRefinement(session);

    const loaded = loadRefinements();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('test-id-1');
    expect(loaded[0].status).toBe('ready');
  });

  it('converts running status to interrupted on load', () => {
    const session = makeSession({ status: 'running' });
    // Write directly to disk to simulate an unclean shutdown
    fs.writeFileSync(storePath, JSON.stringify([session]));

    const loaded = loadRefinements();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].status).toBe('interrupted');
  });

  it('upserts an existing session', () => {
    const session = makeSession({ status: 'running' });
    persistRefinement(session);

    const updated = { ...session, status: 'ready' as const };
    persistRefinement(updated);

    const loaded = loadRefinements();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].status).toBe('ready');
  });

  it('adds a new session without removing existing ones', () => {
    persistRefinement(makeSession({ id: 'id-1' }));
    persistRefinement(makeSession({ id: 'id-2', ticketId: '456' }));

    const loaded = loadRefinements();
    expect(loaded).toHaveLength(2);
    expect(loaded.map((s) => s.id).sort()).toEqual(['id-1', 'id-2']);
  });

  it('deletes a session by id', () => {
    persistRefinement(makeSession({ id: 'id-1' }));
    persistRefinement(makeSession({ id: 'id-2', ticketId: '456' }));
    deleteRefinement('id-1');

    const loaded = loadRefinements();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('id-2');
  });

  it('deleteRefinement is a no-op for unknown id', () => {
    persistRefinement(makeSession({ id: 'id-1' }));
    deleteRefinement('no-such-id');
    expect(loadRefinements()).toHaveLength(1);
  });

  it('handles corrupted store file gracefully', () => {
    fs.writeFileSync(storePath, 'not valid json{{');
    expect(loadRefinements()).toEqual([]);
  });
});
