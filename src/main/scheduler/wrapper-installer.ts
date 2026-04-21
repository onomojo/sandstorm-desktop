/**
 * Wrapper installer — copies the bundled sandstorm-scheduled-run.sh to a
 * stable, user-writable path and ensures it's executable.
 *
 * Linux:  ~/.local/share/sandstorm/bin/sandstorm-scheduled-run.sh
 * macOS:  ~/Library/Application Support/Sandstorm/bin/sandstorm-scheduled-run.sh
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/**
 * Get the stable wrapper path for the current platform.
 */
export function getStableWrapperPath(): string {
  const platform = os.platform();
  const home = os.homedir();

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Sandstorm', 'bin', 'sandstorm-scheduled-run.sh');
  }

  // Linux (and fallback)
  return path.join(home, '.local', 'share', 'sandstorm', 'bin', 'sandstorm-scheduled-run.sh');
}

/**
 * Get the bundled wrapper path from the app's resources directory.
 */
export function getBundledWrapperPath(resourcesPath: string): string {
  return path.join(resourcesPath, 'bin', 'sandstorm-scheduled-run.sh');
}

function fileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Install or refresh the wrapper script at the stable path.
 * Copies if: (a) missing, (b) content hash differs, (c) executable bit is unset.
 * Returns the stable path.
 */
export function installWrapper(bundledPath: string): string {
  const stablePath = getStableWrapperPath();
  const stableDir = path.dirname(stablePath);

  // Ensure the bundled wrapper exists
  if (!fs.existsSync(bundledPath)) {
    throw new Error(`[scheduler] Bundled wrapper not found at ${bundledPath}`);
  }

  // Create the stable directory
  fs.mkdirSync(stableDir, { recursive: true });

  let needsCopy = false;

  if (!fs.existsSync(stablePath)) {
    needsCopy = true;
  } else {
    // Check content hash
    const bundledHash = fileHash(bundledPath);
    const stableHash = fileHash(stablePath);
    if (bundledHash !== stableHash) {
      needsCopy = true;
    }
  }

  if (needsCopy) {
    fs.copyFileSync(bundledPath, stablePath);
    console.log(`[scheduler] Installed wrapper to ${stablePath}`);
  }

  // Ensure executable bit
  try {
    const stat = fs.statSync(stablePath);
    if (!(stat.mode & 0o111)) {
      fs.chmodSync(stablePath, 0o755);
      console.log(`[scheduler] Set executable bit on ${stablePath}`);
    }
  } catch (err) {
    console.warn(`[scheduler] Failed to set executable bit: ${err}`);
  }

  return stablePath;
}
