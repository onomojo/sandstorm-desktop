import Database from 'better-sqlite3';

export class SecretsModule {
  constructor(private db: Database.Database) {}

  setBackendSecret(key: string, surface: 'inner' | 'outer', name: string, value: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO backend_secrets (key, surface, name, value) VALUES (?, ?, ?, ?)'
    ).run(key, surface, name, value);
  }

  hasBackendSecret(key: string, surface: 'inner' | 'outer'): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM backend_secrets WHERE key = ? AND surface = ?'
    ).get(key, surface);
    return row != null;
  }

  getBackendSecret(key: string, surface: 'inner' | 'outer'): string | null {
    const row = this.db.prepare(
      'SELECT value FROM backend_secrets WHERE key = ? AND surface = ?'
    ).get(key, surface) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setBackendSecretBundle(key: string, surface: 'inner' | 'outer', bundle: Record<string, string>): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO backend_secrets (key, surface, name, value) VALUES (?, ?, ?, ?)'
    ).run(key, surface, '__bundle__', JSON.stringify(bundle));
  }

  getBackendSecretBundle(key: string, surface: 'inner' | 'outer'): Record<string, string> | null {
    const row = this.db.prepare(
      'SELECT name, value FROM backend_secrets WHERE key = ? AND surface = ?'
    ).get(key, surface) as { name: string; value: string } | undefined;
    if (!row) return null;
    if (row.name === '__bundle__') {
      try {
        return JSON.parse(row.value) as Record<string, string>;
      } catch {
        return null;
      }
    }
    return row.name && row.value ? { [row.name]: row.value } : null;
  }

  hasProviderSecret(key: string, provider: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM provider_secrets WHERE key = ? AND provider = ?'
    ).get(key, provider);
    return row != null;
  }

  getProviderSecretBundle(key: string, provider: string): Record<string, string> | null {
    const row = this.db.prepare(
      'SELECT value FROM provider_secrets WHERE key = ? AND provider = ?'
    ).get(key, provider) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as Record<string, string>;
    } catch {
      return null;
    }
  }

  setProviderSecretBundle(key: string, provider: string, bundle: Record<string, string>): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO provider_secrets (key, provider, value) VALUES (?, ?, ?)'
    ).run(key, provider, JSON.stringify(bundle));
  }

  removeProviderSecret(key: string, provider: string): void {
    this.db.prepare(
      'DELETE FROM provider_secrets WHERE key = ? AND provider = ?'
    ).run(key, provider);
  }

  getStoredProviderKeys(scope: string): string[] {
    const rows = this.db.prepare(
      'SELECT provider FROM provider_secrets WHERE key = ?'
    ).all(scope) as { provider: string }[];
    return rows.map(r => r.provider);
  }
}
