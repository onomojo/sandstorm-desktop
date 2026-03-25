import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('CLI directory resolution', () => {
  it('sandstorm-cli directory exists in the project root', () => {
    const cliDir = path.join(__dirname, '../../sandstorm-cli');
    expect(fs.existsSync(cliDir)).toBe(true);
  });

  it('electron-builder.yml uses extraResources for sandstorm-cli', () => {
    const builderConfig = fs.readFileSync(
      path.join(__dirname, '../../electron-builder.yml'),
      'utf-8'
    );
    expect(builderConfig).toContain('extraResources');
    expect(builderConfig).toContain('from: sandstorm-cli');
    expect(builderConfig).toContain('to: sandstorm-cli');
  });

  it('resolveCliDir uses process.resourcesPath for packaged builds', () => {
    // Verify the pattern in index.ts
    const indexSource = fs.readFileSync(
      path.join(__dirname, '../../src/main/index.ts'),
      'utf-8'
    );
    expect(indexSource).toContain("path.join(process.resourcesPath, 'sandstorm-cli')");
    // Should NOT reference app.asar.unpacked anymore
    expect(indexSource).not.toContain('app.asar.unpacked');
  });
});
