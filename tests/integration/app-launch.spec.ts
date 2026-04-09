import { test, expect } from './fixtures';

test.describe('App Launch', () => {
  test('electron app starts and creates a window', async ({ electronApp }) => {
    const windows = electronApp.windows();
    expect(windows.length).toBeGreaterThanOrEqual(1);
  });

  test('main window has correct title', async ({ mainWindow }) => {
    const title = await mainWindow.title();
    expect(title).toBe('Sandstorm Desktop');
  });

  test('main window has non-zero dimensions', async ({ mainWindow }) => {
    // Packaged Electron apps may not report viewport size via Playwright,
    // so we check the actual window bounds via evaluate instead
    const bounds = await mainWindow.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
  });

  test('renderer process loaded without crash', async ({ mainWindow }) => {
    // Verify the page didn't navigate to an error page
    const url = mainWindow.url();
    expect(url).not.toContain('about:blank');
    expect(url).not.toContain('chrome-error');
  });

  test('no uncaught exceptions in console', async ({ electronApp, mainWindow }) => {
    const errors: string[] = [];

    mainWindow.on('pageerror', (error) => {
      errors.push(error.message);
    });

    // Give the app a moment to settle
    await mainWindow.waitForTimeout(2000);

    // Filter out known non-critical errors (e.g., Docker not available in test env)
    const criticalErrors = errors.filter(
      (msg) => !msg.includes('Docker') && !msg.includes('ECONNREFUSED')
    );

    expect(criticalErrors).toEqual([]);
  });
});
