import { test, expect } from './fixtures';

test.describe('Dashboard', () => {
  test('dashboard renders with core UI elements', async ({ mainWindow }) => {
    // Wait for the app to fully render — title bar shows "Sandstorm" text
    await mainWindow.waitForSelector('text=Sandstorm', { timeout: 15000 });

    // Title bar should be visible
    await expect(mainWindow.locator('text=Sandstorm').first()).toBeVisible();
  });

  test('new stack button is present and visible', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="new-stack-btn"]', { timeout: 15000 });
    await expect(mainWindow.locator('[data-testid="new-stack-btn"]')).toBeVisible();
  });

  test('empty state or stack table renders', async ({ mainWindow }) => {
    // With no projects/stacks, the dashboard shows an empty state message.
    // With data, it shows the stack table. Either is a valid rendered state.
    const emptyState = mainWindow.locator('text=No stacks yet');
    const stackTable = mainWindow.locator('[data-testid="stack-table"]');

    await expect(emptyState.or(stackTable)).toBeVisible({ timeout: 15000 });
  });

  test('active and history tabs are present', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="tab-active"]', { timeout: 15000 });
    await expect(mainWindow.locator('[data-testid="tab-active"]')).toBeVisible();
    await expect(mainWindow.locator('[data-testid="tab-history"]')).toBeVisible();
  });

  test('clicking new stack button opens dialog', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="new-stack-btn"]', { timeout: 15000 });
    await mainWindow.click('[data-testid="new-stack-btn"]');

    // Dialog should appear with expected fields
    await expect(mainWindow.locator('[data-testid="stack-name"]')).toBeVisible({ timeout: 5000 });
    await expect(mainWindow.locator('[data-testid="launch-btn"]')).toBeVisible();

    // Close dialog
    await mainWindow.click('text=Cancel');

    // Dialog should be gone
    await expect(mainWindow.locator('[data-testid="stack-name"]')).not.toBeVisible({ timeout: 5000 });
  });

  test('can take a screenshot of the dashboard', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('text=Sandstorm', { timeout: 15000 });

    const screenshot = await mainWindow.screenshot();
    expect(screenshot).toBeTruthy();
    expect(screenshot.byteLength).toBeGreaterThan(0);
  });
});
