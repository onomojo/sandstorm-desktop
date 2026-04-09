import { test, expect } from './fixtures';

test.describe('Navigation', () => {
  test('can switch between active and history tabs', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="tab-active"]', { timeout: 15000 });

    // Click history tab
    await mainWindow.click('[data-testid="tab-history"]');

    // History tab should now be selected (visual state change)
    // Give the UI a moment to update
    await mainWindow.waitForTimeout(500);

    // Click back to active tab
    await mainWindow.click('[data-testid="tab-active"]');
    await mainWindow.waitForTimeout(500);

    // Active tab should be visible and functional
    await expect(mainWindow.locator('[data-testid="tab-active"]')).toBeVisible();
  });

  test('new stack dialog can be opened and closed', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="new-stack-btn"]', { timeout: 15000 });

    // Open dialog
    await mainWindow.click('[data-testid="new-stack-btn"]');
    await expect(mainWindow.locator('[data-testid="stack-name"]')).toBeVisible({ timeout: 5000 });

    // Close via Cancel
    await mainWindow.click('text=Cancel');
    await expect(mainWindow.locator('[data-testid="stack-name"]')).not.toBeVisible({ timeout: 5000 });
  });

  test('app remains stable after multiple interactions', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="new-stack-btn"]', { timeout: 15000 });

    // Perform multiple interactions to verify stability
    for (let i = 0; i < 3; i++) {
      await mainWindow.click('[data-testid="tab-history"]');
      await mainWindow.waitForTimeout(300);
      await mainWindow.click('[data-testid="tab-active"]');
      await mainWindow.waitForTimeout(300);
    }

    // App should still be responsive
    await expect(mainWindow.locator('[data-testid="new-stack-btn"]')).toBeVisible();

    // Open and close dialog to verify interactivity
    await mainWindow.click('[data-testid="new-stack-btn"]');
    await expect(mainWindow.locator('[data-testid="stack-name"]')).toBeVisible({ timeout: 5000 });
    await mainWindow.click('text=Cancel');
    await expect(mainWindow.locator('[data-testid="stack-name"]')).not.toBeVisible({ timeout: 5000 });
  });
});
