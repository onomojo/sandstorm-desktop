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

test('app launches and shows dashboard', async () => {
  const window = await app.firstWindow();
  await window.waitForSelector('text=Sandstorm Desktop');

  // Title bar should be visible
  await expect(window.locator('text=Sandstorm Desktop')).toBeVisible();
});

test('dashboard shows empty state', async () => {
  const window = await app.firstWindow();

  // Should show empty state message
  await expect(window.locator('text=No stacks yet')).toBeVisible();
  await expect(
    window.locator('text=Click "+ New Stack" to create your first stack')
  ).toBeVisible();
});

test('new stack button is visible', async () => {
  const window = await app.firstWindow();
  await expect(
    window.locator('[data-testid="new-stack-btn"]')
  ).toBeVisible();
});

test('clicking new stack opens dialog', async () => {
  const window = await app.firstWindow();
  await window.click('[data-testid="new-stack-btn"]');

  // Dialog should appear
  await expect(window.locator('text=New Stack')).toBeVisible();
  await expect(window.locator('[data-testid="stack-name"]')).toBeVisible();
  await expect(window.locator('[data-testid="launch-btn"]')).toBeVisible();

  // Close dialog
  await window.click('text=Cancel');
});
