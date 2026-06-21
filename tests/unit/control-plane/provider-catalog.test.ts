import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { CatalogProviderList } from '../../../src/shared/opencode-providers';

// Mock electron so getCachePath() falls back to os.tmpdir()
vi.mock('electron', () => ({ app: undefined }), { virtual: true });

// Mock @opencode-ai/sdk so we can control provider.list() responses
vi.mock('@opencode-ai/sdk', () => ({
  createOpencodeClient: vi.fn(),
}));

import { fetchProviderCatalog } from '../../../src/main/control-plane/provider-catalog';
import { createOpencodeClient } from '@opencode-ai/sdk';

const CACHE_PATH = path.join(os.tmpdir(), 'provider-catalog-cache.json');

const MOCK_CATALOG: CatalogProviderList = {
  all: [{ id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'], models: {} }],
  default: {},
  connected: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Remove any leftover cache file
  try { fs.unlinkSync(CACHE_PATH); } catch { /* not present */ }
});

afterEach(() => {
  try { fs.unlinkSync(CACHE_PATH); } catch { /* not present */ }
});

describe('fetchProviderCatalog', () => {
  it('returns live data and writes it to disk cache when server responds', async () => {
    vi.mocked(createOpencodeClient).mockReturnValue({
      provider: { list: vi.fn().mockResolvedValue({ data: MOCK_CATALOG }) },
    } as any);

    const result = await fetchProviderCatalog('http://localhost:1234');

    expect(result).toEqual(MOCK_CATALOG);
    // Cache file must have been written
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const entry = JSON.parse(raw);
    expect(entry.data).toEqual(MOCK_CATALOG);
  });

  it('returns stale cache when server is unreachable', async () => {
    // Pre-populate the cache
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ timestamp: Date.now(), data: MOCK_CATALOG }), 'utf-8');

    vi.mocked(createOpencodeClient).mockReturnValue({
      provider: { list: vi.fn().mockRejectedValue(new Error('connection refused')) },
    } as any);

    const result = await fetchProviderCatalog('http://localhost:1234');

    expect(result).toEqual(MOCK_CATALOG);
  });

  it('returns null when both server is unavailable and there is no cache', async () => {
    const result = await fetchProviderCatalog(null);

    expect(result).toBeNull();
  });
});
