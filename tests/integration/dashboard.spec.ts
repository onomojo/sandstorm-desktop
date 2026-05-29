import { test, expect } from './fixtures';

test.describe('Main view (LeftRail + KanbanBoard)', () => {
  test('app renders LeftRail and KanbanBoard', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="left-rail"]', { timeout: 15000 });
    await expect(mainWindow.locator('[data-testid="left-rail"]')).toBeVisible();
    await expect(mainWindow.locator('[data-testid="kanban-board"]')).toBeVisible();
  });

  test('LeftRail shows the Sandstorm brand mark', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="left-rail"]', { timeout: 15000 });
    const rail = mainWindow.locator('[data-testid="left-rail"]');
    await expect(rail.locator('text=Sandstorm').first()).toBeVisible();
  });

  test('LeftRail shows the Workspaces section with an Add project button', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="rail-workspaces"]', { timeout: 15000 });
    await expect(mainWindow.locator('[data-testid="rail-workspaces"]')).toBeVisible();
    await expect(mainWindow.locator('[data-testid="add-project-btn"]')).toBeVisible();
  });

  test('LeftRail shows the Ask Claude section and settings cog', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="ask-claude-btn"]', { timeout: 15000 });
    await expect(mainWindow.locator('[data-testid="ask-claude-btn"]')).toBeVisible();
    await expect(mainWindow.locator('[data-testid="settings-cog-btn"]')).toBeVisible();
  });

  test('KanbanBoard header shows the New Stack button', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="new-stack-btn"]', { timeout: 15000 });
    await expect(mainWindow.locator('[data-testid="new-stack-btn"]')).toBeVisible();
  });

  test('KanbanBoard renders empty-state placeholder or kanban columns', async ({ mainWindow }) => {
    // With no projects opened, the board shows the no-project placeholder.
    // With a project active, it shows the six kanban columns. Either is a
    // valid rendered state in the integration env.
    await mainWindow.waitForSelector('[data-testid="kanban-board"]', { timeout: 15000 });
    const noProject = mainWindow.locator('[data-testid="kanban-board-no-project"]');
    const columns = mainWindow.locator('[data-testid="kanban-columns"]');
    await expect(noProject.or(columns)).toBeVisible({ timeout: 15000 });
  });

  test('clicking New Stack opens the NewStackDialog', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="new-stack-btn"]', { timeout: 15000 });
    await mainWindow.click('[data-testid="new-stack-btn"]');

    await expect(mainWindow.locator('[data-testid="stack-name"]')).toBeVisible({ timeout: 5000 });
    await expect(mainWindow.locator('[data-testid="launch-btn"]')).toBeVisible();

    // Close dialog
    await mainWindow.click('text=Cancel');
    await expect(mainWindow.locator('[data-testid="stack-name"]')).not.toBeVisible({ timeout: 5000 });
  });

  test('can take a screenshot of the main view', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="left-rail"]', { timeout: 15000 });

    const screenshot = await mainWindow.screenshot();
    expect(screenshot).toBeTruthy();
    expect(screenshot.byteLength).toBeGreaterThan(0);
  });
});
