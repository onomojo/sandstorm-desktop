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

  test('visual: recovered-to-terminal card shows terminal status and Create PR affordance', async ({ electronApp, mainWindow }) => {
    // Simulate a stack that was recovered by the startup reconciler to 'completed'.
    // Seeds: project + ticket in 'in_stack' column + linked completed stack (no PR yet).
    // The TicketCard renders a "Create PR" button when the linked stack is PR-eligible.
    const testDir = '/tmp/sandstorm-visual-terminal-404';
    const ticketId = 'VISUAL-TERMINAL-404';
    const stackId = 'visual-terminal-stack-404';

    try {
      const projectId = await electronApp.evaluate(
        async ({}, params) => {
          const { registry } = (globalThis as any).__sandstorm;

          // Clean up any leftover rows from a previous run
          if (registry.getStack(params.stackId)) registry.deleteStack(params.stackId);
          const existingProject = registry.listProjects().find(
            (p: { directory: string }) => p.directory === params.testDir,
          );
          if (existingProject) registry.removeProject(existingProject.id);
          // Move any leftover in_stack ticket to backlog so it can be bulk-deleted
          for (const t of registry.listBoardTickets(params.testDir)) {
            registry.setBoardTicketColumn(t.ticket_id, params.testDir, 'backlog');
          }
          registry.deleteClosedEarlyColumnTickets(params.testDir, []);

          // Seed project
          const project = registry.addProject(params.testDir, 'visual-test-terminal');

          // Seed ticket in 'in_stack' column (card is in the IN STACK column)
          registry.seedBoardTicket(params.ticketId, params.testDir, 'Reconciler Visual Test Ticket');
          registry.setBoardTicketColumn(params.ticketId, params.testDir, 'in_stack');

          // Seed the stack as 'completed' with no PR URL — this triggers the
          // "Create PR" button in TicketCard (makePrEligible check).
          registry.createStack({
            id: params.stackId,
            project: 'visual-test-terminal',
            project_dir: params.testDir,
            ticket: params.ticketId,
            branch: 'main',
            description: null,
            status: 'completed',
            runtime: 'docker',
          });

          return project.id;
        },
        { testDir, ticketId, stackId },
      );

      // Reload so the renderer picks up the newly seeded project + ticket
      await mainWindow.reload();
      await mainWindow.waitForLoadState('domcontentloaded');

      // Click the project tab to activate the project and load the board.
      // LeftRail renders workspace pills as data-testid="workspace-pill-${proj.id}".
      await mainWindow.waitForSelector(`[data-testid="workspace-pill-${projectId}"]`, { timeout: 10000 });
      await mainWindow.click(`[data-testid="workspace-pill-${projectId}"]`);

      // The TicketCard in 'in_stack' should show "Create PR" for a completed stack
      await mainWindow.waitForSelector(
        `[data-testid="ticket-card-create-pr-${ticketId}"]`,
        { timeout: 10000 },
      );
      await expect(
        mainWindow.locator(`[data-testid="ticket-card-create-pr-${ticketId}"]`),
      ).toBeVisible();
      await expect(
        mainWindow.locator(`[data-testid="ticket-card-create-pr-${ticketId}"]`),
      ).toContainText('Create PR');

      // Also verify the stack status label shows in the card
      await expect(
        mainWindow.locator(`[data-testid="ticket-card-${ticketId}"]`),
      ).toContainText('completed');

      // Capture the visual snapshot
      const screenshot = await mainWindow.screenshot();
      expect(screenshot).toBeTruthy();
      expect(screenshot.byteLength).toBeGreaterThan(0);
    } finally {
      await electronApp.evaluate(
        async ({}, params) => {
          const { registry } = (globalThis as any).__sandstorm;
          // Move all tickets for this dir to backlog so bulk-delete handles them
          for (const t of registry.listBoardTickets(params.testDir)) {
            registry.setBoardTicketColumn(t.ticket_id, params.testDir, 'backlog');
          }
          registry.deleteClosedEarlyColumnTickets(params.testDir, []);
          if (registry.getStack(params.stackId)) registry.deleteStack(params.stackId);
          const proj = registry.listProjects().find(
            (p: { directory: string }) => p.directory === params.testDir,
          );
          if (proj) registry.removeProject(proj.id);
        },
        { testDir, stackId },
      );
    }
  });

  test('visual: board after branch-5 open-ticket recovery shows ticket in backlog', async ({ electronApp, mainWindow }) => {
    // Simulate the outcome of branch-5 reconciliation for an OPEN ticket:
    // the dead stack has been removed and the ticket moved back to 'backlog'.
    // Seeds: project + ticket in 'backlog' column (no linked stack — stack was deleted).
    const testDir = '/tmp/sandstorm-visual-backlog-404';
    const ticketId = 'VISUAL-BACKLOG-404';

    try {
      const projectId = await electronApp.evaluate(
        async ({}, params) => {
          const { registry } = (globalThis as any).__sandstorm;

          // Clean up any leftover rows
          registry.deleteClosedEarlyColumnTickets(params.testDir, []);
          const existingProject = registry.listProjects().find(
            (p: { directory: string }) => p.directory === params.testDir,
          );
          if (existingProject) registry.removeProject(existingProject.id);

          // Seed project
          const project = registry.addProject(params.testDir, 'visual-test-backlog');

          // Seed ticket in 'backlog' — this is the result of branch-5 (OPEN ticket:
          // dead stack removed + ticket column set to 'backlog' by setBoardTicketColumn).
          registry.seedBoardTicket(params.ticketId, params.testDir, 'Recovered Ticket (Branch-5 OPEN)');

          return project.id;
        },
        { testDir, ticketId },
      );

      // Reload and navigate to the project
      await mainWindow.reload();
      await mainWindow.waitForLoadState('domcontentloaded');

      // LeftRail renders workspace pills as data-testid="workspace-pill-${proj.id}".
      await mainWindow.waitForSelector(`[data-testid="workspace-pill-${projectId}"]`, { timeout: 10000 });
      await mainWindow.click(`[data-testid="workspace-pill-${projectId}"]`);

      // The backlog column should show the ticket with a Refine button
      await mainWindow.waitForSelector(
        `[data-testid="kanban-column-backlog"] [data-testid="ticket-card-${ticketId}"]`,
        { timeout: 10000 },
      );
      await expect(
        mainWindow.locator(`[data-testid="kanban-column-backlog"] [data-testid="ticket-card-${ticketId}"]`),
      ).toBeVisible();

      // The 'in_stack' column must NOT contain this ticket (it was removed by branch-5)
      await expect(
        mainWindow.locator(`[data-testid="kanban-column-in_stack"] [data-testid="ticket-card-${ticketId}"]`),
      ).not.toBeVisible();

      // Capture the visual snapshot of the board after branch-5 recovery
      const screenshot = await mainWindow.screenshot();
      expect(screenshot).toBeTruthy();
      expect(screenshot.byteLength).toBeGreaterThan(0);
    } finally {
      await electronApp.evaluate(
        async ({}, params) => {
          const { registry } = (globalThis as any).__sandstorm;
          registry.deleteClosedEarlyColumnTickets(params.testDir, []);
          const proj = registry.listProjects().find(
            (p: { directory: string }) => p.directory === params.testDir,
          );
          if (proj) registry.removeProject(proj.id);
        },
        { testDir },
      );
    }
  });
});
