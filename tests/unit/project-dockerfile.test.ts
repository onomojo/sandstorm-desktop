import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Project Dockerfile', () => {
  const dockerfilePath = resolve(__dirname, '../../Dockerfile');
  const dockerfile = readFileSync(dockerfilePath, 'utf-8');

  const requiredPackages = [
    'libnss3',
    'libatk1.0-0',
    'libatk-bridge2.0-0',
    'libcups2',
    'libdrm2',
    'libxkbcommon0',
    'libgbm1',
    'libasound2',
    'libgtk-3-0',
    'xvfb',
  ];

  it.each(requiredPackages)('includes Electron dependency: %s', (pkg) => {
    expect(dockerfile).toContain(pkg);
  });

  it('CMD uses xvfb-run with --auto-servernum', () => {
    expect(dockerfile).toMatch(/CMD\s.*xvfb-run.*--auto-servernum/);
  });

  it('sets DISPLAY environment variable', () => {
    expect(dockerfile).toMatch(/ENV\s+DISPLAY=/);
  });
});

describe('docker-compose.yml app service', () => {
  const composePath = resolve(__dirname, '../../docker-compose.yml');
  const compose = readFileSync(composePath, 'utf-8');

  it('uses xvfb-run in command to support headless Electron', () => {
    expect(compose).toContain('xvfb-run');
  });
});
