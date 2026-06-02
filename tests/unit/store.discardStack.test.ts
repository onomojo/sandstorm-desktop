/**
 * @vitest-environment jsdom
 *
 * Tests for the discardStack store action (#446).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../../src/renderer/store';

const PROJECT_DIR = '/proj';
const TICKET_ID = '42';

// Minimal sandstorm API mock
function makeSandstormApi(overrides: Record<string, unknown> = {}) {
  const api = {
    stacks: {
      teardown: vi.fn().mockResolvedValue(undefined),
    },
    tickets: {
      close: vi.fn().mockResolvedValue(undefined),
    },
    ticketBoard: {
      setColumn: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
  Object.defineProperty(window, 'sandstorm', {
    value: api,
    writable: true,
    configurable: true,
  });
  return api;
}

const makeTicket = (column: string) => ({
  ticket_id: TICKET_ID,
  project_dir: PROJECT_DIR,
  column,
  title: 'Test ticket',
  updated_at: '',
});

const makeStack = (overrides = {}) => ({
  id: 's1',
  ticket: TICKET_ID,
  project_dir: PROJECT_DIR,
  status: 'completed',
  pr_url: null,
  pr_number: null,
  ...overrides,
});

describe('discardStack', () => {
  let api: ReturnType<typeof makeSandstormApi>;

  beforeEach(() => {
    api = makeSandstormApi();
    useAppStore.setState({
      boardTickets: [makeTicket('in_stack') as any],
      stacks: [],
      discardInFlight: {},
      discardErrors: {},
      moveTicketColumnError: null,
    } as any);
  });

  // ---------------------------------------------------------------------------
  // Option A: back to backlog
  // ---------------------------------------------------------------------------

  it('option A: best-effort teardown then moves card to backlog', async () => {
    useAppStore.setState({ stacks: [makeStack() as any] } as any);
    await useAppStore.getState().discardStack(TICKET_ID, PROJECT_DIR, 'backlog');
    expect(api.stacks.teardown).toHaveBeenCalledWith('s1');
    expect(api.ticketBoard.setColumn).toHaveBeenCalledWith(TICKET_ID, PROJECT_DIR, 'backlog');
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === TICKET_ID);
    expect(entry?.column).toBe('backlog');
  });

  it('option A: skips teardown when no live stack record (the #446 case)', async () => {
    // No stack in store → teardown not called
    useAppStore.setState({ stacks: [] } as any);
    await useAppStore.getState().discardStack(TICKET_ID, PROJECT_DIR, 'backlog');
    expect(api.stacks.teardown).not.toHaveBeenCalled();
    expect(api.ticketBoard.setColumn).toHaveBeenCalledWith(TICKET_ID, PROJECT_DIR, 'backlog');
  });

  it('option A: teardown Stack-not-found is swallowed', async () => {
    useAppStore.setState({ stacks: [makeStack() as any] } as any);
    api.stacks.teardown.mockRejectedValueOnce(new Error('Stack "s1" not found'));
    await expect(
      useAppStore.getState().discardStack(TICKET_ID, PROJECT_DIR, 'backlog')
    ).resolves.not.toThrow();
    expect(api.ticketBoard.setColumn).toHaveBeenCalledWith(TICKET_ID, PROJECT_DIR, 'backlog');
  });

  it('option A: all teardown errors are swallowed (best-effort)', async () => {
    useAppStore.setState({ stacks: [makeStack() as any] } as any);
    api.stacks.teardown.mockRejectedValueOnce(new Error('docker daemon not running'));
    await expect(
      useAppStore.getState().discardStack(TICKET_ID, PROJECT_DIR, 'backlog')
    ).resolves.not.toThrow();
    expect(api.ticketBoard.setColumn).toHaveBeenCalledWith(TICKET_ID, PROJECT_DIR, 'backlog');
  });

  // ---------------------------------------------------------------------------
  // Option B: close ticket
  // ---------------------------------------------------------------------------

  it('option B: best-effort teardown → ticket:close → ticket-board:delete → removes card', async () => {
    useAppStore.setState({ stacks: [makeStack() as any] } as any);
    await useAppStore.getState().discardStack(TICKET_ID, PROJECT_DIR, 'close');
    expect(api.stacks.teardown).toHaveBeenCalledWith('s1');
    expect(api.tickets.close).toHaveBeenCalledWith(TICKET_ID, PROJECT_DIR);
    expect(api.ticketBoard.delete).toHaveBeenCalledWith(TICKET_ID, PROJECT_DIR);
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === TICKET_ID);
    expect(entry).toBeUndefined();
  });

  it('option B regression #446: no stack record + already-closed ticket → success, card removed', async () => {
    // No live stack, ticket.close resolves (already-closed treated as success)
    useAppStore.setState({ stacks: [] } as any);
    api.tickets.close.mockResolvedValueOnce(undefined); // already-closed resolves
    await useAppStore.getState().discardStack(TICKET_ID, PROJECT_DIR, 'close');
    expect(api.stacks.teardown).not.toHaveBeenCalled();
    expect(api.tickets.close).toHaveBeenCalledWith(TICKET_ID, PROJECT_DIR);
    expect(api.ticketBoard.delete).toHaveBeenCalledWith(TICKET_ID, PROJECT_DIR);
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === TICKET_ID);
    expect(entry).toBeUndefined();
  });

  it('option B R2 regression: genuine close failure keeps the card and sets discardErrors', async () => {
    useAppStore.setState({ stacks: [] } as any);
    api.tickets.close.mockRejectedValueOnce(new Error('403 Forbidden: archive unsupported on plan'));
    await useAppStore.getState().discardStack(TICKET_ID, PROJECT_DIR, 'close');
    // Card must still be present
    const entry = useAppStore.getState().boardTickets.find(t => t.ticket_id === TICKET_ID);
    expect(entry).toBeDefined();
    expect(entry?.column).toBe('in_stack');
    // deleteBoardTicket must NOT have been called
    expect(api.ticketBoard.delete).not.toHaveBeenCalled();
    // Error is surfaced in the dedicated discardErrors field (not moveTicketColumnError)
    expect(useAppStore.getState().discardErrors[`${TICKET_ID}|${PROJECT_DIR}`]).toContain('403 Forbidden');
    expect(useAppStore.getState().moveTicketColumnError).toBeNull();
  });

  it('option B: teardown error is swallowed even for close path', async () => {
    useAppStore.setState({ stacks: [makeStack() as any] } as any);
    api.stacks.teardown.mockRejectedValueOnce(new Error('docker unavailable'));
    await useAppStore.getState().discardStack(TICKET_ID, PROJECT_DIR, 'close');
    // Teardown error swallowed — close still runs
    expect(api.tickets.close).toHaveBeenCalled();
    expect(api.ticketBoard.delete).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // In-flight guard
  // ---------------------------------------------------------------------------

  it('in-flight guard prevents concurrent discards', async () => {
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>(r => { resolveFirst = r; });
    api.tickets.close.mockReturnValueOnce(firstPromise);

    const p1 = useAppStore.getState().discardStack(TICKET_ID, PROJECT_DIR, 'close');
    const p2 = useAppStore.getState().discardStack(TICKET_ID, PROJECT_DIR, 'close');

    resolveFirst();
    await p1;
    await p2;

    // tickets.close called only once
    expect(api.tickets.close).toHaveBeenCalledTimes(1);
  });

  it('discardInFlight is cleared after the action completes', async () => {
    await useAppStore.getState().discardStack(TICKET_ID, PROJECT_DIR, 'backlog');
    expect(useAppStore.getState().discardInFlight[`${TICKET_ID}|${PROJECT_DIR}`]).toBeFalsy();
  });

  it('discardInFlight is cleared even after a close failure', async () => {
    api.tickets.close.mockRejectedValueOnce(new Error('network error'));
    await useAppStore.getState().discardStack(TICKET_ID, PROJECT_DIR, 'close');
    expect(useAppStore.getState().discardInFlight[`${TICKET_ID}|${PROJECT_DIR}`]).toBeFalsy();
  });
});
