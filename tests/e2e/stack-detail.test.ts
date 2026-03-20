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

// These tests verify the UI structure exists
// Full integration (with real stacks) requires Docker running

test('app loads without crashing', async () => {
  const window = await app.firstWindow();
  // The app should not show any error banners on fresh start
  const errorBanner = window.locator('.bg-red-900\\/30');
  const errorCount = await errorBanner.count();
  // It's OK if there's an error about Docker not being available
  expect(errorCount).toBeLessThanOrEqual(1);
});

test('dashboard header shows stack count', async () => {
  const window = await app.firstWindow();
  await expect(window.locator('text=Stacks')).toBeVisible();
  await expect(window.locator('text=No stacks running')).toBeVisible();
});
