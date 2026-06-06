import { test, expect } from './fixtures';

test.describe('Navigation', () => {
  test('TopNav Add project button opens the Open Project dialog', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="workspace-switcher-btn"]', { timeout: 15000 });
    await mainWindow.click('[data-testid="workspace-switcher-btn"]');
    await mainWindow.waitForSelector('[data-testid="add-project-btn"]', { timeout: 5000 });
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
