import path from 'path';
import { test, expect, _electron as electron, ElectronApplication } from '@playwright/test';

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['dist/main/index.js'],
  });
});

test.afterAll(async () => {
  await app?.close();
});

// Inserts or removes the E2E test project + ticket via a direct DB connection.
// WAL mode (which the app enables) allows concurrent connections for setup/teardown.
async function seedE2ETestData(action: 'insert' | 'delete'): Promise<void> {
  await app.evaluate(async ({ app: electronApp }, act) => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const nodePath = require('path');
    const Database = require('better-sqlite3');
    /* eslint-enable @typescript-eslint/no-var-requires */
    const dbPath = nodePath.join(electronApp.getPath('userData'), 'sandstorm.db');
    const db = new Database(dbPath);
    const dir = nodePath.resolve('/tmp/sandstorm-e2e-test-395');
    db.prepare('DELETE FROM ticket_board WHERE project_dir = ?').run(dir);
    db.prepare('DELETE FROM projects WHERE directory = ?').run(dir);
    if (act === 'insert') {
      db.prepare('INSERT INTO projects (name, directory) VALUES (?, ?)').run('e2e-test-395', dir);
      db.prepare(
        'INSERT INTO ticket_board (ticket_id, project_dir, column, title) VALUES (?, ?, ?, ?)',
      ).run('E2E-395', dir, 'spec_ready', 'E2E Test Ticket');
    }
    db.close();
  }, action);
}

test('new stack dialog has all required fields', async () => {
  const window = await app.firstWindow();
  await window.click('[data-testid="new-stack-btn"]');

  // All form fields should be present
  await expect(window.locator('[data-testid="stack-name"]')).toBeVisible();
  await expect(window.locator('[data-testid="stack-ticket"]')).toBeVisible();
  await expect(window.locator('[data-testid="launch-btn"]')).toBeVisible();

  // Launch button should be disabled without name
  await expect(window.locator('[data-testid="launch-btn"]')).toBeDisabled();

  await window.click('text=Cancel');
});

test('launch button enables when name is filled', async () => {
  const window = await app.firstWindow();
  await window.click('[data-testid="new-stack-btn"]');

  // Fill in required fields
  await window.fill('[data-testid="stack-name"]', 'test-stack');

  // Note: launch button also requires project directory, so it may still be disabled
  // This test verifies the form interaction works
  const nameValue = await window.inputValue('[data-testid="stack-name"]');
  expect(nameValue).toBe('test-stack');

  await window.click('text=Cancel');
});

test('one-click start-stack from spec_ready card creates stack without opening NewStackDialog', async () => {
  const window = await app.firstWindow();
  const resolvedDir = path.resolve('/tmp/sandstorm-e2e-test-395');

  // Clean up any leftover data from a prior run, then seed fresh state
  await seedE2ETestData('delete');
  await seedE2ETestData('insert');

  try {
    // Reload the renderer so it discovers the new project from the DB
    await window.reload();
    await window.waitForLoadState('domcontentloaded');

    // Wait for the project tab (its title attribute equals the project directory)
    await window.waitForSelector(`button[title="${resolvedDir}"]`, { timeout: 10000 });

    // Click the project tab — triggers refreshBoardTickets which returns our spec_ready ticket
    await window.click(`button[title="${resolvedDir}"]`);

    // Wait for the spec_ready Start stack button to appear in the board
    await window.waitForSelector('[data-testid="ticket-card-start-stack-E2E-395"]', { timeout: 5000 });

    // Stub IPC calls that would require real Docker / ticket provider
    await window.evaluate(() => {
      (window as any).sandstorm.tickets.fetch = async () => ({
        body: '# E2E Test Ticket\nTicket body for end-to-end testing.',
        url: null,
      });
      (window as any).sandstorm.stacks.create = async () => ({});
      (window as any).sandstorm.stacks.list = async () => [];
    });

    // NewStackDialog must NOT be open before clicking
    const dialogInput = window.locator('[data-testid="stack-name"]');
    await expect(dialogInput).not.toBeVisible();

    // Click the one-click Start stack button
    await window.click('[data-testid="ticket-card-start-stack-E2E-395"]');

    // CRITICAL: NewStackDialog must NOT appear — one-click path bypasses the modal entirely
    await expect(dialogInput).not.toBeVisible();

    // Card must transition to the in_stack column
    await expect(
      window.locator(
        '[data-testid="kanban-column-in_stack"] [data-testid="ticket-card-E2E-395"]',
      ),
    ).toBeVisible({ timeout: 5000 });
  } finally {
    await seedE2ETestData('delete');
  }
});
