import { test, expect } from './fixtures';
import type { RefineQuestion, RefinementSession } from '../../src/renderer/store';

test.describe('Refinement streaming panel', () => {
  test('refine-stream-panel shows live streamed text mid-run', async ({ electronApp, mainWindow }) => {
    // Wait for the app to be fully rendered
    await mainWindow.waitForSelector('text=Sandstorm', { timeout: 15000 });
    await mainWindow.waitForFunction(
      () => Boolean((window as unknown as { __useAppStore?: unknown }).__useAppStore),
      { timeout: 15000 },
    );

    const sessionId = 'int-test-refine-stream-1';

    // Inject a fake running session from the main process by sending the same
    // IPC events that startRefinementAsync() in ipc.ts emits when a real
    // ephemeral subprocess is running. This exercises the full renderer-side
    // chain without spawning the real claude CLI.
    await electronApp.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (electron: any, args: { sid: string; ts: number }) => {
        const win = electron.BrowserWindow.getAllWindows()[0];
        win.webContents.send('refinement:update', {
          id: args.sid,
          ticketId: '999',
          projectDir: '/tmp/integration-test',
          status: 'running',
          phase: 'check',
          startedAt: args.ts,
        });
      },
      { sid: sessionId, ts: Date.now() },
    );

    // Wait for the session to land in the store.
    await mainWindow.waitForFunction(
      (sid: string) => {
        return (
          window as unknown as {
            __useAppStore: { getState: () => { refinementSessions: Array<{ id: string }> } };
          }
        ).__useAppStore
          .getState()
          .refinementSessions.some((s) => s.id === sid);
      },
      sessionId,
      { timeout: 5000 },
    );

    // Send streaming progress deltas, mirroring the onChunk callbacks that
    // spawnEphemeralAgent fires for each parsed text delta from the subprocess.
    await electronApp.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (electron: any, sid: string) => {
        const win = electron.BrowserWindow.getAllWindows()[0];
        win.webContents.send('refinement:progress', {
          sessionId: sid,
          delta: 'Analyzing spec quality...',
        });
        win.webContents.send('refinement:progress', {
          sessionId: sid,
          delta: '\nChecking problem statement...',
        });
      },
      sessionId,
    );

    // The RefinementIndicator pill was removed (#510). Running sessions have no UI
    // entry point to reopen the dialog (Q3 — accepted loss). Open programmatically
    // to exercise the streaming panel independently of the entry-point affordance.
    await mainWindow.evaluate((sid: string) => {
      (
        window as unknown as {
          __useAppStore: { setState: (s: Record<string, unknown>) => void };
        }
      ).__useAppStore.setState({ showRefineTicketDialog: true, currentRefinementSessionId: sid });
    }, sessionId);

    // The dialog must be open and the running state must include the stream panel.
    await mainWindow.waitForSelector('[data-testid="refine-ticket-dialog"]', { timeout: 5000 });
    await mainWindow.waitForSelector('[data-testid="refine-stream-panel"]', { timeout: 5000 });

    // Wait until the panel contains the streamed text rather than the empty
    // placeholder ("Waiting for output…"). The IPC events travel through the
    // preload bridge and the Zustand store, so there may be a brief render lag.
    await mainWindow.waitForFunction(
      () => {
        const panel = document.querySelector('[data-testid="refine-stream-panel"]');
        return (
          panel !== null &&
          panel.textContent !== null &&
          !panel.textContent.includes('Waiting for output')
        );
      },
      { timeout: 5000 },
    );

    // Assert the stream panel is visible and populated with the injected delta.
    const streamPanel = mainWindow.locator('[data-testid="refine-stream-panel"]');
    await expect(streamPanel).toBeVisible();
    const panelText = await streamPanel.textContent();
    expect(panelText).toBeTruthy();
    expect(panelText).toContain('Analyzing spec quality');

    // Capture a screenshot showing the dialog mid-run with the live-streaming
    // panel populated (not the static spinner alone).
    const screenshot = await mainWindow.screenshot();
    expect(screenshot.byteLength).toBeGreaterThan(0);
  });

  test('RefineTicketDialog renders radio buttons, textareas, and wider modal for structured questions', async ({ electronApp, mainWindow }) => {
    await mainWindow.waitForSelector('text=Sandstorm', { timeout: 15000 });
    await mainWindow.waitForFunction(
      () => Boolean((window as unknown as { __useAppStore?: unknown }).__useAppStore),
      { timeout: 15000 },
    );

    const sessionId = 'int-test-refine-structured-1';
    const TICKET_ID = '998';
    const PROJECT_DIR = '/tmp/integration-test-structured';
    const structuredQuestions: RefineQuestion[] = [
      {
        id: 'q1',
        question: 'Should X do A or B?',
        options: [
          { id: 'a', label: 'Do A' },
          { id: 'b', label: 'Do B' },
        ],
      },
      {
        id: 'q2',
        question: 'What is the expected throughput?',
        options: [
          { id: 'a', label: 'Under 100 RPS' },
          { id: 'b', label: 'Over 100 RPS' },
        ],
      },
    ];

    // The electronApp fixture is worker-scoped and shared across tests in this file.
    // Test 1 leaves the dialog open; close it before interacting with the board.
    const priorDialog = mainWindow.locator('[data-testid="refine-ticket-dialog"]');
    if (await priorDialog.isVisible().catch(() => false)) {
      // Click the backdrop overlay at the top-left corner (outside the centered modal content)
      // to trigger handleClose via the overlay's onClick handler.
      await priorDialog.click({ position: { x: 5, y: 5 } });
      await priorDialog.waitFor({ state: 'hidden', timeout: 3000 });
    }

    // Capture the current lastTicketFetchAt before seeding so we can detect when
    // the board refresh triggered by setting activeProjectId has completed.
    const prevFetchAt = await mainWindow.evaluate(() =>
      (
        window as unknown as {
          __useAppStore: { getState: () => { lastTicketFetchAt: number | null } };
        }
      ).__useAppStore.getState().lastTicketFetchAt,
    );

    // Seed project and activeProjectId — this triggers the KanbanBoard useEffect
    // which calls refreshBoardTickets. Do NOT seed boardTickets yet.
    await mainWindow.evaluate(
      ({ dir }) => {
        (
          window as unknown as {
            __useAppStore: { setState: (s: Record<string, unknown>) => void };
          }
        ).__useAppStore.setState({
          projects: [{ id: 9002, name: 'int-test-structured', directory: dir, added_at: '' }],
          activeProjectId: 9002,
          boardTickets: [],
          refinementSessions: [],
          stacks: [],
        });
      },
      { dir: PROJECT_DIR },
    );

    // Wait for the board refresh to complete (lastTicketFetchAt changes and loading stops).
    await mainWindow.waitForFunction(
      (prev: number | null) => {
        const state = (
          window as unknown as {
            __useAppStore: {
              getState: () => { lastTicketFetchAt: number | null; boardTicketsLoading: boolean };
            };
          }
        ).__useAppStore.getState();
        return state.lastTicketFetchAt !== prev && !state.boardTicketsLoading;
      },
      prevFetchAt,
      { timeout: 5000 },
    );

    // Seed the ticket in the refining column. The KanbanBoard effect won't fire again
    // because project.directory hasn't changed, so this state is stable.
    await mainWindow.evaluate(
      ({ ticketId, dir }) => {
        (
          window as unknown as {
            __useAppStore: { setState: (s: Record<string, unknown>) => void };
          }
        ).__useAppStore.setState({
          boardTickets: [
            {
              ticket_id: ticketId,
              project_dir: dir,
              column: 'refining',
              title: 'Structured questions test ticket',
              updated_at: '',
            },
          ],
        });
      },
      { ticketId: TICKET_ID, dir: PROJECT_DIR },
    );

    // Wait for the ticket card to appear before injecting the session.
    await mainWindow.waitForSelector(`[data-testid="ticket-card-${TICKET_ID}"]`, { timeout: 3000 });

    // Inject a failed gate with structured questions directly as a ready session.
    await electronApp.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (
        electron: any,
        args: { sid: string; ts: number; questions: RefineQuestion[]; ticketId: string; dir: string },
      ) => {
        const win = electron.BrowserWindow.getAllWindows()[0];
        win.webContents.send('refinement:update', {
          id: args.sid,
          ticketId: args.ticketId,
          projectDir: args.dir,
          status: 'ready',
          phase: 'check',
          startedAt: args.ts,
          result: {
            passed: false,
            questions: args.questions,
            gateSummary: 'Gate=FAIL, questions=2',
            ticketUrl: null,
            cached: false,
          },
        });
      },
      { sid: sessionId, ts: Date.now(), questions: structuredQuestions, ticketId: TICKET_ID, dir: PROJECT_DIR },
    );

    // Open the dialog via the ticket card's Answer button — the entry point for
    // ready+questions sessions after the RefinementIndicator pill was removed (#510).
    const answerBtn = mainWindow.locator(`[data-testid="ticket-card-answer-${TICKET_ID}"]`);
    await expect(answerBtn).toBeVisible({ timeout: 5000 });
    await answerBtn.click();

    await mainWindow.waitForSelector('[data-testid="refine-ticket-dialog"]', { timeout: 5000 });
    await mainWindow.waitForSelector('[data-testid="refine-fail"]', { timeout: 5000 });

    // (a) Radio inputs are present for each option (2 questions × 2 options = 4 radios).
    const radios = mainWindow.locator('input[type="radio"]');
    await expect(radios).toHaveCount(4);

    // (b) A textarea is present per question (2 textareas).
    const textareas = mainWindow.locator('[data-testid="refine-fail"] textarea');
    await expect(textareas).toHaveCount(2);

    // (c) The modal element's class list includes the wider w-[768px] class.
    const modal = mainWindow.locator('[data-testid="refine-ticket-dialog"] > div').first();
    const className = await modal.getAttribute('class');
    expect(className).toContain('w-[768px]');

    // Cleanup
    await mainWindow.evaluate(() => {
      (
        window as unknown as {
          __useAppStore: { setState: (s: Record<string, unknown>) => void };
        }
      ).__useAppStore.setState({
        projects: [],
        activeProjectId: null,
        refinementSessions: [],
        stacks: [],
        boardTickets: [],
      });
    });
  });

  test('Answer button hidden while running, visible once ready with questions (#415)', async ({ electronApp, mainWindow }) => {
    await mainWindow.waitForSelector('text=Sandstorm', { timeout: 15000 });
    await mainWindow.waitForFunction(
      () => Boolean((window as unknown as { __useAppStore?: unknown }).__useAppStore),
      { timeout: 15000 },
    );

    const TICKET_415 = `ticket-415-${Date.now()}`;
    const PROJECT_415 = `/tmp/int-test-415-${Date.now()}`;
    const SESSION_415 = `sess-415-${Date.now()}`;

    // Capture the current lastTicketFetchAt before seeding so we can detect when
    // the board refresh triggered by setting activeProjectId has completed.
    const prevFetchAt = await mainWindow.evaluate(() =>
      (window as unknown as {
        __useAppStore: { getState: () => { lastTicketFetchAt: number | null } };
      }).__useAppStore.getState().lastTicketFetchAt,
    );

    // Seed project/activeProjectId first — this triggers the KanbanBoard useEffect
    // which calls refreshBoardTickets (an IPC round-trip that will return an empty
    // array for this fake project directory). Do NOT seed boardTickets yet.
    await mainWindow.evaluate(({ dir }) => {
      const store = (window as unknown as {
        __useAppStore: { setState: (s: Record<string, unknown>) => void };
      }).__useAppStore;
      store.setState({
        projects: [{ id: 9415, name: 'int-test-415', directory: dir, added_at: '' }],
        activeProjectId: 9415,
        boardTickets: [],
        refinementSessions: [],
        stacks: [],
      });
    }, { dir: PROJECT_415 });

    // Wait for the board refresh to complete. The refresh resolves to an empty array
    // (this project has no DB rows), setting lastTicketFetchAt to a new timestamp.
    await mainWindow.waitForFunction(
      (prev: number | null) => {
        const state = (window as unknown as {
          __useAppStore: { getState: () => { lastTicketFetchAt: number | null; boardTicketsLoading: boolean } };
        }).__useAppStore.getState();
        return state.lastTicketFetchAt !== prev && !state.boardTicketsLoading;
      },
      prevFetchAt,
      { timeout: 5000 },
    );

    // Now seed boardTickets. The KanbanBoard effect won't fire again because
    // project.directory hasn't changed, so this seeded state is stable.
    await mainWindow.evaluate(({ ticketId, dir }) => {
      (window as unknown as {
        __useAppStore: { setState: (s: Record<string, unknown>) => void };
      }).__useAppStore.setState({
        boardTickets: [{ ticket_id: ticketId, project_dir: dir, column: 'refining', title: 'Ticket 415 test', updated_at: '' }],
      });
    }, { ticketId: TICKET_415, dir: PROJECT_415 });

    // Wait for the ticket card to be in the DOM before injecting the session.
    await mainWindow.waitForSelector(`[data-testid="ticket-card-${TICKET_415}"]`, { timeout: 3000 });

    // Inject a running refinement session via IPC (same path the real daemon uses).
    await electronApp.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (electron: any, args: { sid: string; ticketId: string; dir: string; ts: number }) => {
        const win = electron.BrowserWindow.getAllWindows()[0];
        win.webContents.send('refinement:update', {
          id: args.sid,
          ticketId: args.ticketId,
          projectDir: args.dir,
          status: 'running',
          phase: 'check',
          startedAt: args.ts,
        });
      },
      { sid: SESSION_415, ticketId: TICKET_415, dir: PROJECT_415, ts: Date.now() },
    );

    // Wait for the session to land in the store.
    await mainWindow.waitForFunction(
      (sid: string) => {
        const store = (window as unknown as {
          __useAppStore: { getState: () => { refinementSessions: Array<{ id: string }> } };
        }).__useAppStore;
        return store.getState().refinementSessions.some((s) => s.id === sid);
      },
      SESSION_415,
      { timeout: 5000 },
    );

    // Assert the Answer button is absent while running.
    const answerBtn = mainWindow.locator(`[data-testid="ticket-card-answer-${TICKET_415}"]`);
    await expect(answerBtn).toHaveCount(0);

    // Transition to ready with questions via the same IPC path.
    await electronApp.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (electron: any, args: { sid: string; ticketId: string; dir: string; ts: number }) => {
        const win = electron.BrowserWindow.getAllWindows()[0];
        win.webContents.send('refinement:update', {
          id: args.sid,
          ticketId: args.ticketId,
          projectDir: args.dir,
          status: 'ready',
          phase: 'check',
          startedAt: args.ts,
          result: {
            passed: false,
            questions: [{ id: 'q1', question: 'What approach should be used?', options: [] }],
            gateSummary: 'Gate=FAIL, questions=1',
            ticketUrl: null,
            cached: false,
          },
        });
      },
      { sid: SESSION_415, ticketId: TICKET_415, dir: PROJECT_415, ts: Date.now() },
    );

    // The Answer button must appear once the session is ready with questions.
    await expect(answerBtn).toBeVisible({ timeout: 5000 });

    // Cleanup
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
      });
    });
  });
});
