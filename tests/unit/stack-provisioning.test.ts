import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Run the workspace provisioning copy logic from stack.sh in isolation.
 *
 * This mirrors the bash block at sandstorm-cli/lib/stack.sh lines 273-292:
 *   - verify.sh copy
 *   - scripts/ recursive copy (the new block this ticket adds)
 */
function runProvisioningCopy(projectRoot: string, workspace: string): void {
  const script = `
    set -euo pipefail
    PROJECT_ROOT=${JSON.stringify(projectRoot)}
    WORKSPACE=${JSON.stringify(workspace)}
    if [ -f "$PROJECT_ROOT/.sandstorm/verify.sh" ]; then
      mkdir -p "$WORKSPACE/.sandstorm"
      cp "$PROJECT_ROOT/.sandstorm/verify.sh" "$WORKSPACE/.sandstorm/verify.sh" 2>/dev/null || true
    fi
    if [ -d "$PROJECT_ROOT/.sandstorm/scripts" ]; then
      mkdir -p "$WORKSPACE/.sandstorm/scripts"
      cp -rp "$PROJECT_ROOT/.sandstorm/scripts/." "$WORKSPACE/.sandstorm/scripts/" 2>/dev/null || true
    fi
  `;
  execSync(script, { shell: '/bin/bash' });
}

describe('stack workspace provisioning — script copy', () => {
  let projectRoot: string;
  let workspace: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-project-'));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-workspace-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('copies create-pr.sh into workspace preserving content', () => {
    const scriptsDir = path.join(projectRoot, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const scriptContent = '#!/bin/bash\necho "https://github.com/test/repo/pull/1"\n';
    const src = path.join(scriptsDir, 'create-pr.sh');
    fs.writeFileSync(src, scriptContent);
    fs.chmodSync(src, 0o755);

    runProvisioningCopy(projectRoot, workspace);

    const dest = path.join(workspace, '.sandstorm', 'scripts', 'create-pr.sh');
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf-8')).toBe(scriptContent);
  });

  it('preserves the executable bit on copied scripts', () => {
    const scriptsDir = path.join(projectRoot, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const src = path.join(scriptsDir, 'create-pr.sh');
    fs.writeFileSync(src, '#!/bin/bash\n');
    fs.chmodSync(src, 0o755);

    runProvisioningCopy(projectRoot, workspace);

    const dest = path.join(workspace, '.sandstorm', 'scripts', 'create-pr.sh');
    const mode = fs.statSync(dest).mode;
    expect(mode & 0o111).toBeGreaterThan(0);
  });

  it('copies all scripts in the directory', () => {
    const scriptsDir = path.join(projectRoot, '.sandstorm', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    for (const name of ['create-pr.sh', 'fetch-ticket.sh', 'update-ticket.sh']) {
      const f = path.join(scriptsDir, name);
      fs.writeFileSync(f, `#!/bin/bash\necho ${name}\n`);
      fs.chmodSync(f, 0o755);
    }

    runProvisioningCopy(projectRoot, workspace);

    for (const name of ['create-pr.sh', 'fetch-ticket.sh', 'update-ticket.sh']) {
      expect(fs.existsSync(path.join(workspace, '.sandstorm', 'scripts', name))).toBe(true);
    }
  });

  it('recursively copies subdirectories (e.g. scheduled/)', () => {
    const scheduledDir = path.join(projectRoot, '.sandstorm', 'scripts', 'scheduled');
    fs.mkdirSync(scheduledDir, { recursive: true });
    const f = path.join(scheduledDir, 'daily.sh');
    fs.writeFileSync(f, '#!/bin/bash\necho daily\n');
    fs.chmodSync(f, 0o755);

    runProvisioningCopy(projectRoot, workspace);

    expect(
      fs.existsSync(path.join(workspace, '.sandstorm', 'scripts', 'scheduled', 'daily.sh')),
    ).toBe(true);
  });

  it('no-ops silently when host has no .sandstorm/scripts directory', () => {
    // No scripts dir on projectRoot — provisioning must not error
    expect(() => runProvisioningCopy(projectRoot, workspace)).not.toThrow();
    expect(fs.existsSync(path.join(workspace, '.sandstorm', 'scripts'))).toBe(false);
  });

  it('still copies verify.sh when scripts dir is absent', () => {
    fs.mkdirSync(path.join(projectRoot, '.sandstorm'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.sandstorm', 'verify.sh'), '#!/bin/bash\n');

    runProvisioningCopy(projectRoot, workspace);

    expect(fs.existsSync(path.join(workspace, '.sandstorm', 'verify.sh'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, '.sandstorm', 'scripts'))).toBe(false);
  });
});
