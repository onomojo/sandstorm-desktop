/**
 * Unit tests for cron-health.ts — cron daemon health check.
 * Mocks execSync and os.platform() to cover Linux (systemctl, pgrep) and macOS (pgrep) paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We'll use dynamic imports after mocking
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('os', () => ({
  default: { platform: vi.fn() },
  platform: vi.fn(),
}));

import { execSync } from 'child_process';
import os from 'os';

const mockedExecSync = vi.mocked(execSync);
const mockedPlatform = vi.mocked(os.platform);

// Import after mocks are set up
let isCronRunning: () => boolean;

beforeEach(async () => {
  vi.resetModules();
  // Re-mock after resetModules
  vi.doMock('child_process', () => ({ execSync: mockedExecSync }));
  vi.doMock('os', () => ({ default: { platform: mockedPlatform }, platform: mockedPlatform }));
  const mod = await import('../../src/main/scheduler/cron-health');
  isCronRunning = mod.isCronRunning;
  mockedExecSync.mockReset();
  mockedPlatform.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isCronRunning', () => {
  describe('Linux', () => {
    beforeEach(() => {
      mockedPlatform.mockReturnValue('linux');
    });

    it('returns true when systemctl reports cron is active', () => {
      mockedExecSync.mockReturnValueOnce('active\n');
      expect(isCronRunning()).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith(
        'systemctl is-active cron 2>/dev/null',
        expect.objectContaining({ encoding: 'utf-8', timeout: 5000 })
      );
    });

    it('returns true when systemctl reports crond is active', () => {
      // First call (cron) throws
      mockedExecSync.mockImplementationOnce(() => { throw new Error('not found'); });
      // Second call (crond) returns active
      mockedExecSync.mockReturnValueOnce('active\n');
      expect(isCronRunning()).toBe(true);
    });

    it('falls back to pgrep when systemctl fails', () => {
      // Both systemctl calls throw
      mockedExecSync.mockImplementationOnce(() => { throw new Error('not found'); });
      mockedExecSync.mockImplementationOnce(() => { throw new Error('not found'); });
      // pgrep -x cron succeeds
      mockedExecSync.mockReturnValueOnce('12345\n');
      expect(isCronRunning()).toBe(true);
    });

    it('tries pgrep -x crond if pgrep -x cron fails', () => {
      // systemctl cron fails
      mockedExecSync.mockImplementationOnce(() => { throw new Error('not found'); });
      // systemctl crond fails
      mockedExecSync.mockImplementationOnce(() => { throw new Error('not found'); });
      // pgrep -x cron fails
      mockedExecSync.mockImplementationOnce(() => { throw new Error('no match'); });
      // pgrep -x crond succeeds
      mockedExecSync.mockReturnValueOnce('12345\n');
      expect(isCronRunning()).toBe(true);
    });

    it('returns false when all checks fail', () => {
      mockedExecSync.mockImplementation(() => { throw new Error('not found'); });
      expect(isCronRunning()).toBe(false);
    });
  });

  describe('macOS', () => {
    beforeEach(() => {
      mockedPlatform.mockReturnValue('darwin');
    });

    it('returns true when pgrep finds cron', () => {
      mockedExecSync.mockReturnValueOnce('12345\n');
      expect(isCronRunning()).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith(
        'pgrep -x cron 2>/dev/null',
        expect.objectContaining({ encoding: 'utf-8', timeout: 5000 })
      );
    });

    it('tries pgrep -x crond if cron not found', () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error('no match'); });
      mockedExecSync.mockReturnValueOnce('12345\n');
      expect(isCronRunning()).toBe(true);
    });

    it('returns false when cron not running', () => {
      mockedExecSync.mockImplementation(() => { throw new Error('no match'); });
      expect(isCronRunning()).toBe(false);
    });
  });

  describe('unsupported platform', () => {
    it('returns false for Windows', () => {
      mockedPlatform.mockReturnValue('win32');
      expect(isCronRunning()).toBe(false);
      expect(mockedExecSync).not.toHaveBeenCalled();
    });
  });
});
