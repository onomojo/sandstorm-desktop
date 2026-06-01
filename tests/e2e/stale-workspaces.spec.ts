/**
 * E2E test for the stale-workspace cleanup modal (issue #414).
 *
 * The UI was orphaned after the kanban migration — Dashboard is unmounted.
 * This test verifies the full renderer→IPC→StackManager→filesystem path:
 *
 * 1. Arrange: register a project in the DB + create workspace dirs on disk
 *    (one orphaned, one for a completed-status stack).
 * 2. Act: trigger refreshStaleWorkspaces() from the renderer store.
 * 3. Assert: the modal appears and lists both workspaces.
 * 4. Assert: selecting + clicking cleanup removes the dirs from disk.
 * 5. Assert: the modal closes once all stale workspaces are gone.
 */
import path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

let app: ElectronApplication;

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['dist/main/index.js'],
  });
});

test.afterAll(async () => {
  await app?.close();
});

const RUN_ID = `stale414-${Date.now()}`;
const PROJECT_DIR = `/tmp/sandstorm-${RUN_ID}`;
const ORPHANED_STACK_ID = `orphaned-${RUN_ID}`;
const ORPHANED_WORKSPACE = path.join(
  PROJECT_DIR,
  '.sandstorm',
  'workspaces',
  ORPHANED_STACK_ID,
);
const COMPLETED_STACK_ID = `completed-${RUN_ID}`;
const COMPLETED_WORKSPACE = path.join(
  PROJECT_DIR,
  '.sandstorm',
  'workspaces',
  COMPLETED_STACK_ID,
);

/** Create the workspace dirs in the main (Node.js) process and register the project via IPC. */
async function seedStaleWorkspace(mainWindow: Page): Promise<void> {
  // filesystem ops run in the main process (renderer doesn't have Node.js 'fs')
  await app.evaluate((_electronCtx, args: { orphaned: string; completed: string }) => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const fs = require('fs') as typeof import('fs');
    /* eslint-enable @typescript-eslint/no-var-requires */
    fs.mkdirSync(args.orphaned, { recursive: true });
    fs.writeFileSync(`${args.orphaned}/dummy.txt`, 'stale workspace content');
    fs.mkdirSync(args.completed, { recursive: true });
    fs.writeFileSync(`${args.completed}/dummy.txt`, 'completed workspace content');
  }, { orphaned: ORPHANED_WORKSPACE, completed: COMPLETED_WORKSPACE });

  // Register the project via the real IPC so detectStaleWorkspaces() finds it
  await mainWindow.evaluate((dir: string) => {
    return (window as unknown as {
      sandstorm: { projects: { add: (d: string) => Promise<unknown> } };
    }).sandstorm.projects.add(dir);
  }, PROJECT_DIR);

  // Insert a completed-status stack row so detectStaleWorkspaces() flags it as stale
  await app.evaluate(({ app: electronApp }, args: { stackId: string; projectDir: string }) => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const nodePath = require('path') as typeof import('path');
    const Database = require('better-sqlite3') as new (p: string) => {
      prepare: (sql: string) => { run: (...args: unknown[]) => void };
      close: () => void;
    };
    /* eslint-enable @typescript-eslint/no-var-requires */
    const dbPath = nodePath.join(electronApp.getPath('userData'), 'sandstorm.db');
    const db = new Database(dbPath);
    db.prepare(
      `INSERT OR IGNORE INTO stacks (id, project, project_dir, status, runtime)
       VALUES (?, ?, ?, 'completed', 'docker')`
    ).run(args.stackId, nodePath.basename(args.projectDir), args.projectDir);
    db.close();
  }, { stackId: COMPLETED_STACK_ID, projectDir: PROJECT_DIR });
}

