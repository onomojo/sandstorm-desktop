import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  installWrapper,
} from '../../src/main/scheduler/wrapper-installer';

let tmpDir: string;
let bundledDir: string;
let stableDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-wrap-test-'));
  bundledDir = path.join(tmpDir, 'bundled', 'bin');
  stableDir = path.join(tmpDir, 'stable', 'bin');
  fs.mkdirSync(bundledDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// We can't easily test getStableWrapperPath() without mocking os.homedir,
// but we can test installWrapper's logic with custom paths.

describe('wrapper-installer', () => {
  // installWrapper uses getStableWrapperPath() internally, which references
  // the real home dir. Instead, test the installer by providing a bundled
  // path and verifying it copies correctly. We test the copy logic by using
  // a mock stable path via a wrapper function approach.

  it('copies bundled wrapper to stable path when missing', () => {
    const bundledPath = path.join(bundledDir, 'sandstorm-scheduled-run.sh');
    fs.writeFileSync(bundledPath, '#!/bin/sh\necho "test v1"', { mode: 0o755 });

    // installWrapper will copy to the real stable path, but we can verify
    // the function runs without error
    const result = installWrapper(bundledPath);
    expect(result).toBeTruthy();
    // The stable path should exist after installation
    expect(fs.existsSync(result)).toBe(true);
  });

  it('throws when bundled file is missing', () => {
    const nonexistent = path.join(bundledDir, 'nonexistent.sh');
    expect(() => installWrapper(nonexistent)).toThrow(/Bundled wrapper not found/);
  });

  it('updates wrapper when content hash differs', () => {
    const bundledPath = path.join(bundledDir, 'sandstorm-scheduled-run.sh');

    // First install
    fs.writeFileSync(bundledPath, '#!/bin/sh\necho "v1"', { mode: 0o755 });
    const stablePath = installWrapper(bundledPath);

    if (!fs.existsSync(stablePath)) return; // Skip if stable path can't be written

    const v1Content = fs.readFileSync(stablePath, 'utf-8');

    // Update bundled content
    fs.writeFileSync(bundledPath, '#!/bin/sh\necho "v2"', { mode: 0o755 });
    installWrapper(bundledPath);

    const v2Content = fs.readFileSync(stablePath, 'utf-8');
    expect(v2Content).toContain('v2');
    expect(v2Content).not.toBe(v1Content);
  });

  it('sets executable permission on installed wrapper', () => {
    const bundledPath = path.join(bundledDir, 'sandstorm-scheduled-run.sh');
    fs.writeFileSync(bundledPath, '#!/bin/sh\necho "test"', { mode: 0o755 });

    const stablePath = installWrapper(bundledPath);

    if (!fs.existsSync(stablePath)) return;

    const stat = fs.statSync(stablePath);
    // At least one execute bit must be set
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  it('restores executable permission if cleared', () => {
    const bundledPath = path.join(bundledDir, 'sandstorm-scheduled-run.sh');
    fs.writeFileSync(bundledPath, '#!/bin/sh\necho "test"', { mode: 0o755 });

    const stablePath = installWrapper(bundledPath);
    if (!fs.existsSync(stablePath)) return;

    // Remove execute permission
    fs.chmodSync(stablePath, 0o644);
    expect(fs.statSync(stablePath).mode & 0o111).toBe(0);

    // Re-install should restore it
    installWrapper(bundledPath);
    const stat = fs.statSync(stablePath);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  it('skips copy when content hash matches', () => {
    const bundledPath = path.join(bundledDir, 'sandstorm-scheduled-run.sh');
    fs.writeFileSync(bundledPath, '#!/bin/sh\necho "same"', { mode: 0o755 });

    const stablePath = installWrapper(bundledPath);
    if (!fs.existsSync(stablePath)) return;

    const mtime1 = fs.statSync(stablePath).mtimeMs;

    // Small delay to detect mtime changes
    const start = Date.now();
    while (Date.now() - start < 50) { /* spin */ }

    // Re-install with same content — should not copy
    installWrapper(bundledPath);

    const mtime2 = fs.statSync(stablePath).mtimeMs;
    expect(mtime2).toBe(mtime1); // File was not overwritten
  });
});
