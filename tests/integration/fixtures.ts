import {
  test as base,
  expect,
  _electron as electron,
  ElectronApplication,
  Page,
} from '@playwright/test';
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

      const app = await electron.launch({
        executablePath,
        env: {
          ...process.env,
          DISPLAY: process.env.DISPLAY || ':99',
          REMOTE_DEBUGGING_PORT: '9222',
        },
        timeout: 30000,
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
