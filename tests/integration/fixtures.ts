import {
  test as base,
  expect,
  _electron as electron,
  ElectronApplication,
  Page,
} from '@playwright/test';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the packaged Electron binary path.
 * After `npm run package`, electron-builder outputs to `release/linux-unpacked/`.
 * The binary name matches the productName from electron-builder.yml (lowercased, hyphenated).
 */
function resolvePackagedBinary(): string {
  const projectRoot = path.resolve(__dirname, '../..');
  const unpackedDir = path.join(projectRoot, 'release', 'linux-unpacked');

  if (!fs.existsSync(unpackedDir)) {
    throw new Error(
      `Packaged app not found at ${unpackedDir}. Run "npm run package" before integration tests.`
    );
  }

  // Look for the executable — productName is "Sandstorm Desktop" → binary is "sandstorm-desktop"
  const expectedBinary = path.join(unpackedDir, 'sandstorm-desktop');
  if (fs.existsSync(expectedBinary)) {
    return expectedBinary;
  }

  // Fallback: find any executable file in the unpacked directory
  const files = fs.readdirSync(unpackedDir);
  for (const file of files) {
    const filePath = path.join(unpackedDir, file);
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        return filePath;
      }
    } catch {
      // Not executable, skip
    }
  }

  throw new Error(
    `No executable found in ${unpackedDir}. Contents: ${files.join(', ')}`
  );
}

type IntegrationFixtures = {
  electronApp: ElectronApplication;
  mainWindow: Page;
};

/**
 * Playwright test fixture that launches the packaged Electron app
 * and provides the app instance and main window to each test.
 *
 * The app is launched once per test file (worker-scoped) and reused
 * across all tests in the file.
 */
export const test = base.extend<object, IntegrationFixtures>({
  electronApp: [
    async ({}, use) => {
      const executablePath = resolvePackagedBinary();

      // Diagnostic logging for debuggability in headless Docker environments
      const displayValue = process.env.DISPLAY;
      console.log(`[fixture] DISPLAY=${displayValue}`);
      console.log(`[fixture] Launching: ${executablePath}`);

      // Check if the display server is reachable
      if (displayValue) {
        // Validate display format before interpolating into shell command
        if (!/^:\d+(\.\d+)?$/.test(displayValue)) {
          console.warn(`[fixture] Skipping xdpyinfo check: DISPLAY value '${displayValue}' has unexpected format`);
        } else {
          try {
            execSync(`xdpyinfo -display ${displayValue} 2>&1 | head -3`, {
              timeout: 5000,
              stdio: 'pipe',
            });
            console.log(`[fixture] Display ${displayValue} is reachable`);
          } catch {
            console.warn(
              `[fixture] Warning: Display ${displayValue} may not be reachable — Electron launch may fail`
            );
          }
        }
      }

      // Do NOT override DISPLAY here. When running under xvfb-run, the
      // DISPLAY env var is already set correctly by xvfb-run for its child
      // process. Hardcoding a fallback like ':99' causes collisions when
      // the dev server is already using display :99 inside Docker containers.
      //
      // --no-sandbox: required when running as root in Docker containers.
      //   Electron refuses to start as root without this flag.
      // --disable-gpu: prevents GPU-related crashes in headless Docker
      //   (no real GPU available; Chromium falls back to software rendering).
      // --disable-dev-shm-usage: Docker's /dev/shm is typically only 64MB;
      //   without this flag the renderer can crash due to shared memory
      //   exhaustion when compositing large frames.
      const app = await electron.launch({
        executablePath,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
        env: {
          ...process.env,
          REMOTE_DEBUGGING_PORT: '9222',
          // Ensure the packaged app can find claude CLI and its credentials
          HOME: '/root',
          PATH: '/usr/local/bin:/usr/bin:/bin',
        },
        timeout: 60000,
      });

      await use(app);

      await app.close();
    },
    { scope: 'worker' },
  ],

  mainWindow: [
    async ({ electronApp }, use) => {
      const window = await electronApp.firstWindow();

      // Wait for the app to be ready — the renderer should have loaded
      await window.waitForLoadState('domcontentloaded');

      await use(window);
    },
    { scope: 'worker' },
  ],
});

export { expect };
