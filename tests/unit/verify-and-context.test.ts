import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

describe('sandstorm-exec helper script', () => {
  const scriptPath = resolve(__dirname, '../../sandstorm-cli/docker/sandstorm-exec');

  it('exists and is a valid shell script', () => {
    expect(existsSync(scriptPath)).toBe(true);
    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('#!/bin/bash');
  });

  it('requires at least 2 arguments (service + command)', () => {
    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('$# -lt 2');
  });

  it('uses SANDSTORM_PROJECT environment variable', () => {
    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('SANDSTORM_PROJECT');
  });

  it('constructs the container name from project and service', () => {
    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('${SANDSTORM_PROJECT}-${SERVICE}-1');
  });

  it('uses docker exec to run the command', () => {
    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('docker exec');
  });
});

describe('task-runner.sh verify uses project script', () => {
  const taskRunnerPath = resolve(__dirname, '../../sandstorm-cli/docker/task-runner.sh');
  const taskRunner = readFileSync(taskRunnerPath, 'utf-8');

  it('references .sandstorm/verify.sh', () => {
    expect(taskRunner).toContain('.sandstorm/verify.sh');
  });

  it('skips verification when verify script is missing', () => {
    expect(taskRunner).toContain('No .sandstorm/verify.sh found');
    expect(taskRunner).toContain('skipping verification');
  });

  it('does not contain hardcoded npm test command in run_verify', () => {
    // Extract just the run_verify function
    const verifyFuncMatch = taskRunner.match(/run_verify\(\) \{[\s\S]*?\n\}/);
    expect(verifyFuncMatch).not.toBeNull();
    const verifyFunc = verifyFuncMatch![0];
    expect(verifyFunc).not.toContain('npm test');
    expect(verifyFunc).not.toContain('tsc --noEmit');
    expect(verifyFunc).not.toContain('npm run build');
  });
});

describe('SANDSTORM_INNER.md', () => {
  const innerMdPath = resolve(__dirname, '../../sandstorm-cli/docker/SANDSTORM_INNER.md');
  const innerMd = readFileSync(innerMdPath, 'utf-8');

  it('documents sandstorm-exec command', () => {
    expect(innerMd).toContain('sandstorm-exec <service> <command>');
  });

  it('references verify.sh for verification', () => {
    expect(innerMd).toContain('.sandstorm/verify.sh');
  });

  it('warns against installing languages locally', () => {
    expect(innerMd).toContain('Do NOT install languages');
  });

  it('references dynamic service list', () => {
    expect(innerMd).toContain('Stack Services');
  });
});

describe('entrypoint.sh service label injection', () => {
  const entrypointPath = resolve(__dirname, '../../sandstorm-cli/docker/entrypoint.sh');
  const entrypoint = readFileSync(entrypointPath, 'utf-8');

  it('reads sandstorm.description labels from Docker', () => {
    expect(entrypoint).toContain('sandstorm.description');
  });

  it('injects Stack Services section into CLAUDE.md', () => {
    expect(entrypoint).toContain('## Stack Services');
  });

  it('references sandstorm-exec in injected context', () => {
    expect(entrypoint).toContain('sandstorm-exec');
  });

  it('filters out the claude container from service list', () => {
    expect(entrypoint).toContain('grep -v -- "-claude-"');
  });

  it('writes MCP config to /tmp/sandstorm-mcp.json, not /app/.mcp.json', () => {
    expect(entrypoint).toContain('/tmp/sandstorm-mcp.json');
    expect(entrypoint).not.toContain('/app/.mcp.json');
  });

  it('writes .sandstorm-ready sentinel to /tmp/, not /app/', () => {
    expect(entrypoint).toContain('touch /tmp/.sandstorm-ready');
    expect(entrypoint).not.toContain('touch /app/.sandstorm-ready');
  });
});

describe('Dockerfile includes sandstorm-exec', () => {
  const dockerfilePath = resolve(__dirname, '../../sandstorm-cli/docker/Dockerfile');
  const dockerfile = readFileSync(dockerfilePath, 'utf-8');

  it('copies sandstorm-exec into the image', () => {
    expect(dockerfile).toContain('COPY docker/sandstorm-exec /usr/bin/sandstorm-exec');
  });

  it('makes sandstorm-exec executable', () => {
    expect(dockerfile).toContain('sandstorm-exec');
    expect(dockerfile).toContain('chmod +x');
  });
});

describe('init.sh generates verify.sh and labels', () => {
  const initPath = resolve(__dirname, '../../sandstorm-cli/lib/init.sh');
  const init = readFileSync(initPath, 'utf-8');

  it('generates .sandstorm/verify.sh during init', () => {
    expect(init).toContain('verify.sh');
    expect(init).toContain('Created .sandstorm/verify.sh');
  });

  it('adds sandstorm.description labels to services', () => {
    expect(init).toContain('sandstorm.description');
  });

  it('auto-detects Node.js projects via package.json', () => {
    expect(init).toContain('package.json');
    expect(init).toContain('scripts');
  });

  it('auto-generates descriptions for common database images', () => {
    expect(init).toContain('postgres');
    expect(init).toContain('PostgreSQL database');
  });
});

describe('sandstorm-desktop verify.sh', () => {
  // This tests the verify.sh that sandstorm init generates for this project.
  // Since .sandstorm/ is gitignored, we create a temporary verify.sh for testing
  // using the same auto-detection logic that init would use.
  const tmpDir = resolve(__dirname, '../../.sandstorm-test-tmp');
  const verifyPath = resolve(tmpDir, 'verify.sh');

  beforeAll(() => {
    const { mkdirSync, writeFileSync } = require('fs');
    mkdirSync(tmpDir, { recursive: true });

    // Auto-detect from this project's package.json (same logic as init.sh / autoDetectVerify)
    const lines = ['#!/bin/bash', 'set -e', ''];
    const pkgJsonPath = resolve(__dirname, '../../package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      const scripts = pkg.scripts || {};
      if (scripts.test) lines.push('npm test');
      if (scripts.typecheck) {
        lines.push('npm run typecheck');
      } else if (existsSync(resolve(__dirname, '../../tsconfig.json'))) {
        lines.push('npx tsc --noEmit');
      }
      if (scripts.build) lines.push('npm run build');
    } catch { /* ignore */ }
    writeFileSync(verifyPath, lines.join('\n') + '\n', { mode: 0o755 });
  });

  afterAll(() => {
    const { rmSync } = require('fs');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exists after auto-generation', () => {
    expect(existsSync(verifyPath)).toBe(true);
  });

  it('runs the standard sandstorm-desktop verify steps', () => {
    const content = readFileSync(verifyPath, 'utf-8');
    expect(content).toContain('npm test');
    // Detects either 'npm run typecheck' (if script exists) or 'tsc --noEmit'
    const hasTypeCheck = content.includes('npm run typecheck') || content.includes('tsc --noEmit');
    expect(hasTypeCheck).toBe(true);
    expect(content).toContain('npm run build');
  });

  it('uses set -e for fail-fast behavior', () => {
    const content = readFileSync(verifyPath, 'utf-8');
    expect(content).toContain('set -e');
  });
});
