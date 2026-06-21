/**
 * Provider catalog: fetches the full list of available AI providers from the
 * running OpenCode server and caches results to disk for offline use.
 *
 * Architecture: the catalog is fetched from the OpenCode server that
 * OpenCodeBackend starts at initialize() time. The server URL is passed in
 * by the caller (IPC handler). On failure or when no server is available,
 * a stale disk cache is returned so the UI can still render providers.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { CatalogProviderList } from '../../shared/opencode-providers';


function getCachePath(): string {
  try {
    const { app } = require('electron');
    const userData = typeof app !== 'undefined' && app.getPath
      ? app.getPath('userData')
      : os.tmpdir();
    return path.join(userData, 'provider-catalog-cache.json');
  } catch {
    return path.join(os.tmpdir(), 'provider-catalog-cache.json');
  }
}

interface CacheEntry {
  timestamp: number;
  data: CatalogProviderList;
}

function readCache(): CatalogProviderList | null {
  try {
    const raw = fs.readFileSync(getCachePath(), 'utf-8');
    const entry = JSON.parse(raw) as CacheEntry;
    return entry.data;
  } catch {
    return null;
  }
}

function writeCache(data: CatalogProviderList): void {
  try {
    const entry: CacheEntry = { timestamp: Date.now(), data };
    fs.writeFileSync(getCachePath(), JSON.stringify(entry), 'utf-8');
  } catch {
    // Best effort
  }
}

/**
 * Fetch the provider catalog from the OpenCode server at the given URL.
 * Falls back to disk cache on failure. Returns null only if both fail.
 */
export async function fetchProviderCatalog(serverUrl: string | null): Promise<CatalogProviderList | null> {
  if (serverUrl) {
    try {
      const { createOpencodeClient } = await import('@opencode-ai/sdk');
      const client = createOpencodeClient({ baseUrl: serverUrl });
      const result = await (client as any).provider.list();
      if (result?.data) {
        const catalog: CatalogProviderList = result.data;
        writeCache(catalog);
        return catalog;
      }
    } catch {
      // Fall through to cache
    }
  }
  return readCache();
}
