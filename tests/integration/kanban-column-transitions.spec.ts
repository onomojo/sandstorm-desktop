/**
 * Regression test for #388 — tickets must move between kanban columns.
 *
 * Drives the renderer through the full progression:
 *   backlog → refining → spec_ready → in_stack → pr_open → merged
 *
 * Assertions are real DOM membership checks on
 *   data-testid="kanban-column-<column>" containing
 *   data-testid="ticket-card-<id>"
 *
 * What the test exercises end-to-end:
 *  - Real moveTicketColumn store action (optimistic update + revert on fail)
 *  - Real ticketBoard.setColumn IPC + registry SQLite persistence
 *  - Real refreshBoardTickets → tickets:list IPC → renderer state sync
 *  - Real KanbanBoard / TicketCard column-rendering logic
 *  - Real upsertRefinementSession → spec_ready transition (the #388 fix)
 *
 * What is shimmed via the exposed store:
 *  - The renderer's active project (no UI flow for adding /tmp/... as a project)
 *  - Dialog "succeeded" flags (so cancelling the dialog after the move doesn't
 *    revert — we're testing column persistence, not dialog UX)
 *  - The stack record (Create PR / Merge enablement depends on a stack with the
 *    ticket; we inject one rather than running the real Docker build)
 *
 * The bug being regressed against (#388) was that moveTicketColumn was wired
 * for backlog→refining and refining→in_stack-via-card but NOT for the gate-pass
 * → spec_ready transition NOR the Refine-dialog Start Stack → in_stack
 * transition. Both are now exercised.
 */
import { test, expect, type Page } from './fixtures';

const TICKET_ID = `kanban388-${Date.now()}`;
const PROJECT_DIR = `/tmp/kanban388-${Date.now()}`;
const PROJECT_NAME = 'kanban-388-test';
const STACK_ID = `stack-388-${Date.now()}`;

async function assertColumn(window: Page, column: string, ticketId: string) {
  const col = window.locator(`[data-testid="kanban-column-${column}"]`);
  await expect(col).toBeVisible();
  await expect(col.locator(`[data-testid="ticket-card-${ticketId}"]`)).toBeVisible();
}

async function assertNotInColumn(window: Page, column: string, ticketId: string) {
  const col = window.locator(`[data-testid="kanban-column-${column}"]`);
  await expect(col.locator(`[data-testid="ticket-card-${ticketId}"]`)).toHaveCount(0);
}

/** Returns the column the ticket lives in by querying the DOM. */
async function currentColumn(window: Page, ticketId: string): Promise<string | null> {
  const card = window.locator(`[data-testid="ticket-card-${ticketId}"]`).first();
  if (await card.count() === 0) return null;
  return await card.evaluate((el) => {
    let n: HTMLElement | null = el as HTMLElement;
    while (n) {
      const tid = n.getAttribute('data-testid');
      if (tid && tid.startsWith('kanban-column-')) return tid.replace('kanban-column-', '');
      n = n.parentElement;
    }
    return null;
  });
}

