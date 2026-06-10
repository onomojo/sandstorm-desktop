import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateOpencodeConfig, STATIC_INPUTS } from '../../src/main/opencode-config';

const ROOT = path.resolve(__dirname, '../..');
const COMMITTED_JS = path.join(ROOT, 'sandstorm-cli/docker/opencode-config.js');

describe('opencode-config', () => {
  describe('generateOpencodeConfig', () => {
    it('sets instructions to CLAUDE.md path', () => {
      const config = generateOpencodeConfig(STATIC_INPUTS);
      expect(config.instructions).toEqual(['/home/claude/.claude/CLAUDE.md']);
    });

    it('sets permission to allow', () => {
      const config = generateOpencodeConfig(STATIC_INPUTS);
      expect(config.permission).toBe('allow');
    });

    it('sets model to anthropic/claude-sonnet-4-6', () => {
      const config = generateOpencodeConfig(STATIC_INPUTS);
      expect(config.model).toBe('anthropic/claude-sonnet-4-6');
    });

    it('translates chrome-devtools MCP to OpenCode local format', () => {
      const config = generateOpencodeConfig(STATIC_INPUTS);
      const mcp = config.mcp['chrome-devtools'];
      expect(mcp).toBeDefined();
      expect(mcp.type).toBe('local');
      expect(Array.isArray(mcp.command)).toBe(true);
      expect(mcp.command[0]).toBe('chrome-devtools-mcp');
      expect(mcp.environment).toBeDefined();
      expect(mcp.environment.CHROME_PATH).toBe('/usr/bin/chromium');
      expect(mcp.environment.PUPPETEER_EXECUTABLE_PATH).toBe('/usr/bin/chromium');
    });

    it('includes all chrome-devtools MCP args in command array', () => {
      const config = generateOpencodeConfig(STATIC_INPUTS);
      const command = config.mcp['chrome-devtools'].command;
      expect(command).toContain('--headless');
      expect(command).toContain('--no-usage-statistics');
      expect(command).toContain('--isolated');
      expect(command).toContain('--acceptInsecureCerts');
      expect(command).toContain('--executablePath');
      expect(command).toContain('/usr/bin/chromium');
      expect(command).toContain('--chromeArg=--no-sandbox');
      expect(command).toContain('--chromeArg=--disable-dev-shm-usage');
      expect(command).toContain('--chromeArg=--allow-insecure-localhost');
    });

    it('emits {env:…} placeholders for all provider api keys', () => {
      const config = generateOpencodeConfig(STATIC_INPUTS);
      const providers = Object.values(config.provider);
      expect(providers.length).toBeGreaterThan(0);
      for (const p of providers) {
        expect(p.apiKey).toMatch(/^\{env:/);
        expect(p.apiKey).toMatch(/\}$/);
      }
    });

    it('has clean auth — no embedded OAuth credentials', () => {
      const config = generateOpencodeConfig(STATIC_INPUTS);
      const json = JSON.stringify(config);
      expect(json).not.toContain('refresh_token');
      expect(json).not.toContain('access_token');
      expect(json).not.toContain('oauth_token');
      expect((config as Record<string, unknown>).auth).toBeUndefined();
    });
  });

  describe('CLI mode', () => {
    it('stdout JSON matches generateOpencodeConfig(STATIC_INPUTS)', () => {
      // Copy to a temp dir outside /app so node doesn't inherit /app's "type":"module"
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-cli-test-'));
      const tmpJs = path.join(tmpDir, 'opencode-config.js');
      try {
        fs.copyFileSync(COMMITTED_JS, tmpJs);
        const result = spawnSync(process.execPath, [tmpJs], { encoding: 'utf8' });
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed).toEqual(generateOpencodeConfig(STATIC_INPUTS));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('drift test', () => {
    it('committed opencode-config.js is byte-equal to re-transpiled source', () => {
      const tmpOut = path.join(os.tmpdir(), `opencode-config-drift-${Date.now()}.js`);
      const esbuild = path.join(ROOT, 'node_modules/.bin/esbuild');
      try {
        execFileSync(
          esbuild,
          [
            'src/main/opencode-config.ts',
            '--bundle',
            '--platform=node',
            '--format=cjs',
            `--outfile=${tmpOut}`,
          ],
          { cwd: ROOT, stdio: 'pipe' },
        );
        const committed = fs.readFileSync(COMMITTED_JS);
        const regenerated = fs.readFileSync(tmpOut);
        expect(committed.equals(regenerated)).toBe(true);
      } finally {
        fs.rmSync(tmpOut, { force: true });
      }
    });
  });
});
