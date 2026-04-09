import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

describe('integration test fixture (tests/integration/fixtures.ts)', () => {
  const fixturePath = resolve(__dirname, '../integration/fixtures.ts');
  const fixture = readFileSync(fixturePath, 'utf-8');

  it('does not hardcode DISPLAY env variable in electron.launch', () => {
    // The fixture should NOT override DISPLAY with a hardcoded value.
    // When running under xvfb-run, DISPLAY is already set correctly.
    // Hardcoding ':99' causes collisions when the dev server occupies display :99.
    expect(fixture).not.toMatch(/DISPLAY:\s*process\.env\.DISPLAY\s*\|\|\s*['"]:/);
    expect(fixture).not.toMatch(/DISPLAY:\s*['"]:/);
  });

  it('inherits DISPLAY from process.env via spread', () => {
    // The env block should spread process.env, which includes DISPLAY
    // set by xvfb-run. No explicit DISPLAY override needed.
    expect(fixture).toContain('...process.env');
  });

  it('includes diagnostic logging for DISPLAY value', () => {
    expect(fixture).toContain('process.env.DISPLAY');
    expect(fixture).toMatch(/console\.log.*DISPLAY/);
  });

  it('includes diagnostic logging for executable path', () => {
    expect(fixture).toMatch(/console\.log.*executablePath|console\.log.*Launching/);
  });

  it('sets REMOTE_DEBUGGING_PORT for CDP', () => {
    expect(fixture).toContain("REMOTE_DEBUGGING_PORT: '9222'");
  });

  it('passes --no-sandbox flag for running as root in Docker', () => {
    expect(fixture).toContain('--no-sandbox');
  });

  it('passes --disable-gpu flag for headless Docker', () => {
    expect(fixture).toContain('--disable-gpu');
  });

  it('passes --disable-dev-shm-usage flag for Docker shared memory', () => {
    expect(fixture).toContain('--disable-dev-shm-usage');
  });

  it('uses extended timeout for container initialization', () => {
    // 60 seconds to allow for slow container startup
    expect(fixture).toContain('timeout: 60000');
  });
});

describe('test:integration npm script (package.json)', () => {
  const pkgPath = resolve(__dirname, '../../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const script = pkg.scripts['test:integration'];

  it('exists', () => {
    expect(script).toBeDefined();
  });

  it('uses xvfb-run with a deterministic server number', () => {
    // --server-num=50 avoids collision with the dev server's display :99
    // and is deterministic (unlike --auto-servernum which picks any free number)
    expect(script).toContain('--server-num=');
    expect(script).not.toContain('--auto-servernum');
  });

  it('runs playwright with the integration config', () => {
    expect(script).toContain('playwright test');
    expect(script).toContain('playwright.integration.config.ts');
  });
});

describe('.sandstorm/verify.sh', () => {
  const verifyPath = resolve(__dirname, '../../.sandstorm/verify.sh');

  it('exists', () => {
    expect(existsSync(verifyPath)).toBe(true);
  });

  it('is a bash script with strict mode', () => {
    const content = readFileSync(verifyPath, 'utf-8');
    expect(content).toContain('#!/usr/bin/env bash');
    expect(content).toContain('set -euo pipefail');
  });

  it('does NOT kill xvfb-run (it is the container main process)', () => {
    const content = readFileSync(verifyPath, 'utf-8');
    // xvfb-run is PID 1 in the container — killing it stops the container.
    // Instead, tests use a separate display via --server-num=50.
    expect(content).not.toContain('pkill -f "xvfb-run"');
  });

  it('runs integration tests via sandstorm-exec', () => {
    const content = readFileSync(verifyPath, 'utf-8');
    expect(content).toContain('test:integration');
  });

  it('uses --force flag for electron-rebuild to avoid stale ABI cache', () => {
    const content = readFileSync(verifyPath, 'utf-8');
    // Without --force, electron-rebuild skips modules it considers already-built,
    // even when they were compiled for the wrong ABI (Node.js vs Electron).
    // The npm rebuild step resets to Node.js ABI, so --force is needed to
    // ensure the rebuild always produces Electron-compatible binaries.
    expect(content).toContain('electron-rebuild --force');
  });

  it('runs typecheck, unit tests, build, and package before integration tests', () => {
    const content = readFileSync(verifyPath, 'utf-8');
    const steps = [
      'npm run typecheck',
      'npm test',
      'npm run build',
      'npm run package',
      'test:integration',
    ];
    let lastIndex = -1;
    for (const step of steps) {
      const index = content.indexOf(step);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it('rebuilds native modules for Node.js before unit tests', () => {
    const content = readFileSync(verifyPath, 'utf-8');
    // npm rebuild resets native modules to the host Node.js ABI.
    // Without this, a prior electron-rebuild (which targets Electron's ABI)
    // leaves better-sqlite3 incompatible with Vitest/Node.js unit tests.
    const rebuildIdx = content.indexOf('npm rebuild');
    const unitTestIdx = content.indexOf('npm test');
    expect(rebuildIdx).toBeGreaterThan(-1);
    expect(rebuildIdx).toBeLessThan(unitTestIdx);
  });

  it('uses sandstorm-exec to run commands on app service', () => {
    const content = readFileSync(verifyPath, 'utf-8');
    expect(content).toContain('sandstorm-exec app');
  });
});