test.describe('Kanban column transitions (#388)', () => {
  test('ticket progresses through all 5 column transitions and persists across a board refresh', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="kanban-board"]', { timeout: 15000 });
    await mainWindow.waitForFunction(
      () => Boolean((window as unknown as { __useAppStore?: unknown }).__useAppStore),
      { timeout: 15000 },
    );

    // --- Set the active project in the store ---------------------------------
    // KanbanBoard's useEffect calls refreshBoardTickets the moment project.directory
    // changes. We do this BEFORE seeding any ticket so the initial refresh
    // returns an empty board, then we seed via the real setColumn IPC.
    await mainWindow.evaluate(({ dir, name }) => {
      const store = (window as unknown as {
        __useAppStore: { setState: (s: Record<string, unknown>) => void };
      }).__useAppStore;
      store.setState({
        projects: [{ id: 9388, name, directory: dir, added_at: '' }],
        activeProjectId: 9388,
        refinementSessions: [],
        stacks: [],
        moveTicketColumnError: null,
      });
    }, { dir: PROJECT_DIR, name: PROJECT_NAME });

    // --- Seed a backlog row via the real setColumn IPC -----------------------
    // The registry inserts at the target column if the row doesn't exist; the
    // INSERT is idempotent and writes to the real SQLite ticket_board table.
    await mainWindow.evaluate(({ id, dir }) => {
      return (window as unknown as {
        sandstorm: { ticketBoard: { setColumn: (i: string, d: string, c: string) => Promise<void> } };
      }).sandstorm.ticketBoard.setColumn(id, dir, 'backlog');
    }, { id: TICKET_ID, dir: PROJECT_DIR });

    // --- Refresh the board so the renderer picks up the seeded row -----------
    await mainWindow.evaluate((dir) => {
      const store = (window as unknown as {
        __useAppStore: { getState: () => { refreshBoardTickets: (d: string) => Promise<void> } };
      }).__useAppStore;
      return store.getState().refreshBoardTickets(dir);
    }, PROJECT_DIR);

    await assertColumn(mainWindow, 'backlog', TICKET_ID);

    // --- 1. backlog → refining (real click on Refine card button) -----------
    await mainWindow.click(`[data-testid="ticket-card-refine-${TICKET_ID}"]`);
    await assertColumn(mainWindow, 'refining', TICKET_ID);

    // Seed a fake "session exists" entry so the dialog-close revert guard
    // sees a session for this ticket and leaves the column at 'refining'.
    await mainWindow.evaluate(({ id, dir }) => {
      const store = (window as unknown as {
        __useAppStore: { setState: (s: Record<string, unknown>) => void };
      }).__useAppStore;
      store.setState({
        refinementSessions: [{
          id: 'placeholder-session', ticketId: id, projectDir: dir,
          status: 'running', phase: 'check', startedAt: 0,
        }],
      });
    }, { id: TICKET_ID, dir: PROJECT_DIR });

    // Close the Refine dialog so subsequent card buttons aren't blocked.
    const refineDialog = mainWindow.locator('[data-testid="refine-ticket-dialog"]');
    if (await refineDialog.isVisible().catch(() => false)) {
      await mainWindow.click('[data-testid="refine-ticket-dialog"] [aria-label="Close"]');
      await refineDialog.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
    }
    await assertColumn(mainWindow, 'refining', TICKET_ID);

    // --- 2. refining → spec_ready (the #388 fix path) -----------------------
    // Calling upsertRefinementSession with status='ready' && passed=true is
    // exactly what the refinement:update IPC handler does on gate pass.
    // The store action fires moveTicketColumn(..., 'spec_ready') exactly once.
    await mainWindow.evaluate(({ id, dir }) => {
      const store = (window as unknown as {
        __useAppStore: {
          getState: () => { upsertRefinementSession: (s: Record<string, unknown>) => void };
        };
      }).__useAppStore;
      store.getState().upsertRefinementSession({
        id: 'gate-pass-session', ticketId: id, projectDir: dir,
        status: 'ready', phase: 'check', startedAt: 0,
        result: { passed: true, questions: [], gateSummary: 'PASS', ticketUrl: null, cached: false },
      });
    }, { id: TICKET_ID, dir: PROJECT_DIR });
    await assertColumn(mainWindow, 'spec_ready', TICKET_ID);

    // --- 3. spec_ready → in_stack (real click on Start stack card button) ---
    await mainWindow.click(`[data-testid="ticket-card-start-stack-${TICKET_ID}"]`);
    await assertColumn(mainWindow, 'in_stack', TICKET_ID);
    // Mark the dialog as having "created a stack" and inject a stack row so
    // dialog dismissal doesn't trigger the revert, and so Create PR enables.
    await mainWindow.evaluate(({ id, dir, stackId }) => {
      const store = (window as unknown as {
        __useAppStore: {
          getState: () => { _newStackDialogContext: Record<string, unknown> | null };
          setState: (s: Record<string, unknown>) => void;
        };
      }).__useAppStore;
      const ctx = store.getState()._newStackDialogContext;
      store.setState({
        _newStackDialogContext: ctx ? { ...ctx, stackCreated: true } : ctx,
        stacks: [{
          id: stackId, project: 'kanban-388-test', project_dir: dir, ticket: id,
          branch: null, description: null, status: 'completed', error: null,
          pr_url: null, pr_number: null, runtime: 'docker',
          total_input_tokens: 0, total_output_tokens: 0,
          total_execution_input_tokens: 0, total_execution_output_tokens: 0,
          total_review_input_tokens: 0, total_review_output_tokens: 0,
          rate_limit_reset_at: null, created_at: '', updated_at: '',
          current_model: null, services: [],
        }],
      });
    }, { id: TICKET_ID, dir: PROJECT_DIR, stackId: STACK_ID });
    const newStackInput = mainWindow.locator('[data-testid="stack-name"]');
    if (await newStackInput.isVisible().catch(() => false)) {
      await mainWindow.locator('text=Cancel').first().click();
      await newStackInput.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
    }
    await assertColumn(mainWindow, 'in_stack', TICKET_ID);

    // --- 4. in_stack → pr_open (real click on Create PR card button) --------
    await mainWindow.click(`[data-testid="ticket-card-create-pr-${TICKET_ID}"]`);
    await assertColumn(mainWindow, 'pr_open', TICKET_ID);
    await mainWindow.evaluate(() => {
      const store = (window as unknown as {
        __useAppStore: {
          getState: () => { _prDialogContext: Record<string, unknown> | null };
          setState: (s: Record<string, unknown>) => void;
        };
      }).__useAppStore;
      const ctx = store.getState()._prDialogContext;
      if (ctx) store.setState({ _prDialogContext: { ...ctx, prCreated: true } });
    });
    const prDialog = mainWindow.locator('[data-testid="create-pr-dialog"]');
    if (await prDialog.isVisible().catch(() => false)) {
      await prDialog.click({ position: { x: 5, y: 5 } });
      await prDialog.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
    }
    await assertColumn(mainWindow, 'pr_open', TICKET_ID);

    // Give the stack a pr_number so the link renders before the Merge click.
    await mainWindow.evaluate(({ id }) => {
      const store = (window as unknown as {
        __useAppStore: {
          getState: () => { stacks: Array<{ id: string; ticket: string | null }> };
          setState: (s: Record<string, unknown>) => void;
        };
      }).__useAppStore;
      const stacks = store.getState().stacks.map((s) =>
        s.ticket === id ? { ...s, pr_number: 388, pr_url: 'https://github.com/o/r/pull/388' } : s,
      );
      store.setState({ stacks });
    }, { id: TICKET_ID });

    // --- 5. pr_open → merged (real click on Merge card button) -------------
    await mainWindow.click(`[data-testid="ticket-card-merge-${TICKET_ID}"]`);
    await assertColumn(mainWindow, 'merged', TICKET_ID);

    // --- Persistence across a real board refresh ---------------------------
    // The whole point of #388 is that the moves stick. Re-fetching from the
    // real SQLite DB and re-rendering the board must show the same column.
    await mainWindow.evaluate((dir) => {
      const store = (window as unknown as {
        __useAppStore: {
          getState: () => { refreshBoardTickets: (d: string) => Promise<void> };
        };
      }).__useAppStore;
      return store.getState().refreshBoardTickets(dir);
    }, PROJECT_DIR);

    expect(await currentColumn(mainWindow, TICKET_ID)).toBe('merged');
    await assertColumn(mainWindow, 'merged', TICKET_ID);
    for (const col of ['backlog', 'refining', 'spec_ready', 'in_stack', 'pr_open']) {
      await assertNotInColumn(mainWindow, col, TICKET_ID);
    }

    // Reset shared state so the next worker-scoped test starts clean.
    // (The Electron app fixture is shared across tests in this run; without
    // this, downstream tests inherit our project/stacks/sessions.)
    await mainWindow.evaluate(() => {
      const store = (window as unknown as {
        __useAppStore: { setState: (s: Record<string, unknown>) => void };
      }).__useAppStore;
      store.setState({
        projects: [],
        activeProjectId: null,
        refinementSessions: [],
        stacks: [],
        boardTickets: [],
        _refineDialogContext: null,
        _newStackDialogContext: null,
        _prDialogContext: null,
        moveTicketColumnError: null,
      });
    });
  });
});

