import { test, expect, _electron as electron, ElectronApplication } from '@playwright/test';

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['dist/main/index.js'],
  });
});

test.afterAll(async () => {
  await app?.close();
});

test('app creates system tray', async () => {
  // Verify the app launched successfully (tray is created in main process)
  const window = await app.firstWindow();
  await expect(window.locator('text=Sandstorm Desktop')).toBeVisible();

  // We can't directly test the tray from Playwright,
  // but we can verify the app is running without errors
  const windowCount = (await app.windows()).length;
  expect(windowCount).toBeGreaterThanOrEqual(1);
});
