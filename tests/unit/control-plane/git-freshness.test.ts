import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing the module under test
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import { ensureFreshAgainstMain } from '../../../src/main/control-plane/git-freshness';

const mockExecFile = vi.mocked(execFile);

const PROJECT_DIR = '/some/project';

/**
 * Helper to set up execFile mock to resolve/reject for a sequence of git commands.
 * Each call provides either { stdout } for success or an Error for failure.
 */
function mockGitSequence(
  responses: Array<{ stdout: string } | Error>,
): void {
  let callIndex = 0;
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, callback: unknown) => {
      const cb = callback as (err: Error | null, stdout?: string, stderr?: string) => void;
      const response = responses[callIndex++];
      if (response instanceof Error) {
        // Attach stdout so the catch block in git() can read it
        const err = Object.assign(response, { code: 1, stdout: '' });
        cb(err);
      } else {
        // Standard promisify resolves with the 2nd callback arg.
        // vi.fn() doesn't carry the [util.promisify.custom] symbol that real execFile
        // has, so we pass { stdout } directly as the resolved value.
        cb(null, { stdout: response.stdout } as unknown as string, '');
      }
      return {} as ReturnType<typeof execFile>;
    },
  );
}

describe('ensureFreshAgainstMain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('up-to-date (HEAD == origin/main): no mutation, no warning', async () => {
    const SHA = 'abc1234def5678901234567890abcdef12345678';
    mockGitSequence([
      { stdout: '' },           // git fetch origin
      { stdout: 'main' },       // git rev-parse --abbrev-ref HEAD
      { stdout: SHA },          // git rev-parse HEAD
      { stdout: SHA },          // git rev-parse origin/main
    ]);

    const result = await ensureFreshAgainstMain(PROJECT_DIR);

    expect(result.mutated).toBe(false);
    expect(result.warning).toBeUndefined();
    // merge --ff-only should NOT have been called
    const calls = mockExecFile.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((c) => c.includes('merge'))).toBe(false);
  });

  it('behind + clean + on main: fast-forwards and returns mutated:true', async () => {
    const HEAD_SHA = 'aaa0000000000000000000000000000000000001';
    const ORIGIN_SHA = 'bbb0000000000000000000000000000000000002';
    mockGitSequence([
      { stdout: '' },           // git fetch origin
      { stdout: 'main' },       // git rev-parse --abbrev-ref HEAD
      { stdout: HEAD_SHA },     // git rev-parse HEAD
      { stdout: ORIGIN_SHA },   // git rev-parse origin/main
      { stdout: '' },           // git merge-base --is-ancestor HEAD origin/main (exit 0 = is ancestor)
      { stdout: '' },           // git status --porcelain (empty = clean)
      { stdout: '' },           // git merge --ff-only origin/main
    ]);

    const result = await ensureFreshAgainstMain(PROJECT_DIR);

    expect(result.mutated).toBe(true);
    expect(result.warning).toBeUndefined();

    const calls = mockExecFile.mock.calls.map((c) => (c[1] as string[]).join(' '));
    const ffCall = calls.find((c) => c.includes('--ff-only'));
    expect(ffCall).toBeDefined();
    expect(ffCall).toContain('origin/main');
    // merge --ff-only should have been called exactly once
    expect(calls.filter((c) => c.includes('--ff-only')).length).toBe(1);
  });

  it('dirty tree on main, behind origin/main: no merge, warning present', async () => {
    const HEAD_SHA = 'aaa0000000000000000000000000000000000001';
    const ORIGIN_SHA = 'bbb0000000000000000000000000000000000002';
    mockGitSequence([
      { stdout: '' },            // git fetch origin
      { stdout: 'main' },        // git rev-parse --abbrev-ref HEAD
      { stdout: HEAD_SHA },      // git rev-parse HEAD
      { stdout: ORIGIN_SHA },    // git rev-parse origin/main
      { stdout: '' },            // git merge-base --is-ancestor (exit 0)
      { stdout: 'M  src/foo.ts' }, // git status --porcelain (dirty)
    ]);

    const result = await ensureFreshAgainstMain(PROJECT_DIR);

    expect(result.mutated).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('Staleness warning');

    const calls = mockExecFile.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((c) => c.includes('--ff-only'))).toBe(false);
  });

  it('feature branch, behind origin/main: no merge, warning present', async () => {
    const HEAD_SHA = 'aaa0000000000000000000000000000000000001';
    const ORIGIN_SHA = 'bbb0000000000000000000000000000000000002';
    mockGitSequence([
      { stdout: '' },            // git fetch origin
      { stdout: 'feat/my-branch' }, // git rev-parse --abbrev-ref HEAD
      { stdout: HEAD_SHA },      // git rev-parse HEAD
      { stdout: ORIGIN_SHA },    // git rev-parse origin/main
      { stdout: '' },            // git merge-base --is-ancestor (exit 0 — ancestor but not on main)
    ]);

    const result = await ensureFreshAgainstMain(PROJECT_DIR);

    expect(result.mutated).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('Staleness warning');
    expect(result.warning).toContain('feat/my-branch');

    const calls = mockExecFile.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((c) => c.includes('--ff-only'))).toBe(false);
  });

  it('detached HEAD: no merge, warning present', async () => {
    const HEAD_SHA = 'aaa0000000000000000000000000000000000001';
    const ORIGIN_SHA = 'bbb0000000000000000000000000000000000002';
    mockGitSequence([
      { stdout: '' },            // git fetch origin
      { stdout: 'HEAD' },        // git rev-parse --abbrev-ref HEAD (detached)
      { stdout: HEAD_SHA },      // git rev-parse HEAD
      { stdout: ORIGIN_SHA },    // git rev-parse origin/main
      { stdout: '' },            // git merge-base --is-ancestor (exit 0)
    ]);

    const result = await ensureFreshAgainstMain(PROJECT_DIR);

    expect(result.mutated).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('Staleness warning');
    expect(result.warning).toContain('detached');

    const calls = mockExecFile.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((c) => c.includes('--ff-only'))).toBe(false);
  });

  it('git fetch fails (offline): no merge, offline note present, does not throw', async () => {
    mockGitSequence([
      new Error('network unreachable'), // git fetch origin fails
    ]);

    const result = await ensureFreshAgainstMain(PROJECT_DIR);

    expect(result.mutated).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('fetch failed/offline');

    const calls = mockExecFile.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((c) => c.includes('merge'))).toBe(false);
  });

  it('diverged HEAD (not ancestor of origin/main): no merge, warning present', async () => {
    const HEAD_SHA = 'aaa0000000000000000000000000000000000001';
    const ORIGIN_SHA = 'bbb0000000000000000000000000000000000002';
    mockGitSequence([
      { stdout: '' },            // git fetch origin
      { stdout: 'main' },        // git rev-parse --abbrev-ref HEAD
      { stdout: HEAD_SHA },      // git rev-parse HEAD
      { stdout: ORIGIN_SHA },    // git rev-parse origin/main
      new Error('not ancestor'), // git merge-base --is-ancestor (exit 1 = not ancestor)
    ]);

    const result = await ensureFreshAgainstMain(PROJECT_DIR);

    expect(result.mutated).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('Staleness warning');

    const calls = mockExecFile.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((c) => c.includes('--ff-only'))).toBe(false);
  });

  it('idempotent: second run after fast-forward finds HEAD == origin/main and is a no-op', async () => {
    const SHA = 'abc1234def5678901234567890abcdef12345678';
    // Second run: HEAD and origin/main are identical
    mockGitSequence([
      { stdout: '' },    // git fetch origin
      { stdout: 'main' }, // git rev-parse --abbrev-ref HEAD
      { stdout: SHA },   // git rev-parse HEAD
      { stdout: SHA },   // git rev-parse origin/main
    ]);

    const result = await ensureFreshAgainstMain(PROJECT_DIR);

    expect(result.mutated).toBe(false);
    expect(result.warning).toBeUndefined();
    const calls = mockExecFile.mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((c) => c.includes('merge'))).toBe(false);
  });
});
