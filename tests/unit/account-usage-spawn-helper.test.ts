/**
 * Tests for the ensureSpawnHelperPermissions() runtime fix.
 *
 * On macOS, npm does not preserve execute permissions on node-pty's
 * prebuilt spawn-helper binary (ships as 644). Without the execute bit,
 * every pty.spawn() call fails with "posix_spawnp failed."
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('ensureSpawnHelperPermissions', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('fixes permissions when spawn-helper is not executable', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const chmodSyncMock = vi.fn();
    vi.doMock('fs', () => ({
      default: {
        existsSync: () => true,
        statSync: () => ({ mode: 0o100644 }),
        chmodSync: chmodSyncMock,
      },
      existsSync: () => true,
      statSync: () => ({ mode: 0o100644 }),
      chmodSync: chmodSyncMock,
    }));

    const mod = await import('../../src/main/control-plane/account-usage');
    mod.ensureSpawnHelperPermissions();

    expect(chmodSyncMock).toHaveBeenCalledTimes(1);
    const calledMode = chmodSyncMock.mock.calls[0][1];
    expect(calledMode & 0o111).not.toBe(0);
  });

  it('skips fix when spawn-helper is already executable', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const chmodSyncMock = vi.fn();
    vi.doMock('fs', () => ({
      default: {
        existsSync: () => true,
        statSync: () => ({ mode: 0o100755 }),
        chmodSync: chmodSyncMock,
      },
      existsSync: () => true,
      statSync: () => ({ mode: 0o100755 }),
      chmodSync: chmodSyncMock,
    }));

    const mod = await import('../../src/main/control-plane/account-usage');
    mod.ensureSpawnHelperPermissions();

    expect(chmodSyncMock).not.toHaveBeenCalled();
  });

  it('skips entirely on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    const existsSyncMock = vi.fn();
    vi.doMock('fs', () => ({
      default: { existsSync: existsSyncMock },
      existsSync: existsSyncMock,
      statSync: vi.fn(),
      chmodSync: vi.fn(),
    }));

    const mod = await import('../../src/main/control-plane/account-usage');
    mod.ensureSpawnHelperPermissions();

    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it('handles missing spawn-helper gracefully', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const chmodSyncMock = vi.fn();
    vi.doMock('fs', () => ({
      default: {
        existsSync: () => false,
        statSync: vi.fn(),
        chmodSync: chmodSyncMock,
      },
      existsSync: () => false,
      statSync: vi.fn(),
      chmodSync: chmodSyncMock,
    }));

    const mod = await import('../../src/main/control-plane/account-usage');
    mod.ensureSpawnHelperPermissions();

    expect(chmodSyncMock).not.toHaveBeenCalled();
  });

  it('handles filesystem errors gracefully without throwing', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    vi.doMock('fs', () => ({
      default: {
        existsSync: () => { throw new Error('permission denied'); },
        statSync: vi.fn(),
        chmodSync: vi.fn(),
      },
      existsSync: () => { throw new Error('permission denied'); },
      statSync: vi.fn(),
      chmodSync: vi.fn(),
    }));

    const mod = await import('../../src/main/control-plane/account-usage');
    expect(() => mod.ensureSpawnHelperPermissions()).not.toThrow();
  });
});