/** Remove workspace dirs and unregister the project to restore a clean state. */
async function teardownStaleWorkspace(mainWindow: Page): Promise<void> {
  // Remove the project dir tree from disk
  await app.evaluate((_electronCtx, projectDir: string) => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const fs = require('fs') as typeof import('fs');
    /* eslint-enable @typescript-eslint/no-var-requires */
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }, PROJECT_DIR);

  // Remove the registered project row and the completed stack row from SQLite
  await app.evaluate(({ app: electronApp }, args: { projectDir: string; completedStackId: string }) => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const nodePath = require('path') as typeof import('path');
    const Database = require('better-sqlite3') as new (p: string) => {
      prepare: (sql: string) => { run: (...args: unknown[]) => void };
      close: () => void;
    };
    /* eslint-enable @typescript-eslint/no-var-requires */
    const dbPath = nodePath.join(electronApp.getPath('userData'), 'sandstorm.db');
    const db = new Database(dbPath);
    db.prepare('DELETE FROM stacks WHERE id = ?').run(args.completedStackId);
    db.prepare('DELETE FROM projects WHERE directory = ?').run(args.projectDir);
    db.close();
  }, { projectDir: PROJECT_DIR, completedStackId: COMPLETED_STACK_ID });

  // Clear the renderer store so the stale state doesn't leak into subsequent tests
  await mainWindow.evaluate(() => {
    const store = (window as unknown as {
      __useAppStore: { setState: (s: Record<string, unknown>) => void };
    }).__useAppStore;
    store.setState({ staleWorkspaces: [], staleWorkspacesLoading: false });
  });
}

/** Call refreshStaleWorkspaces() in the renderer store and await the IPC response. */
async function triggerRefreshStaleWorkspaces(mainWindow: Page): Promise<void> {
  await mainWindow.evaluate(() => {
    const store = (window as unknown as {
      __useAppStore: {
        getState: () => { refreshStaleWorkspaces: () => Promise<void> };
      };
    }).__useAppStore;
    return store.getState().refreshStaleWorkspaces();
  });
}

