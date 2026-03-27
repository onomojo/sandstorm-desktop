/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import https from 'https';
import { EventEmitter } from 'events';

// Mock fs and https before importing the module
vi.mock('fs');
vi.mock('https');

// Import after mocks are set up
import { fetchAccountUsage, readAccountInfo } from '../../src/main/control-plane/account-usage';

const CREDS_PATH = `${process.env.HOME}/.claude/.credentials.json`;

function mockCredentials(overrides: Record<string, unknown> = {}) {
  const creds = {
    claudeAiOauth: {
      accessToken: 'test-token-123',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600000,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_5x',
      ...overrides,
    },
  };
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(creds));
}

function mockHttpsResponse(statusCode: number, body: unknown) {
  const mockRes = new EventEmitter() as EventEmitter & { statusCode: number };
  mockRes.statusCode = statusCode;

  vi.mocked(https.request).mockImplementation((_opts: unknown, callback: unknown) => {
    const cb = callback as (res: typeof mockRes) => void;
    setTimeout(() => {
      cb(mockRes);
      mockRes.emit('data', Buffer.from(JSON.stringify(body)));
      mockRes.emit('end');
    }, 0);
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.end = vi.fn();
    req.destroy = vi.fn();
    return req as ReturnType<typeof https.request>;
  });
}

function mockHttpsError(errorMessage: string) {
  vi.mocked(https.request).mockImplementation(() => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.end = vi.fn();
    req.destroy = vi.fn();
    setTimeout(() => {
      req.emit('error', new Error(errorMessage));
    }, 0);
    return req as ReturnType<typeof https.request>;
  });
}

describe('account-usage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('readAccountInfo', () => {
    it('returns subscription type and rate limit tier from credentials', () => {
      mockCredentials();
      const info = readAccountInfo();
      expect(info.subscription_type).toBe('max');
      expect(info.rate_limit_tier).toBe('default_claude_max_5x');
    });

    it('returns nulls when credentials file is missing', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const info = readAccountInfo();
      expect(info.subscription_type).toBeNull();
      expect(info.rate_limit_tier).toBeNull();
    });

    it('returns nulls when credentials have no OAuth data', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
      const info = readAccountInfo();
      expect(info.subscription_type).toBeNull();
      expect(info.rate_limit_tier).toBeNull();
    });
  });

  describe('fetchAccountUsage', () => {
    it('returns null when no credentials exist', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const result = await fetchAccountUsage();
      expect(result).toBeNull();
    });

    it('returns null when credentials have no access token', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ claudeAiOauth: { subscriptionType: 'max' } })
      );
      const result = await fetchAccountUsage();
      expect(result).toBeNull();
    });

    it('parses usage from bootstrap API with top-level usage object', async () => {
      mockCredentials();
      mockHttpsResponse(200, {
        usage: {
          tokens_used: 500000,
          tokens_limit: 1000000,
          reset_at: '2026-03-27T20:00:00Z',
        },
      });

      const result = await fetchAccountUsage();
      expect(result).not.toBeNull();
      expect(result!.used_tokens).toBe(500000);
      expect(result!.limit_tokens).toBe(1000000);
      expect(result!.percent).toBe(50);
      expect(result!.subscription_type).toBe('max');
      expect(result!.rate_limit_tier).toBe('default_claude_max_5x');
      expect(result!.reset_at).toBe('2026-03-27T20:00:00.000Z');
    });

    it('parses usage from nested account.usage object', async () => {
      mockCredentials();
      mockHttpsResponse(200, {
        account: {
          usage: {
            used_tokens: 250000,
            limit_tokens: 500000,
          },
        },
      });

      const result = await fetchAccountUsage();
      expect(result).not.toBeNull();
      expect(result!.used_tokens).toBe(250000);
      expect(result!.limit_tokens).toBe(500000);
      expect(result!.percent).toBe(50);
    });

    it('returns credential-only info when API returns no usage data', async () => {
      mockCredentials();
      // Both API calls return non-usage data
      let callCount = 0;
      vi.mocked(https.request).mockImplementation((_opts: unknown, callback: unknown) => {
        callCount++;
        const mockRes = new EventEmitter() as EventEmitter & { statusCode: number };
        mockRes.statusCode = 200;
        const cb = callback as (res: typeof mockRes) => void;
        setTimeout(() => {
          cb(mockRes);
          mockRes.emit('data', Buffer.from(JSON.stringify({ some: 'other_data' })));
          mockRes.emit('end');
        }, 0);
        const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
        req.end = vi.fn();
        req.destroy = vi.fn();
        return req as ReturnType<typeof https.request>;
      });

      const result = await fetchAccountUsage();
      expect(result).not.toBeNull();
      expect(result!.used_tokens).toBe(0);
      expect(result!.limit_tokens).toBe(0);
      expect(result!.subscription_type).toBe('max');
    });

    it('returns credential-only info when API is unreachable', async () => {
      mockCredentials();
      mockHttpsError('ECONNREFUSED');

      const result = await fetchAccountUsage();
      expect(result).not.toBeNull();
      expect(result!.used_tokens).toBe(0);
      expect(result!.limit_tokens).toBe(0);
      expect(result!.subscription_type).toBe('max');
      expect(result!.rate_limit_tier).toBe('default_claude_max_5x');
    });

    it('computes reset_in from reset_at timestamp', async () => {
      mockCredentials();
      // Set reset to 2 hours from now
      const resetAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      mockHttpsResponse(200, {
        usage: {
          tokens_used: 100000,
          tokens_limit: 500000,
          reset_at: resetAt,
        },
      });

      const result = await fetchAccountUsage();
      expect(result).not.toBeNull();
      expect(result!.reset_in).toMatch(/^(1h 5\d|2h)/); // approximately 2h
      expect(result!.reset_at).toBeDefined();
    });

    it('handles percent_used field from API', async () => {
      mockCredentials();
      mockHttpsResponse(200, {
        usage: {
          tokens_used: 300000,
          tokens_limit: 1000000,
          percent_used: 30,
        },
      });

      const result = await fetchAccountUsage();
      expect(result).not.toBeNull();
      expect(result!.percent).toBe(30);
    });
  });
});
