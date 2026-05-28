import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Tests for the migration deletion logic that removes obsolete ticket scripts
 * on project open. The actual deletion happens inside ipc.ts:checkMigration,
 * but we test the policy here using the same file-system operations.
 */

const OBSOLETE_SCRIPTS = [
  'fetch-ticket.sh',
  'update-ticket.sh',
  'create-ticket.sh',
  'start-ticket.sh',
  'create-pr.sh',
];

function deleteObsoleteTicketScripts(projectDir: string): void {
  const scriptsDir = path.join(projectDir, '.sandstorm', 'scripts');
  for (const name of OBSOLETE_SCRIPTS) {
    try { fs.unlinkSync(path.join(scriptsDir, name)); } catch { /* missing = no-op */ }
  }
}

describe('obsolete ticket script deletion', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-del-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createFile(relPath: string, content = '#!/bin/bash'): void {
    const fullPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, { mode: 0o755 });
  }

  it('deletes all 5 obsolete ticket scripts', () => {
    for (const name of OBSOLETE_SCRIPTS) {
      createFile(`.sandstorm/scripts/${name}`);
    }
    deleteObsoleteTicketScripts(tmpDir);
    for (const name of OBSOLETE_SCRIPTS) {
      expect(fs.existsSync(path.join(tmpDir, '.sandstorm', 'scripts', name))).toBe(false);
    }
  });

  it('does not delete scheduled/ scripts', () => {
    createFile('.sandstorm/scripts/fetch-ticket.sh');
    createFile('.sandstorm/scripts/scheduled/my-automation.sh');
    deleteObsoleteTicketScripts(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.sandstorm', 'scripts', 'fetch-ticket.sh'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.sandstorm', 'scripts', 'scheduled', 'my-automation.sh'))).toBe(true);
  });

  it('does not delete unrelated files', () => {
    createFile('.sandstorm/scripts/fetch-ticket.sh');
    createFile('.sandstorm/scripts/my-custom-script.sh');
    deleteObsoleteTicketScripts(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.sandstorm', 'scripts', 'fetch-ticket.sh'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.sandstorm', 'scripts', 'my-custom-script.sh'))).toBe(true);
  });

  it('is idempotent — running twice does not throw', () => {
    createFile('.sandstorm/scripts/fetch-ticket.sh');
    deleteObsoleteTicketScripts(tmpDir);
    expect(() => deleteObsoleteTicketScripts(tmpDir)).not.toThrow();
  });

  it('is a no-op when scripts directory does not exist', () => {
    expect(() => deleteObsoleteTicketScripts(tmpDir)).not.toThrow();
  });

  it('only deletes files by exact name (no glob matching)', () => {
    createFile('.sandstorm/scripts/fetch-ticket.sh');
    createFile('.sandstorm/scripts/fetch-ticket-custom.sh');
    deleteObsoleteTicketScripts(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.sandstorm', 'scripts', 'fetch-ticket.sh'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.sandstorm', 'scripts', 'fetch-ticket-custom.sh'))).toBe(true);
  });
});
