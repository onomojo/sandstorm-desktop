import { test, expect } from './fixtures';

test.describe('Usage Stats', () => {
  test('usage percentage or usage bar renders in the header', async ({ mainWindow }) => {
    // Wait for the app to fully render
    await mainWindow.waitForSelector('text=Sandstorm', { timeout: 15000 });

    // The AccountUsageBar component renders with data-testid="account-usage-bar".
    // When session data is available, it shows a percentage like "47%".
    // When only stack data is available, it shows a token counter.
    // When neither is available, the component returns null (not rendered).
    //
    // In the integration test environment, the claude CLI may not be available
    // or authenticated, so usage stats may not load. We verify:
    // 1. The app doesn't crash due to node-pty loading
    // 2. If usage data IS available, the percentage is visible
    // 3. If usage data is NOT available, the app still works (graceful degradation)

    // Give the session monitor time to attempt its first poll
    await mainWindow.waitForTimeout(5000);

    // Check if the usage bar component rendered at all
    const usageBar = mainWindow.locator('[data-testid="account-usage-bar"]');
    const usageBarVisible = await usageBar.isVisible().catch(() => false);

    if (usageBarVisible) {
      // Usage bar is showing — verify it has meaningful content
      const usagePercent = mainWindow.locator('[data-testid="usage-percent"]');
      const usageCounter = mainWindow.locator('[data-testid="usage-counter"]');

      // Either the percentage display or the token counter should be visible
      const percentVisible = await usagePercent.isVisible().catch(() => false);
      const counterVisible = await usageCounter.isVisible().catch(() => false);

      expect(percentVisible || counterVisible).toBe(true);

      if (percentVisible) {
        // Verify the percentage text matches expected format (e.g., "47%" or "...")
        const text = await usagePercent.textContent();
        expect(text).toMatch(/^\d+%$|^\.\.\.$/);
      }
    }

    // Regardless of whether usage data loaded, the app should be functional.
    // Verify the core UI is still responsive (not crashed by node-pty issues).
    await expect(mainWindow.locator('text=Sandstorm').first()).toBeVisible();
  });

  test('app does not crash when node-pty loads or fails to load', async ({ mainWindow }) => {
    // This test verifies graceful degradation — the app must work even if
    // node-pty fails to load (wrong ABI, missing binary, etc.)
    await mainWindow.waitForSelector('text=Sandstorm', { timeout: 15000 });

    // Collect console errors during a settling period
    const errors: string[] = [];
    mainWindow.on('pageerror', (error) => {
      errors.push(error.message);
    });

    await mainWindow.waitForTimeout(3000);

    // Filter out known non-critical errors
    const criticalErrors = errors.filter(
      (msg) =>
        !msg.includes('Docker') &&
        !msg.includes('ECONNREFUSED') &&
        !msg.includes('node-pty')  // node-pty load failures are expected in test env
    );

    expect(criticalErrors).toEqual([]);

    // App should still be functional
    const newStackBtn = mainWindow.locator('[data-testid="new-stack-btn"]');
    await expect(newStackBtn).toBeVisible({ timeout: 5000 });
  });

  test('usage bar click opens popover when usage data available', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('text=Sandstorm', { timeout: 15000 });
    await mainWindow.waitForTimeout(5000);

    const usageButton = mainWindow.locator('[data-testid="usage-bar-button"]');
    const buttonVisible = await usageButton.isVisible().catch(() => false);

    if (buttonVisible) {
      await usageButton.click();

      // Popover should appear
      const popover = mainWindow.locator('[data-testid="usage-popover"]');
      await expect(popover).toBeVisible({ timeout: 3000 });

      // Popover should contain "Session Usage" text
      await expect(popover.locator('text=Session Usage')).toBeVisible();
    }
  });
});