test.describe('Stale workspaces modal (#414)', () => {
  test('modal appears when stale workspaces exist and cleans up on request', async () => {
    const mainWindow = await app.firstWindow();
    await mainWindow.waitForLoadState('domcontentloaded');
    await mainWindow.waitForSelector('[data-testid="kanban-board"]', { timeout: 15000 });
    await mainWindow.waitForFunction(
      () => Boolean((window as unknown as { __useAppStore?: unknown }).__useAppStore),
      { timeout: 15000 },
    );

    // Arrange: create orphaned workspace dir + register project + seed completed stack row
    await seedStaleWorkspace(mainWindow);

    try {
      // Act: trigger stale detection via the renderer store action
      await triggerRefreshStaleWorkspaces(mainWindow);

      // Assert: modal is visible and lists the orphaned workspace
      await expect(
        mainWindow.locator('[data-testid="stale-workspaces-modal"]'),
      ).toBeVisible({ timeout: 10000 });

      await expect(
        mainWindow.locator('[data-testid="stale-workspaces"]'),
      ).toBeVisible();

      await expect(
        mainWindow.locator('[data-testid="stale-workspace-row"]').first(),
      ).toBeVisible();

      // Both the orphaned directory and the completed-status stack must be listed
      await expect(
        mainWindow.locator('[data-testid="stale-workspace-row"]'),
      ).toHaveCount(2);

      // The orphaned stack ID must appear in the modal
      await expect(
        mainWindow.locator('[data-testid="stale-workspaces"]').getByText(ORPHANED_STACK_ID),
      ).toBeVisible();

      // The completed stack ID must also appear
      await expect(
        mainWindow.locator('[data-testid="stale-workspaces"]').getByText(COMPLETED_STACK_ID),
      ).toBeVisible();

      // Visual check — baseline snapshot of the reskinned modal
      await expect(
        mainWindow.locator('[data-testid="stale-workspaces-modal"]'),
      ).toHaveScreenshot('stale-workspaces-modal.png');

      // Override window.confirm so the native dialog doesn't block the test
      await mainWindow.evaluate(() => {
        window.confirm = () => true;
      });

      // Select all workspaces and click cleanup
      await mainWindow.locator('[data-testid="stale-select-all"]').check();
      const cleanupBtn = mainWindow.locator('[data-testid="stale-cleanup-btn"]');
      await expect(cleanupBtn).not.toBeDisabled();
      await cleanupBtn.click();

      // After cleanup, all stale workspaces are gone → modal closes
      await expect(
        mainWindow.locator('[data-testid="stale-workspaces-modal"]'),
      ).not.toBeVisible({ timeout: 15000 });

      // Workspace directory must be removed from disk
      const dirStillExists = await app.evaluate(
        (_electronCtx, workspacePath: string) => {
          /* eslint-disable @typescript-eslint/no-var-requires */
          const fs = require('fs') as typeof import('fs');
          /* eslint-enable @typescript-eslint/no-var-requires */
          return fs.existsSync(workspacePath);
        },
        ORPHANED_WORKSPACE,
      );
      expect(dirStillExists).toBe(false);
    } finally {
      await teardownStaleWorkspace(mainWindow);
    }
  });

  test('modal does not appear when no stale workspaces exist', async () => {
    const mainWindow = await app.firstWindow();
    await mainWindow.waitForLoadState('domcontentloaded');
    await mainWindow.waitForSelector('[data-testid="kanban-board"]', { timeout: 15000 });
    await mainWindow.waitForFunction(
      () => Boolean((window as unknown as { __useAppStore?: unknown }).__useAppStore),
      { timeout: 15000 },
    );

    // Ensure the store has no stale workspaces
    await mainWindow.evaluate(() => {
      const store = (window as unknown as {
        __useAppStore: { setState: (s: Record<string, unknown>) => void };
      }).__useAppStore;
      store.setState({ staleWorkspaces: [], staleWorkspacesLoading: false });
    });

    await expect(
      mainWindow.locator('[data-testid="stale-workspaces-modal"]'),
    ).not.toBeVisible({ timeout: 3000 });
  });

  test('modal dismisses for the session without deleting anything', async () => {
    const mainWindow = await app.firstWindow();
    await mainWindow.waitForLoadState('domcontentloaded');
    await mainWindow.waitForSelector('[data-testid="kanban-board"]', { timeout: 15000 });
    await mainWindow.waitForFunction(
      () => Boolean((window as unknown as { __useAppStore?: unknown }).__useAppStore),
      { timeout: 15000 },
    );

    // Inject a fake stale workspace directly into the store (no real filesystem ops needed)
    await mainWindow.evaluate(() => {
      const store = (window as unknown as {
        __useAppStore: { setState: (s: Record<string, unknown>) => void };
      }).__useAppStore;
      store.setState({
        staleWorkspaces: [
          {
            stackId: 'dismiss-test-stack-414',
            project: 'dismiss-test-project',
            projectDir: '/tmp/dismiss-test-414',
            workspacePath:
              '/tmp/dismiss-test-414/.sandstorm/workspaces/dismiss-test-stack-414',
            sizeBytes: 0,
            hasUnpushedChanges: false,
            reason: 'orphaned',
            lastModified: new Date().toISOString(),
          },
        ],
        staleWorkspacesLoading: false,
      });
    });

    // Modal should be visible
    await expect(
      mainWindow.locator('[data-testid="stale-workspaces-modal"]'),
    ).toBeVisible({ timeout: 5000 });

    // Click dismiss — sets the component-local dismissed state
    await mainWindow.locator('[data-testid="stale-dismiss-btn"]').click();

    // Modal disappears without deleting anything
    await expect(
      mainWindow.locator('[data-testid="stale-workspaces-modal"]'),
    ).not.toBeVisible({ timeout: 3000 });

    // Cleanup store state
    await mainWindow.evaluate(() => {
      const store = (window as unknown as {
        __useAppStore: { setState: (s: Record<string, unknown>) => void };
      }).__useAppStore;
      store.setState({ staleWorkspaces: [], staleWorkspacesLoading: false });
    });
  });
});
