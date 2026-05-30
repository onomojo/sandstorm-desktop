/**
 * Playwright e2e spec: create ticket → board seeding → card appears in Backlog.
 *
 * 1. Sets up a test project with ticket config in the main-process registry via
 *    app.evaluate(), using the real registry API (not raw SQL).
 * 2. Stubs the tickets:create IPC handler so no real provider call is needed —
 *    the stub calls registry.seedBoardTicket() exactly as the real handler does.
 * 3. Drives the full UI: activates the project, opens Create Ticket dialog,
 *    fills the form, submits.
 * 4. Asserts via DOM testids that the new card renders in the Backlog column
 *    without any manual refresh or project switch.
 * 5. Captures a screenshot for visual confirmation.
 */
import { test, expect, _electron as electron, ElectronApplication } from '@playwright/test';
import path from 'path';
import fs from 'fs';

let app: ElectronApplication;
const TEST_PROJECT_DIR = '/tmp/e2e-create-ticket-board';
const TICKET_ID = 'E2E-42';
let testProjectId: number;

test.beforeAll(async () => {
  fs.mkdirSync(TEST_PROJECT_DIR, { recursive: true });

  app = await electron.launch({ args: ['dist/main/index.cjs', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });

  // The renderer's mount fires refreshProjects() which calls projects:list — wait
  // for the main window's IPC handlers to be installed before reaching into the
  // main process. registerIpcHandlers() runs synchronously after createWindow()
  // in the app's whenReady().then() chain, so once we can see the left-rail in
  // the renderer (it issues IPC calls), the handlers exist.
  {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await expect(win.locator('[data-testid="left-rail"]')).toBeVisible({ timeout: 15000 });
  }

  // Set up test project and install the tickets:create stub in the main process.
  // All registry calls use the live registry instance (not raw SQL).
  //
  // app.evaluate() serializes the function and executes it in the main process's
  // global eval context, where neither `require` nor `process.mainModule` is
  // available (Node 20+ removed mainModule). We get `ipcMain` from Playwright's
  // first-arg (the Electron namespace), and reach the main module's exported
  // `registry` instance via the Module._cache lookup against the entry script's
  // absolute path.
  const normalizedProjectDir = path.resolve(TEST_PROJECT_DIR);
  const mainModulePath = path.resolve('dist/main/index.cjs');
  testProjectId = await app.evaluate(async ({ ipcMain }, { normalizedDir, mainPath }) => {
    type Reg = {
      addProject(dir: string, name: string): { id: number };
      setProjectTicketConfig(dir: string, cfg: { provider: string }): void;
      listProjects(): Array<{ id: number; directory: string }>;
      seedBoardTicket(ticketId: string, dir: string, title: string): void;
    };
    const Module = (process as { getBuiltinModule(name: string): unknown }).getBuiltinModule('module') as {
      _cache: Record<string, { exports: { registry: Reg } }>;
    };
    const entry = Module._cache[mainPath];
    if (!entry) {
      throw new Error(`Main module not found in Module._cache for ${mainPath}`);
    }
    const reg = entry.exports.registry;

    // Idempotent project setup: Electron's userData persists across worker
    // restarts, so a prior beforeAll run may have already inserted the row.
    const existing = reg.listProjects().find((p) => p.directory === normalizedDir);
    const project = existing ?? reg.addProject(normalizedDir, 'E2E Test Project');
    reg.setProjectTicketConfig(normalizedDir, { provider: 'github' });

    // Replace the IPC handler with a stub that skips the real provider call
    // but still calls registry.seedBoardTicket() — exactly as the real handler does.
    // The tickets:list handler (called by refreshBoardTickets after success) already
    // degrades gracefully when the provider is unreachable, so no stub is needed there.
    ipcMain.removeHandler('tickets:create');
    ipcMain.handle('tickets:create', async (_event: unknown, dir: string, title: string) => {
      const ticketId = 'E2E-42';
      reg.seedBoardTicket(ticketId, dir, title);
      return { ticketId, url: 'https://github.com/e2e-test/repo/issues/42' };
    });

    return project.id;
  }, { normalizedDir: normalizedProjectDir, mainPath: mainModulePath });

  // Reload the renderer — its useEffect calls refreshProjects() on mount which
  // picks up the new project via the projects:list IPC handler.
  const window = await app.firstWindow();
  await window.reload();
  await window.waitForLoadState('domcontentloaded');
  await expect(window.locator('[data-testid="left-rail"]')).toBeVisible({ timeout: 15000 });
});

test.afterAll(async () => {
  await app?.close();
  try { fs.rmSync(TEST_PROJECT_DIR, { recursive: true, force: true }); } catch {}
});

test('app launches and shows main UI', async () => {
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await expect(window.locator('[data-testid="left-rail"]')).toBeVisible({ timeout: 15000 });
});

test('Create Ticket dialog opens and has required testids', async () => {
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  // Activate the test project so the New Ticket button is rendered
  await window.locator(`[data-testid="workspace-pill-${testProjectId}"]`).click();
  await expect(window.locator('[data-testid="new-ticket-btn"]')).toBeVisible({ timeout: 5000 });

  // Open the Create Ticket dialog and verify all required testids are present
  await window.locator('[data-testid="new-ticket-btn"]').click();
  await expect(window.locator('[data-testid="create-ticket-dialog"]')).toBeVisible({ timeout: 5000 });
  await expect(window.locator('[data-testid="create-ticket-title"]')).toBeVisible();
  await expect(window.locator('[data-testid="create-ticket-body"]')).toBeVisible();
  await expect(window.locator('[data-testid="create-ticket-submit"]')).toBeVisible();

  // Close the dialog by clicking the backdrop (CreateTicketDialog only closes
  // on backdrop-click or the explicit X button — it does not handle Escape).
  // Wait for it to fully detach so the next test's clicks aren't intercepted.
  await window.locator('[data-testid="create-ticket-dialog"]').click({ position: { x: 5, y: 5 } });
  await expect(window.locator('[data-testid="create-ticket-dialog"]')).toBeHidden({ timeout: 5000 });
});

test('tickets:create IPC handler seeds board and card appears in Backlog column without refresh', async () => {
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  // Activate the test project
  await window.locator(`[data-testid="workspace-pill-${testProjectId}"]`).click();
  await expect(window.locator('[data-testid="new-ticket-btn"]')).toBeVisible({ timeout: 5000 });

  // Open the Create Ticket dialog
  await window.locator('[data-testid="new-ticket-btn"]').click();
  await expect(window.locator('[data-testid="create-ticket-dialog"]')).toBeVisible({ timeout: 5000 });

  // Fill in the form
  await window.locator('[data-testid="create-ticket-title"]').fill('E2E Backlog Seeding Test');
  await window.locator('[data-testid="create-ticket-body"]').fill(
    'Verify ticket appears in Backlog immediately after creation.'
  );

  // Submit — calls the stubbed tickets:create IPC handler, which calls
  // registry.seedBoardTicket() then returns { ticketId: 'E2E-42', url }.
  // The renderer then calls refreshBoardTickets() (fire-and-forget) which
  // invokes tickets:list; that handler returns the seeded row from the local DB
  // even when the provider fetch fails (graceful degradation).
  await window.locator('[data-testid="create-ticket-submit"]').click();

  // Success state in the dialog confirms the IPC round-trip completed
  await expect(window.locator('[data-testid="create-ticket-success"]')).toBeVisible({ timeout: 10000 });

  // Close the dialog via backdrop click (Escape is not handled by this dialog)
  await window.locator('[data-testid="create-ticket-dialog"]').click({ position: { x: 5, y: 5 } });
  await expect(window.locator('[data-testid="create-ticket-dialog"]')).toBeHidden({ timeout: 5000 });

  // The Backlog column must now contain the new card — no project switch or
  // manual refresh required.
  await expect(window.locator('[data-testid="kanban-column-backlog"]')).toBeVisible({ timeout: 5000 });
  await expect(window.locator(`[data-testid="ticket-card-${TICKET_ID}"]`)).toBeVisible({ timeout: 5000 });

  // Screenshot for visual confirmation of the board state after creation
  const screenshotDir = path.join('tests', 'integration', 'screenshots');
  fs.mkdirSync(screenshotDir, { recursive: true });
  await window.screenshot({ path: path.join(screenshotDir, 'create-ticket-board.png') });
});

test('ticket seeded in backlog does not change column on re-seed (UPSERT preserves column)', async () => {
  const projectDir = path.resolve('/tmp/integration-test-proj-2');
  const ticketId = 'INTTEST-2';
  const mainModulePath = path.resolve('dist/main/index.cjs');

  const result = await app.evaluate(async (_electron, { projectDir, ticketId, mainPath }) => {
    type MainExports = { registry: {
      seedBoardTicket(ticketId: string, dir: string, title: string): void;
      setBoardTicketColumn(ticketId: string, dir: string, column: string): void;
      listBoardTickets(dir: string): Array<{ ticket_id: string; column: string; title: string }>;
    } };
    const Module = (process as { getBuiltinModule(name: string): unknown }).getBuiltinModule('module') as {
      _cache: Record<string, { exports: MainExports }>;
    };
    const { registry } = Module._cache[mainPath].exports;

    // Seed at backlog
    registry.seedBoardTicket(ticketId, projectDir, 'Original title');

    // Simulate user moving to spec_ready
    registry.setBoardTicketColumn(ticketId, projectDir, 'spec_ready');

    // Re-seed (as would happen on tickets:list or a second create with same ID)
    registry.seedBoardTicket(ticketId, projectDir, 'Updated title');

    const rows = registry.listBoardTickets(projectDir);
    return rows.filter((r) => r.ticket_id === ticketId);
  }, { projectDir, ticketId, mainPath: mainModulePath });

  const row = (result as Array<{ ticket_id: string; column: string; title: string }>)[0];
  expect(row.column).toBe('spec_ready');
  expect(row.title).toBe('Updated title');
});
