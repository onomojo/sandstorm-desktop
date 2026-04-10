import { test, expect } from './fixtures';

test.describe('Usage Stats', () => {
  test('session monitor polls usage and renders usage bar with real data', async ({ mainWindow }) => {
    // Wait for the app to fully render
    await mainWindow.waitForSelector('text=Sandstorm', { timeout: 15000 });

    // Give the session monitor time to complete at least one poll cycle.
    // The PTY-based fetch takes ~5-15s typical, up to 30s with onboarding.
    await mainWindow.waitForTimeout(35000);

    // Check the session monitor state via the preload API
    const state = await mainWindow.evaluate(async () => {
      // @ts-expect-error - accessing preload API
      return await window.sandstorm.session.getState();
    });

    // The session monitor must have attempted at least one poll
    expect(state).toBeTruthy();
    expect(state.claudeAvailable).toBe(true);

    // Usage data MUST be available — no conditional fallback
    expect(state.usage).toBeTruthy();
    expect(state.usage.session).toBeTruthy();

    // The usage bar MUST be visible
    const usageBar = mainWindow.locator('[data-testid="account-usage-bar"]');
    await expect(usageBar).toBeVisible({ timeout: 5000 });

    // The usage percent MUST show a percentage
    const usagePercent = mainWindow.locator('[data-testid="usage-percent"]');
    await expect(usagePercent).toBeVisible({ timeout: 5000 });

    const text = await usagePercent.textContent();
    expect(text).toMatch(/^\d+%$/);
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

  test('usage bar click opens popover with Session Usage', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('text=Sandstorm', { timeout: 15000 });

    // Wait for session monitor to poll
    await mainWindow.waitForTimeout(35000);

    // The usage bar MUST be visible — no conditional skip
    const usageButton = mainWindow.locator('[data-testid="usage-bar-button"]');
    await expect(usageButton).toBeVisible({ timeout: 5000 });

    // Click to open the popover
    await usageButton.click();

    // Popover MUST appear with session usage details
    const popover = mainWindow.locator('[data-testid="usage-popover"]');
    await expect(popover).toBeVisible({ timeout: 3000 });

    // Popover MUST contain "Session Usage" heading
    await expect(popover.locator('text=Session Usage')).toBeVisible();

    // Popover MUST show "Current Session" section with a real percentage
    await expect(popover.locator('text=Current Session')).toBeVisible();
    await expect(popover.locator('text=/\\d+% used/')).toBeVisible();
  });

  test('session monitor reports claude CLI availability', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('text=Sandstorm', { timeout: 15000 });

    // Give session monitor time to check claude availability
    await mainWindow.waitForTimeout(20000);

    const state = await mainWindow.evaluate(async () => {
      // @ts-expect-error - accessing preload API
      return await window.sandstorm.session.getState();
    });

    // The session monitor must report on claude availability
    expect(state).toBeTruthy();
    expect(state.claudeAvailable).toBe(true);
  });
});
