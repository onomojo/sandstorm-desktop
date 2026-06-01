import { test, expect, _electron as electron } from '@playwright/test';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('Build artifact verification', () => {
  test('dist/main/index.cjs contains the current git commit hash', async () => {
    const bundlePath = path.resolve(__dirname, '../../dist/main/index.cjs');
    const bundle = fs.readFileSync(bundlePath, 'utf-8');
    const commitHash = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    expect(bundle).toContain(commitHash);
  });

  test('headless Electron smoke: dist/main/index.cjs boots without crashing', async () => {
    const mainCjs = path.resolve(__dirname, '../../dist/main/index.cjs');
    expect(fs.existsSync(mainCjs), 'dist/main/index.cjs must exist').toBe(true);

    const electronBin = path.resolve(__dirname, '../../node_modules/.bin/electron');

    const app = await electron.launch({
      executablePath: electronBin,
      args: [mainCjs, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      env: {
        ...process.env,
        HOME: process.env.HOME ?? '/root',
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      },
      timeout: 30000,
    });

    // Allow the app to fully initialize before closing
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Close cleanly — throws if the app crashed during startup
    await app.close();
  });
});
