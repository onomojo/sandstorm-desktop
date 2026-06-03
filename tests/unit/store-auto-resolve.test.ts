/**
 * @vitest-environment jsdom
 *
 * Store-level unit tests for the autoResolveConflicts action.
 * Mirrors the pattern in tests/unit/ticketBoard.test.ts for store-facing tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../../src/renderer/store';

const TICKET_ID = '42';
const PROJECT_DIR = '/proj';
const KEY = `${TICKET_ID}|${PROJECT_DIR}`;

function mockAutoResolveIpc(result: unknown) {
  const api = {
    pr: { autoResolve: vi.fn().mockResolvedValue(result) },
  };
  Object.defineProperty(window, 'sandstorm', {
    value: api,
    writable: true,
    configurable: true,
  });
  return api;
}

function mockAutoResolveIpcError(err: Error) {
  const api = {
    pr: { autoResolve: vi.fn().mockRejectedValue(err) },
  };
  Object.defineProperty(window, 'sandstorm', {
    value: api,
    writable: true,
    configurable: true,
  });
  return api;
}

beforeEach(() => {
  useAppStore.setState({
    autoResolveInFlight: {},
    autoResolveErrors: {},
  } as any);
});

describe('autoResolveConflicts store action', () => {
  it('success path (CONFLICTING → resolved): no error set in store', async () => {
    mockAutoResolveIpc({ status: 'resolved' });

    await useAppStore.getState().autoResolveConflicts(TICKET_ID, PROJECT_DIR);

    expect(useAppStore.getState().autoResolveErrors[KEY]).toBeUndefined();
    expect(useAppStore.getState().autoResolveInFlight[KEY]).toBeFalsy();
  });

  it('no-op path (MERGEABLE): sets "No conflicts to resolve." error', async () => {
    mockAutoResolveIpc({ status: 'no_conflicts' });

    await useAppStore.getState().autoResolveConflicts(TICKET_ID, PROJECT_DIR);

    expect(useAppStore.getState().autoResolveErrors[KEY]).toBe('No conflicts to resolve.');
  });

  it('unknown path (UNKNOWN): sets "Mergeability unknown, try again." error', async () => {
    mockAutoResolveIpc({ status: 'unknown_state' });

    await useAppStore.getState().autoResolveConflicts(TICKET_ID, PROJECT_DIR);

    expect(useAppStore.getState().autoResolveErrors[KEY]).toBe('Mergeability unknown, try again.');
  });

  it('failure path: sets the error message from the result', async () => {
    mockAutoResolveIpc({ status: 'failed', error: 'inner agent could not resolve' });

    await useAppStore.getState().autoResolveConflicts(TICKET_ID, PROJECT_DIR);

    expect(useAppStore.getState().autoResolveErrors[KEY]).toBe('inner agent could not resolve');
  });

  it('error thrown by IPC: sets the error message in the store', async () => {
    mockAutoResolveIpcError(new Error('Stack not found'));

    await useAppStore.getState().autoResolveConflicts(TICKET_ID, PROJECT_DIR);

    expect(useAppStore.getState().autoResolveErrors[KEY]).toBe('Stack not found');
  });

  it('in-flight guard: second call while first is in-flight is a no-op', async () => {
    let resolveFirst!: () => void;
    const firstProm = new Promise<void>((r) => { resolveFirst = r; });
    const api = {
      pr: { autoResolve: vi.fn().mockReturnValueOnce(firstProm.then(() => ({ status: 'resolved' }))) },
    };
    Object.defineProperty(window, 'sandstorm', { value: api, writable: true, configurable: true });

    const first = useAppStore.getState().autoResolveConflicts(TICKET_ID, PROJECT_DIR);
    // second call before first resolves
    const second = useAppStore.getState().autoResolveConflicts(TICKET_ID, PROJECT_DIR);

    resolveFirst();
    await first;
    await second;

    expect(api.pr.autoResolve).toHaveBeenCalledTimes(1);
  });

  it('clears previous error at the start of a new attempt', async () => {
    useAppStore.setState({ autoResolveErrors: { [KEY]: 'old error' } } as any);
    mockAutoResolveIpc({ status: 'resolved' });

    await useAppStore.getState().autoResolveConflicts(TICKET_ID, PROJECT_DIR);

    expect(useAppStore.getState().autoResolveErrors[KEY]).toBeUndefined();
  });

  it('inFlight flag is set during the call and cleared after', async () => {
    let resolveFn!: () => void;
    const promise = new Promise<void>((r) => { resolveFn = r; });
    const api = {
      pr: { autoResolve: vi.fn().mockReturnValue(promise.then(() => ({ status: 'resolved' }))) },
    };
    Object.defineProperty(window, 'sandstorm', { value: api, writable: true, configurable: true });

    const actionPromise = useAppStore.getState().autoResolveConflicts(TICKET_ID, PROJECT_DIR);

    expect(useAppStore.getState().autoResolveInFlight[KEY]).toBe(true);

    resolveFn();
    await actionPromise;

    expect(useAppStore.getState().autoResolveInFlight[KEY]).toBeFalsy();
  });
});
