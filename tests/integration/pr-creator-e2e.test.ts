/**
 * End-to-end tests for createPullRequest.
 *
 * These tests wire real git operations and a stub create-pr.sh against the
 * createPullRequest orchestration function with no mocks across the
 * IPC/stackManager/script boundary. Docker and GitHub are not required —
 * a local bare repo serves as "origin" and a stub script replaces gh.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { promisify } from 'util';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createPullRequest, MAX_PR_ATTEMPTS } from '../../src/main/control-plane/pr-creator';

const execFileAsync = promisify(execFile);

describe('createPullRequest — e2e', () => {
  let workspace: string;
  let origin: string;
  let scriptPath: string;

  beforeEach(() => {
    // Bare repo acts as the remote origin
    origin = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-e2e-origin-'));
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--bare', '-q', origin]);

    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-e2e-ws-'));
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: workspace });
    execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: workspace });

    // Initial commit on main
    fs.writeFileSync(path.join(workspace, 'README.md'), 'init');
    execFileSync('git', ['add', '-A'], { cwd: workspace });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: workspace });
    execFileSync('git', ['push', '-u', '-q', 'origin', 'main'], { cwd: workspace });

    // Feature branch with a commit
    execFileSync('git', ['checkout', '-q', '-b', 'feat/e2e-test'], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, 'feature.ts'), 'export const x = 1;');
    execFileSync('git', ['add', '-A'], { cwd: workspace });
    execFileSync('git', ['commit', '-q', '-m', 'feat: add feature'], { cwd: workspace });

    // Install .sandstorm/scripts dir (where create-pr.sh will live)
    fs.mkdirSync(path.join(workspace, '.sandstorm', 'scripts'), { recursive: true });
    scriptPath = path.join(workspace, '.sandstorm', 'scripts', 'create-pr.sh');
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(origin, { recursive: true, force: true });
  });

  /** Build real CreatePRDeps that push to the local bare repo and run the actual script. */
  function buildDeps(setPR = vi.fn()) {
    return {
      workspace,
      setPullRequest: setPR,
      async runPush(title: string, bodyFile: string): Promise<{ stdout: string; stderr: string }> {
        const branch = execFileSync(
          'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
          { cwd: workspace, encoding: 'utf-8' },
        ).trim();
        execFileSync('git', ['push', '-u', '-q', 'origin', branch], { cwd: workspace });
        try {
          const r = await execFileAsync(
            scriptPath,
            ['--title', title, '--base', 'main', '--head', branch, '--body-file', bodyFile],
            { cwd: workspace },
          );
          return { stdout: r.stdout, stderr: r.stderr };
        } catch (err: any) {
          return {
            stdout: err.stdout ?? '',
            stderr: `SANDSTORM_PR_FAILED:script exited non-zero: ${String(err.message ?? err)}`,
          };
        }
      },
      async checkoutBranch(branch: string): Promise<void> {
        execFileSync('git', ['checkout', '-b', branch], { cwd: workspace });
      },
    };
  }

  it('happy path: returns url and number on first attempt', async () => {
    fs.writeFileSync(scriptPath, '#!/bin/bash\necho "https://github.com/test/repo/pull/1"\n');
    fs.chmodSync(scriptPath, 0o755);

    const setPR = vi.fn();
    const result = await createPullRequest(
      { stackId: 's', title: 'feat: e2e test', body: 'body text' },
      buildDeps(setPR),
    );

    expect(result).toEqual({ url: 'https://github.com/test/repo/pull/1', number: 1 });
    expect(setPR).toHaveBeenCalledWith('https://github.com/test/repo/pull/1', 1);
  });

  it('auto-recovery: bumps to -v2 branch when first attempt fails', async () => {
    // Script checks the current branch: fail on original, succeed on -v2
    fs.writeFileSync(
      scriptPath,
      `#!/bin/bash
set -euo pipefail
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" = "feat/e2e-test" ]; then
  exit 1
fi
echo "https://github.com/test/repo/pull/2"
`,
    );
    fs.chmodSync(scriptPath, 0o755);

    const setPR = vi.fn();
    const result = await createPullRequest(
      { stackId: 's', title: 'feat: e2e test', body: 'body text' },
      buildDeps(setPR),
    );

    expect(result).toEqual({ url: 'https://github.com/test/repo/pull/2', number: 2 });
    expect(setPR).toHaveBeenCalledWith('https://github.com/test/repo/pull/2', 2);

    // The recovery branch must have been created locally
    const branches = execFileSync(
      'git', ['branch', '--list', 'feat/e2e-test-v2'],
      { cwd: workspace, encoding: 'utf-8' },
    );
    expect(branches).toContain('feat/e2e-test-v2');

    // The recovery branch must have been pushed to origin
    const remoteBranches = execFileSync(
      'git', ['ls-remote', '--heads', 'origin', 'feat/e2e-test-v2'],
      { cwd: workspace, encoding: 'utf-8' },
    );
    expect(remoteBranches).toContain('feat/e2e-test-v2');

    // Original branch must be untouched on origin
    const origRemote = execFileSync(
      'git', ['ls-remote', '--heads', 'origin', 'feat/e2e-test'],
      { cwd: workspace, encoding: 'utf-8' },
    );
    expect(origRemote).toContain('feat/e2e-test');
  });

  it(`budget exhaustion: throws after ${MAX_PR_ATTEMPTS} attempts with all reasons`, async () => {
    // Script always fails
    fs.writeFileSync(scriptPath, '#!/bin/bash\nexit 1\n');
    fs.chmodSync(scriptPath, 0o755);

    await expect(
      createPullRequest(
        { stackId: 's', title: 'feat: e2e test', body: 'body text' },
        buildDeps(),
      ),
    ).rejects.toThrow(`PR creation failed after ${MAX_PR_ATTEMPTS} attempts`);

    // Recovery branches v2 through v5 must exist
    for (let i = 2; i <= MAX_PR_ATTEMPTS; i++) {
      const branches = execFileSync(
        'git', ['branch', '--list', `feat/e2e-test-v${i}`],
        { cwd: workspace, encoding: 'utf-8' },
      );
      expect(branches).toContain(`feat/e2e-test-v${i}`);
    }
  });
});
