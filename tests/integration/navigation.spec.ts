import { test, expect } from './fixtures';

test.describe('Navigation', () => {
  test('can switch between Active and History tabs on the KanbanBoard', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="tab-active"]', { timeout: 15000 });

    // Click History tab
    await mainWindow.click('[data-testid="tab-history"]');
    await mainWindow.waitForTimeout(500);

    // Click back to Active tab
    await mainWindow.click('[data-testid="tab-active"]');
    await mainWindow.waitForTimeout(500);

    // Both tabs remain visible and functional after switching
    await expect(mainWindow.locator('[data-testid="tab-active"]')).toBeVisible();
    await expect(mainWindow.locator('[data-testid="tab-history"]')).toBeVisible();
  });

  test('app remains stable after repeated tab interactions', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="tab-active"]', { timeout: 15000 });

    // Toggle Active/History tabs multiple times to verify stability.
    for (let i = 0; i < 3; i++) {
      await mainWindow.click('[data-testid="tab-history"]');
      await mainWindow.waitForTimeout(300);
      await mainWindow.click('[data-testid="tab-active"]');
      await mainWindow.waitForTimeout(300);
    }

    // App should still be responsive after repeated tab toggles.
    await expect(mainWindow.locator('[data-testid="left-rail"]')).toBeVisible();
  });

  test('LeftRail Add project button opens the Open Project dialog', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="add-project-btn"]', { timeout: 15000 });
    await mainWindow.click('[data-testid="add-project-btn"]');

    // The OpenProjectDialog renders a heading "Open Project".
    await mainWindow.waitForSelector('text=Open Project', { timeout: 5000 });
    await expect(mainWindow.locator('text=Open Project').first()).toBeVisible();

    // Close the dialog so it does not bleed state into subsequent worker-scoped
    // tests — the Electron app is launched once per worker, so an open modal
    // here would intercept pointer events in later spec files.
    await mainWindow.click('text=Cancel');
    await expect(mainWindow.locator('text=Open Project')).not.toBeVisible({ timeout: 5000 });
  });
});
