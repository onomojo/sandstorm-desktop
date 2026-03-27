/**
 * Fetches Claude Code account-level usage (rate limit progress) from the
 * claude.ai API using the local OAuth credentials.
 *
 * The data mirrors what the Claude Code CLI shows via `/usage`:
 *   - current token usage within the rate-limit window
 *   - the token limit for the window
 *   - when the window resets
 */

import fs from 'fs';
import path from 'path';
import https from 'https';

export interface AccountUsage {
  /** Tokens consumed in the current rate-limit window */
  used_tokens: number;
  /** Token limit for the current window (0 = unknown) */
  limit_tokens: number;
  /** Percentage of limit consumed (0–100) */
  percent: number;
  /** ISO timestamp when the rate-limit window resets, or null if unknown */
  reset_at: string | null;
  /** Human-readable time until reset, e.g. "2h 43m" */
  reset_in: string | null;
  /** Subscription type from credentials (e.g. "max", "pro") */
  subscription_type: string | null;
  /** Rate limit tier from credentials */
  rate_limit_tier: string | null;
}

interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}

function readCredentials(): OAuthCredentials | null {
  try {
    const credsPath = path.join(process.env.HOME || '', '.claude', '.credentials.json');
    const raw = fs.readFileSync(credsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

/**
 * Make an HTTPS GET request and return the parsed JSON response.
 */
function httpsGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          ...headers,
          'Accept': 'application/json',
          'User-Agent': 'Sandstorm-Desktop/1.0',
        },
        timeout: 10_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

/**
 * Format a duration in milliseconds as a human-readable string like "2h 43m" or "15m".
 */
function formatResetIn(ms: number): string {
  if (ms <= 0) return 'now';
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

/**
 * Attempt to fetch account usage from the claude.ai API.
 * Returns null if the API is unreachable or credentials are missing.
 */
export async function fetchAccountUsage(): Promise<AccountUsage | null> {
  const creds = readCredentials();
  if (!creds?.accessToken) return null;

  const baseInfo: Pick<AccountUsage, 'subscription_type' | 'rate_limit_tier'> = {
    subscription_type: creds.subscriptionType ?? null,
    rate_limit_tier: creds.rateLimitTier ?? null,
  };

  try {
    // Try the Claude API bootstrap endpoint which returns account info
    const result = await httpsGet('https://api.claude.ai/api/bootstrap', {
      'Authorization': `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
    });

    if (result.status === 200 && result.body && typeof result.body === 'object') {
      const body = result.body as Record<string, unknown>;

      // Try to extract usage data from various possible response shapes
      const usage = extractUsageFromBootstrap(body);
      if (usage) {
        return {
          ...usage,
          ...baseInfo,
        };
      }
    }
  } catch {
    // API unreachable — fall through to fallback
  }

  // Try the dedicated usage endpoint
  try {
    const result = await httpsGet('https://api.claude.ai/api/usage', {
      'Authorization': `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
    });

    if (result.status === 200 && result.body && typeof result.body === 'object') {
      const body = result.body as Record<string, unknown>;
      const usage = extractUsageFromDirect(body);
      if (usage) {
        return { ...usage, ...baseInfo };
      }
    }
  } catch {
    // Fall through
  }

  // Return credential-only info so the UI can at least show the tier
  return {
    used_tokens: 0,
    limit_tokens: 0,
    percent: 0,
    reset_at: null,
    reset_in: null,
    ...baseInfo,
  };
}

/**
 * Extract usage data from the bootstrap API response.
 * The response shape varies — we try several known patterns.
 */
function extractUsageFromBootstrap(body: Record<string, unknown>): Omit<AccountUsage, 'subscription_type' | 'rate_limit_tier'> | null {
  // Pattern: { usage: { tokens_used, tokens_limit, reset_at } }
  if (body.usage && typeof body.usage === 'object') {
    return extractFromUsageObject(body.usage as Record<string, unknown>);
  }

  // Pattern: { account: { usage: { ... } } }
  if (body.account && typeof body.account === 'object') {
    const account = body.account as Record<string, unknown>;
    if (account.usage && typeof account.usage === 'object') {
      return extractFromUsageObject(account.usage as Record<string, unknown>);
    }
  }

  // Pattern: { rate_limit: { ... } }
  if (body.rate_limit && typeof body.rate_limit === 'object') {
    return extractFromUsageObject(body.rate_limit as Record<string, unknown>);
  }

  // Pattern: top-level fields
  if (typeof body.tokens_used === 'number' || typeof body.used_tokens === 'number') {
    return extractFromUsageObject(body);
  }

  return null;
}

function extractUsageFromDirect(body: Record<string, unknown>): Omit<AccountUsage, 'subscription_type' | 'rate_limit_tier'> | null {
  return extractFromUsageObject(body);
}

function extractFromUsageObject(obj: Record<string, unknown>): Omit<AccountUsage, 'subscription_type' | 'rate_limit_tier'> | null {
  const used = (obj.tokens_used ?? obj.used_tokens ?? obj.current_usage ?? obj.input_tokens) as number | undefined;
  const limit = (obj.tokens_limit ?? obj.limit_tokens ?? obj.max_tokens ?? obj.token_limit) as number | undefined;
  const resetAt = (obj.reset_at ?? obj.resets_at ?? obj.reset_time) as string | undefined;
  const percent = obj.percent_used as number | undefined;

  if (used === undefined && limit === undefined && percent === undefined) {
    return null;
  }

  const usedTokens = typeof used === 'number' ? used : 0;
  const limitTokens = typeof limit === 'number' ? limit : 0;
  const computedPercent = typeof percent === 'number'
    ? percent
    : (limitTokens > 0 ? Math.min((usedTokens / limitTokens) * 100, 100) : 0);

  let resetIn: string | null = null;
  let resetAtIso: string | null = null;
  if (resetAt) {
    try {
      const resetDate = new Date(resetAt);
      resetAtIso = resetDate.toISOString();
      const msUntilReset = resetDate.getTime() - Date.now();
      if (msUntilReset > 0) {
        resetIn = formatResetIn(msUntilReset);
      }
    } catch {
      // Invalid date
    }
  }

  return {
    used_tokens: usedTokens,
    limit_tokens: limitTokens,
    percent: Math.round(computedPercent * 10) / 10,
    reset_at: resetAtIso,
    reset_in: resetIn,
  };
}

/**
 * Read just the credential metadata (subscription type, rate limit tier)
 * without making any API calls. Used as a fast synchronous fallback.
 */
export function readAccountInfo(): Pick<AccountUsage, 'subscription_type' | 'rate_limit_tier'> {
  const creds = readCredentials();
  return {
    subscription_type: creds?.subscriptionType ?? null,
    rate_limit_tier: creds?.rateLimitTier ?? null,
  };
}
