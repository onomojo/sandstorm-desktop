/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from '../components/setup';

describe('telemetry store slice', () => {
  beforeEach(() => {
    mockSandstormApi();
    useAppStore.setState({
      telemetryRange: '30d',
      telemetrySummary: null,
      telemetryDaily: [],
      telemetryByModel: [],
      telemetryByTicket: [],
      telemetryLoading: false,
      telemetryError: null,
    });
  });

  it('setTelemetryRange updates the range', () => {
    useAppStore.getState().setTelemetryRange('7d');
    expect(useAppStore.getState().telemetryRange).toBe('7d');
  });

  it('setTelemetryRange triggers fetchTelemetry (calls summary API)', async () => {
    const api = mockSandstormApi();
    await new Promise<void>((resolve) => {
      api.telemetry.summary.mockImplementation(() => {
        resolve();
        return Promise.resolve({
          monthCost: 0, prevMonthCost: 0,
          tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
          cacheHitPct: 0, sessions: 0, ticketsShipped: null, costPerTicket: null,
          unpricedModels: [], skippedLines: 0,
        });
      });
      useAppStore.getState().setTelemetryRange('90d');
    });
    expect(api.telemetry.summary).toHaveBeenCalled();
  });

  it('fetchTelemetry sets loading true then false on success', async () => {
    const api = mockSandstormApi();
    let resolveSummary!: (v: unknown) => void;
    api.telemetry.summary.mockReturnValue(new Promise((r) => { resolveSummary = r; }));

    const fetchPromise = useAppStore.getState().fetchTelemetry();
    expect(useAppStore.getState().telemetryLoading).toBe(true);

    resolveSummary({
      monthCost: 5.5, prevMonthCost: 3.0,
      tokens: { input: 100, output: 200, cacheCreate: 10, cacheRead: 50, total: 360 },
      cacheHitPct: 33.3, sessions: 4, ticketsShipped: 2, costPerTicket: 2.75,
      unpricedModels: [], skippedLines: 0,
    });
    await fetchPromise;

    expect(useAppStore.getState().telemetryLoading).toBe(false);
    expect(useAppStore.getState().telemetrySummary?.monthCost).toBe(5.5);
  });

  it('fetchTelemetry populates all four payloads', async () => {
    const api = mockSandstormApi();
    const mockSummary = {
      monthCost: 1.23, prevMonthCost: 0.99,
      tokens: { input: 100, output: 200, cacheCreate: 10, cacheRead: 50, total: 360 },
      cacheHitPct: 33.3, sessions: 2, ticketsShipped: 1, costPerTicket: 1.23,
      unpricedModels: [], skippedLines: 0,
    };
    const mockDaily = [{ date: '2026-06-01', cost: 1.23, tokens: { input: 100, output: 200, cacheCreate: 10, cacheRead: 50 }, byModel: {} }];
    const mockByModel = [{ model: 'claude-sonnet-4-6', cost: 1.23, tokens: { input: 100, output: 200, cacheCreate: 10, cacheRead: 50, total: 360 }, sessions: 2, unpriced: false }];
    const mockByTicket = [{ ticketId: '42', model: 'claude-sonnet-4-6', cost: 1.23, tokens: { input: 100, output: 200, cacheCreate: 10, cacheRead: 50, total: 360 }, cacheHit: 33.3, lifecycle: null, unpriced: false }];

    api.telemetry.summary.mockResolvedValue(mockSummary);
    api.telemetry.daily.mockResolvedValue(mockDaily);
    api.telemetry.byModel.mockResolvedValue(mockByModel);
    api.telemetry.byTicket.mockResolvedValue(mockByTicket);

    await useAppStore.getState().fetchTelemetry();

    const state = useAppStore.getState();
    expect(state.telemetrySummary?.monthCost).toBe(1.23);
    expect(state.telemetryDaily).toHaveLength(1);
    expect(state.telemetryByModel).toHaveLength(1);
    expect(state.telemetryByTicket).toHaveLength(1);
    expect(state.telemetryLoading).toBe(false);
    expect(state.telemetryError).toBeNull();
  });

  it('fetchTelemetry sets telemetryError on IPC rejection', async () => {
    const api = mockSandstormApi();
    api.telemetry.summary.mockRejectedValue(new Error('IPC failed'));

    await useAppStore.getState().fetchTelemetry();

    const state = useAppStore.getState();
    expect(state.telemetryLoading).toBe(false);
    expect(state.telemetryError).toBe('IPC failed');
  });

  it('refreshTelemetry calls telemetry.refresh then refetches', async () => {
    const api = mockSandstormApi();
    await useAppStore.getState().refreshTelemetry();
    expect(api.telemetry.refresh).toHaveBeenCalledOnce();
    expect(api.telemetry.summary).toHaveBeenCalled();
  });

  describe('DateRange mapping', () => {
    it('maps 7d to a range 7 days back from today', async () => {
      const api = mockSandstormApi();
      useAppStore.setState({ telemetryRange: '7d' });
      await useAppStore.getState().fetchTelemetry();

      const callArg = api.telemetry.summary.mock.calls[0][0] as { since: string; until: string };
      const today = new Date().toISOString().slice(0, 10);
      const expected = new Date();
      expected.setDate(expected.getDate() - 7);
      const expectedSince = expected.toISOString().slice(0, 10);
      expect(callArg.until).toBe(today);
      expect(callArg.since).toBe(expectedSince);
    });

    it('maps 30d correctly', async () => {
      const api = mockSandstormApi();
      useAppStore.setState({ telemetryRange: '30d' });
      await useAppStore.getState().fetchTelemetry();
      const callArg = api.telemetry.summary.mock.calls[0][0] as { since: string };
      const expected = new Date();
      expected.setDate(expected.getDate() - 30);
      expect(callArg.since).toBe(expected.toISOString().slice(0, 10));
    });

    it('maps 90d correctly', async () => {
      const api = mockSandstormApi();
      useAppStore.setState({ telemetryRange: '90d' });
      await useAppStore.getState().fetchTelemetry();
      const callArg = api.telemetry.summary.mock.calls[0][0] as { since: string };
      const expected = new Date();
      expected.setDate(expected.getDate() - 90);
      expect(callArg.since).toBe(expected.toISOString().slice(0, 10));
    });

    it('maps all to since=1970-01-01', async () => {
      const api = mockSandstormApi();
      useAppStore.setState({ telemetryRange: 'all' });
      await useAppStore.getState().fetchTelemetry();
      const callArg = api.telemetry.summary.mock.calls[0][0] as { since: string };
      expect(callArg.since).toBe('1970-01-01');
    });

    it('byTicket is called without a range argument', async () => {
      const api = mockSandstormApi();
      await useAppStore.getState().fetchTelemetry();
      expect(api.telemetry.byTicket).toHaveBeenCalledWith();
    });
  });
});