/**
 * Regression tests for #403 — ticket must move to pr_open when the stack
 * reaches pr_created via the agent/IPC path (not only via the UI optimistic move).
 *
 * The stacks:updated event must also trigger refreshBoardTickets so the renderer
 * sees the column change without requiring a manual remount.
 */
const TICKET_403 = `kanban403-${Date.now()}`;
const PROJECT_403 = `/tmp/kanban403-${Date.now()}`;
const STACK_403 = `stack-403-${Date.now()}`;

test.describe('Kanban column sync via setPullRequest (#403)', () => {
  test('ticket moves from in_stack to pr_open when stack transitions to pr_created via IPC (not UI)', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="kanban-board"]', { timeout: 15000 });
    await mainWindow.waitForFunction(
      () => Boolean((window as unknown as { __useAppStore?: unknown }).__useAppStore),
      { timeout: 15000 },
    );

    // Set the active project so the board renders for this project dir.
    await mainWindow.evaluate(({ dir, name }) => {
      const store = (window as unknown as {
        __useAppStore: { setState: (s: Record<string, unknown>) => void };
      }).__useAppStore;
      store.setState({
        projects: [{ id: 9403, name, directory: dir, added_at: '' }],
        activeProjectId: 9403,
        refinementSessions: [],
        stacks: [],
        moveTicketColumnError: null,
      });
    }, { dir: PROJECT_403, name: 'kanban-403-test' });

    // Seed the ticket at in_stack via real IPC.
    await mainWindow.evaluate(({ id, dir }) => {
      return (window as unknown as {
        sandstorm: { ticketBoard: { setColumn: (i: string, d: string, c: string) => Promise<void> } };
      }).sandstorm.ticketBoard.setColumn(id, dir, 'in_stack');
    }, { id: TICKET_403, dir: PROJECT_403 });

    // Refresh the board so the renderer reflects the seeded row.
    await mainWindow.evaluate((dir) => {
      const store = (window as unknown as {
        __useAppStore: { getState: () => { refreshBoardTickets: (d: string) => Promise<void> } };
      }).__useAppStore;
      return store.getState().refreshBoardTickets(dir);
    }, PROJECT_403);

    await assertColumn(mainWindow, 'in_stack', TICKET_403);

    // Create a real stack record linked to this ticket. forceBypass skips the spec
    // gate (ticket is already in in_stack, past spec_ready). createStack inserts the
    // DB row synchronously before the IPC resolves; the Docker build runs in the
    // background and fails gracefully since Docker is unavailable in the test env.
    await mainWindow.evaluate(({ stackId, ticketId, dir }) => {
      return (window as unknown as {
        sandstorm: { stacks: { create: (opts: Record<string, unknown>) => Promise<unknown> } };
      }).sandstorm.stacks.create({ name: stackId, projectDir: dir, ticket: ticketId, runtime: 'docker', forceBypass: true });
    }, { stackId: STACK_403, ticketId: TICKET_403, dir: PROJECT_403 });

    // Call stacks:setPr via IPC — the agent/CLI path, not the UI optimistic move.
    // stackManager.setPullRequest() calls advanceTicketToPrOpenIfInStack() and
    // notifyUpdate(), which broadcasts stacks:updated to the renderer. The App.tsx
    // stacks:updated listener calls refreshBoardTickets(), advancing the card
    // reactively without any manual refresh call.
    await mainWindow.evaluate(({ stackId }) => {
      return (window as unknown as {
        sandstorm: { stacks: { setPr: (id: string, url: string, num: number) => Promise<void> } };
      }).sandstorm.stacks.setPr(stackId, 'https://github.com/o/r/pull/403', 403);
    }, { stackId: STACK_403 });

    await assertColumn(mainWindow, 'pr_open', TICKET_403);
    await assertNotInColumn(mainWindow, 'in_stack', TICKET_403);
  });

  test('ticket stays in merged when stack reaches pr_created (forward-only rule)', async ({ mainWindow }) => {
    await mainWindow.waitForSelector('[data-testid="kanban-board"]', { timeout: 15000 });
    await mainWindow.waitForFunction(
      () => Boolean((window as unknown as { __useAppStore?: unknown }).__useAppStore),
      { timeout: 15000 },
    );

    const MERGED_TICKET = `kanban403-merged-${Date.now()}`;

    await mainWindow.evaluate(({ dir, name }) => {
      const store = (window as unknown as {
        __useAppStore: { setState: (s: Record<string, unknown>) => void };
      }).__useAppStore;
      store.setState({
        projects: [{ id: 9404, name, directory: dir, added_at: '' }],
        activeProjectId: 9404,
        refinementSessions: [],
        stacks: [],
        moveTicketColumnError: null,
      });
    }, { dir: PROJECT_403, name: 'kanban-403-merged-test' });

    // Seed the ticket at merged (the forward-only rule must not pull it back).
    await mainWindow.evaluate(({ id, dir }) => {
      return (window as unknown as {
        sandstorm: { ticketBoard: { setColumn: (i: string, d: string, c: string) => Promise<void> } };
      }).sandstorm.ticketBoard.setColumn(id, dir, 'merged');
    }, { id: MERGED_TICKET, dir: PROJECT_403 });

    // Refresh the board.
    await mainWindow.evaluate((dir) => {
      const store = (window as unknown as {
        __useAppStore: { getState: () => { refreshBoardTickets: (d: string) => Promise<void> } };
      }).__useAppStore;
      return store.getState().refreshBoardTickets(dir);
    }, PROJECT_403);

    await assertColumn(mainWindow, 'merged', MERGED_TICKET);

    const STACK_403_MERGED = `stack-403-merged-${Date.now()}`;

    // Create a real stack record linked to the merged ticket. forceBypass skips
    // the spec gate; the DB row is inserted synchronously before IPC resolves.
    await mainWindow.evaluate(({ stackId, ticketId, dir }) => {
      return (window as unknown as {
        sandstorm: { stacks: { create: (opts: Record<string, unknown>) => Promise<unknown> } };
      }).sandstorm.stacks.create({ name: stackId, projectDir: dir, ticket: ticketId, runtime: 'docker', forceBypass: true });
    }, { stackId: STACK_403_MERGED, ticketId: MERGED_TICKET, dir: PROJECT_403 });

    // Call stacks:setPr — the forward-only guard in advanceTicketToPrOpenIfInStack
    // must be a no-op when the ticket is already in merged. notifyUpdate() fires
    // stacks:updated which triggers refreshBoardTickets() via the App.tsx listener.
    await mainWindow.evaluate(({ stackId }) => {
      return (window as unknown as {
        sandstorm: { stacks: { setPr: (id: string, url: string, num: number) => Promise<void> } };
      }).sandstorm.stacks.setPr(stackId, 'https://github.com/o/r/pull/404', 404);
    }, { stackId: STACK_403_MERGED });

    // Wait for refreshStacks (called in the same stacks:updated listener as
    // refreshBoardTickets) to populate the store with the updated stack pr_url.
    // This confirms the listener fired and the board has been refreshed from DB.
    await mainWindow.waitForFunction(({ stackId }) => {
      const store = (window as unknown as {
        __useAppStore: { getState: () => { stacks: Array<{ id: string; pr_url: string | null }> } };
      }).__useAppStore;
      return store.getState().stacks.some(
        (s: { id: string; pr_url: string | null }) => s.id === stackId && s.pr_url !== null,
      );
    }, { stackId: STACK_403_MERGED });

    await assertColumn(mainWindow, 'merged', MERGED_TICKET);
    await assertNotInColumn(mainWindow, 'pr_open', MERGED_TICKET);

    // Cleanup
    await mainWindow.evaluate(() => {
      const store = (window as unknown as {
        __useAppStore: { setState: (s: Record<string, unknown>) => void };
      }).__useAppStore;
      store.setState({
        projects: [],
        activeProjectId: null,
        stacks: [],
        boardTickets: [],
        moveTicketColumnError: null,
      });
    });
  });
});
