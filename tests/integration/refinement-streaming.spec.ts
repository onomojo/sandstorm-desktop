import { test, expect } from './fixtures';
import type { RefineQuestion } from '../../src/renderer/store';

test.describe('Refinement streaming panel', () => {
  test('refine-stream-panel shows live streamed text mid-run', async ({ electronApp, mainWindow }) => {
    // Wait for the app to be fully rendered
    await mainWindow.waitForSelector('text=Sandstorm', { timeout: 15000 });

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

    // Wait for the RefinementIndicator pill to appear in the title bar —
    // it becomes visible as soon as the store has at least one session.
    await mainWindow.waitForSelector('[data-testid="refinement-indicator-pill"]', { timeout: 5000 });

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

    // Expand the refinement indicator dropdown and click the session to open
    // RefineTicketDialog. This mirrors the normal user flow for reopening a
    // running session.
    await mainWindow.click('[data-testid="refinement-indicator-pill"]');
    await mainWindow.waitForSelector(`[data-testid="refinement-session-${sessionId}"]`, { timeout: 5000 });
    await mainWindow.click(`[data-testid="refinement-session-${sessionId}"]`);

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

    const sessionId = 'int-test-refine-structured-1';
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

    // Inject a failed gate with structured questions directly as a ready session.
    await electronApp.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (electron: any, args: { sid: string; ts: number; questions: RefineQuestion[] }) => {
        const win = electron.BrowserWindow.getAllWindows()[0];
        win.webContents.send('refinement:update', {
          id: args.sid,
          ticketId: '998',
          projectDir: '/tmp/integration-test',
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
      { sid: sessionId, ts: Date.now(), questions: structuredQuestions },
    );

    // The electronApp fixture is worker-scoped and shared across tests in this file.
    // Test 1 leaves the dialog open; close it before interacting with the indicator pill.
    const priorDialog = mainWindow.locator('[data-testid="refine-ticket-dialog"]');
    if (await priorDialog.isVisible().catch(() => false)) {
      // Click the backdrop overlay at the top-left corner (outside the centered modal content)
      // to trigger handleClose via the overlay's onClick handler.
      await priorDialog.click({ position: { x: 5, y: 5 } });
      await priorDialog.waitFor({ state: 'hidden', timeout: 3000 });
    }

    // Open the dialog via the refinement indicator.
    await mainWindow.waitForSelector('[data-testid="refinement-indicator-pill"]', { timeout: 5000 });
    await mainWindow.click('[data-testid="refinement-indicator-pill"]');
    await mainWindow.waitForSelector(`[data-testid="refinement-session-${sessionId}"]`, { timeout: 5000 });
    await mainWindow.click(`[data-testid="refinement-session-${sessionId}"]`);
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
  });
});
