/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TelemetryView } from '../../../src/renderer/components/TelemetryView';
import { useAppStore } from '../../../src/renderer/store';
import type { TelemetrySummary, DailyEntry, ByModelEntry, ByTicketEntry } from '../../../src/main/telemetry/types';
import { mockSandstormApi } from './setup';

function makeSummary(overrides: Partial<TelemetrySummary> = {}): TelemetrySummary {
  return {
    monthCost: 10.50,
    prevMonthCost: 8.00,
    tokens: { input: 100_000, output: 50_000, cacheCreate: 5_000, cacheRead: 20_000, total: 175_000 },
    cacheHitPct: 16.7,
    sessions: 5,
    ticketsShipped: 3,
    costPerTicket: 3.50,
    unpricedModels: [],
    skippedLines: 0,
    ...overrides,
  };
}

function makeDaily(n = 3): DailyEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-06-0${i + 1}`,
    cost: i + 1,
    tokens: { input: 10_000 * (i + 1), output: 5_000 * (i + 1), cacheCreate: 500 * (i + 1), cacheRead: 2_000 * (i + 1) },
    byModel: {},
  }));
}

function makeByModel(): ByModelEntry[] {
  return [
    { model: 'claude-sonnet-4-6', cost: 8.0, tokens: { input: 80_000, output: 40_000, cacheCreate: 4_000, cacheRead: 16_000, total: 140_000 }, sessions: 4, unpriced: false },
    { model: 'claude-opus-4-7', cost: 2.5, tokens: { input: 20_000, output: 10_000, cacheCreate: 1_000, cacheRead: 4_000, total: 35_000 }, sessions: 1, unpriced: false },
  ];
}

function makeByTicket(lifecycle = true): ByTicketEntry[] {
  return [
    {
      ticketId: '42',
      model: 'claude-sonnet-4-6',
      cost: 6.0,
      tokens: { input: 60_000, output: 30_000, cacheCreate: 3_000, cacheRead: 12_000, total: 105_000 },
      cacheHit: 16.7,
      lifecycle: lifecycle ? { refine: 1.0, spec: 0.5, execution: 3.0, review: 0.8, verify: 0.0, pr: 0.7 } : null,
      unpriced: false,
    },
    {
      ticketId: '43',
      model: 'claude-sonnet-4-6',
      cost: 4.5,
      tokens: { input: 40_000, output: 20_000, cacheCreate: 2_000, cacheRead: 8_000, total: 70_000 },
      cacheHit: 16.7,
      lifecycle: lifecycle ? { refine: 0.5, spec: 0.3, execution: 2.5, review: 0.7, verify: 0.0, pr: 0.5 } : null,
      unpriced: false,
    },
  ];
}

function setupStore(overrides: {
  summary?: Partial<TelemetrySummary> | null;
  daily?: DailyEntry[];
  byModel?: ByModelEntry[];
  byTicket?: ByTicketEntry[];
  loading?: boolean;
  error?: string | null;
} = {}) {
  useAppStore.setState({
    telemetrySummary: overrides.summary !== undefined
      ? (overrides.summary === null ? null : makeSummary(overrides.summary))
      : makeSummary(),
    telemetryDaily: overrides.daily ?? makeDaily(),
    telemetryByModel: overrides.byModel ?? makeByModel(),
    telemetryByTicket: overrides.byTicket ?? makeByTicket(),
    telemetryLoading: overrides.loading ?? false,
    telemetryError: overrides.error ?? null,
    boardTickets: [
      { ticket_id: '42', project_dir: '/test', column: 'in_stack', title: 'Fix the bug', updated_at: '' },
      { ticket_id: '43', project_dir: '/test', column: 'merged', title: 'Add feature', updated_at: '' },
    ],
    mainView: 'telemetry',
  });
}

describe('TelemetryView', () => {
  beforeEach(() => {
    mockSandstormApi();
    setupStore();
  });

  describe('duplicate view-switcher removal (#546)', () => {
    it('does not render the duplicate Board tab in the telemetry header', () => {
      render(<TelemetryView />);
      expect(screen.queryByTestId('tab-board')).toBeNull();
    });

    it('does not render the duplicate Telemetry tab in the telemetry header', () => {
      render(<TelemetryView />);
      expect(screen.queryByTestId('tab-telemetry')).toBeNull();
    });

    it('still renders the range-chips date filter', () => {
      render(<TelemetryView />);
      expect(screen.getByTestId('range-chips')).toBeDefined();
    });
  });

  describe('KPI panel', () => {
    it('renders monthCost', () => {
      render(<TelemetryView />);
      expect(screen.getByTestId('kpi-month-cost').textContent).toBe('$10.50');
    });

    it('renders delta percentage vs previous month', () => {
      render(<TelemetryView />);
      // (10.50 - 8.00) / 8.00 * 100 = 31.25%
      const delta = screen.getByTestId('kpi-month-delta');
      expect(delta.textContent).toContain('▲');
      expect(delta.textContent).toContain('31.3%');
    });

    it('shows — for delta when prevMonthCost is 0', () => {
      setupStore({ summary: { prevMonthCost: 0 } });
      render(<TelemetryView />);
      expect(screen.getByTestId('kpi-month-delta').textContent).toBe('—');
    });

    it('renders token in/out subline', () => {
      render(<TelemetryView />);
      const subline = screen.getByTestId('kpi-tokens-inout');
      expect(subline.textContent).toContain('in');
      expect(subline.textContent).toContain('out');
    });

    it('renders cache hit rate', () => {
      render(<TelemetryView />);
      expect(screen.getByTestId('kpi-cache-hit').textContent).toBe('16.7%');
    });

    it('renders costPerTicket', () => {
      render(<TelemetryView />);
      expect(screen.getByTestId('kpi-cost-per-ticket').textContent).toBe('$3.50');
    });

    it('shows — for costPerTicket when null', () => {
      setupStore({ summary: { costPerTicket: null } });
      render(<TelemetryView />);
      expect(screen.getByTestId('kpi-cost-per-ticket').textContent).toBe('—');
    });

    it('shows — for ticketsShipped subline when null', () => {
      setupStore({ summary: { ticketsShipped: null } });
      render(<TelemetryView />);
      expect(screen.getByTestId('kpi-tickets-subline').textContent).toBe('—');
    });
  });

  describe('Daily token chart toggles', () => {
    it('renders the stacked bars chart', () => {
      render(<TelemetryView />);
      expect(screen.getByTestId('stacked-bars')).toBeDefined();
    });

    it('toggling a class chip changes y-max', () => {
      render(<TelemetryView />);
      const barsEl = screen.getByTestId('stacked-bars');
      const ymaxBefore = barsEl.getAttribute('data-ymax');

      // Toggle 'output' off
      fireEvent.click(screen.getByTestId('toggle-output'));

      const ymaxAfter = screen.getByTestId('stacked-bars').getAttribute('data-ymax');
      expect(ymaxAfter).not.toBe(ymaxBefore);
    });

    it('turning all classes off shows no-class hint', () => {
      render(<TelemetryView />);
      fireEvent.click(screen.getByTestId('toggle-input'));
      fireEvent.click(screen.getByTestId('toggle-output'));
      fireEvent.click(screen.getByTestId('toggle-cacheCreate'));
      fireEvent.click(screen.getByTestId('toggle-cacheRead'));
      expect(screen.getByTestId('stacked-bars').textContent).toContain('No classes selected');
    });
  });

  describe('Per-ticket sort', () => {
    it('sorts by total by default (descending)', () => {
      render(<TelemetryView />);
      const rows = screen.getAllByTestId(/^ticket-row-/);
      // ticket 42 costs 6.0, ticket 43 costs 4.5 → 42 first
      expect(rows[0].getAttribute('data-testid')).toBe('ticket-row-42');
      expect(rows[1].getAttribute('data-testid')).toBe('ticket-row-43');
    });

    it('clicking a stage chip reorders rows', () => {
      render(<TelemetryView />);
      // Sort by 'spec': ticket 42 spec=0.5, ticket 43 spec=0.3 → 42 still first
      fireEvent.click(screen.getByTestId('sort-spec'));
      const rows = screen.getAllByTestId(/^ticket-row-/);
      expect(rows[0].getAttribute('data-testid')).toBe('ticket-row-42');
    });

    it('clicking stage chip changes right-hand value to stage cost', () => {
      render(<TelemetryView />);
      fireEvent.click(screen.getByTestId('sort-execution'));
      // ticket 42 execution cost = 3.0
      expect(screen.getByTestId('ticket-cost-42').textContent).toBe('$3.00');
    });

    it('stage chips are disabled when lifecycle is null', () => {
      setupStore({ byTicket: makeByTicket(false) });
      render(<TelemetryView />);
      const specChip = screen.getByTestId('sort-spec');
      expect(specChip).toHaveProperty('disabled', true);
    });

    it('Total sort still works when lifecycle is null', () => {
      setupStore({ byTicket: makeByTicket(false) });
      render(<TelemetryView />);
      fireEvent.click(screen.getByTestId('sort-total'));
      const rows = screen.getAllByTestId(/^ticket-row-/);
      expect(rows[0].getAttribute('data-testid')).toBe('ticket-row-42');
    });
  });

  describe('Error state', () => {
    it('shows error message and retry button after fetch failure', async () => {
      const api = mockSandstormApi();
      api.telemetry.summary.mockRejectedValue(new Error('IPC failed'));
      setupStore({ summary: null, loading: false, error: null });
      render(<TelemetryView />);
      await waitFor(() => {
        expect(screen.getByTestId('telemetry-error')).toBeDefined();
      });
      expect(screen.getByTestId('telemetry-error').textContent).toContain('IPC failed');
      expect(screen.getByTestId('telemetry-retry-btn')).toBeDefined();
    });
  });

  describe('Month vs last panel', () => {
    it('renders both month bars', () => {
      render(<TelemetryView />);
      expect(screen.getByTestId('bar-this-month')).toBeDefined();
      expect(screen.getByTestId('bar-last-month')).toBeDefined();
    });

    it('renders horizontal bars (data-width-pct attribute)', () => {
      render(<TelemetryView />);
      const thisBar = screen.getByTestId('bar-this-month');
      const lastBar = screen.getByTestId('bar-last-month');
      const thisW = parseFloat(thisBar.getAttribute('data-width-pct') ?? '0');
      const lastW = parseFloat(lastBar.getAttribute('data-width-pct') ?? '0');
      // this month ($10.50) > last month ($8.00) → this bar has 100%, last bar ~76%
      expect(thisW).toBeCloseTo(100, 0);
      expect(lastW).toBeCloseTo(76.2, 0);
    });

    it('shows delta sign correctly', () => {
      render(<TelemetryView />);
      expect(screen.getByTestId('month-delta').textContent).toContain('▲');
    });

    it('shows ▼ when this month < last', () => {
      setupStore({ summary: { monthCost: 3.0, prevMonthCost: 8.0 } });
      render(<TelemetryView />);
      expect(screen.getByTestId('month-delta').textContent).toContain('▼');
    });

    it('delta includes "higher" when this month > last', () => {
      render(<TelemetryView />);
      expect(screen.getByTestId('month-delta').textContent).toContain('higher');
    });

    it('delta includes "lower" when this month < last', () => {
      setupStore({ summary: { monthCost: 3.0, prevMonthCost: 8.0 } });
      render(<TelemetryView />);
      expect(screen.getByTestId('month-delta').textContent).toContain('lower');
    });

    it('shows — for delta when prevMonthCost is 0 (no higher/lower)', () => {
      setupStore({ summary: { monthCost: 5.0, prevMonthCost: 0 } });
      render(<TelemetryView />);
      expect(screen.getByTestId('month-delta').textContent).toBe('—');
    });
  });

  describe('Pipeline panel', () => {
    it('renders pipeline rows for kanban columns', () => {
      render(<TelemetryView />);
      // Should have rows for each KANBAN_COLUMN + unattributed
      expect(screen.getByTestId('pipeline-row-backlog')).toBeDefined();
      expect(screen.getByTestId('pipeline-row-merged')).toBeDefined();
      expect(screen.getByTestId('pipeline-row-unattributed')).toBeDefined();
    });

    it('renders a single stacked bar in the pipeline panel', () => {
      render(<TelemetryView />);
      const pipelineBar = screen.getByTestId('pipeline-bar');
      expect(pipelineBar.querySelector('[data-testid="stacked-hbar"]')).toBeTruthy();
    });

    it('shows $0 hint for empty columns', () => {
      render(<TelemetryView />);
      // backlog has no tickets → empty hint
      expect(screen.getByTestId('pipeline-empty-backlog').textContent).toContain('$0 — not yet started');
    });

    it('shows cost for columns with tickets', () => {
      render(<TelemetryView />);
      // ticket 43 is in 'merged' column with cost 4.5
      expect(screen.getByTestId('pipeline-cost-merged').textContent).toBe('$4.50');
    });

    it('orchestrator entry is excluded from pipeline grouping (not counted in Unattributed)', () => {
      setupStore({
        byTicket: [
          { ticketId: '__orchestrator__', model: null, cost: 2.0, tokens: { input: 10, output: 5, cacheCreate: 0, cacheRead: 0, total: 15 }, cacheHit: 0, lifecycle: null, unpriced: false },
        ],
      });
      render(<TelemetryView />);
      const unattribRow = screen.getByTestId('pipeline-row-unattributed');
      // orchestrator is excluded — unattributed row should show empty state
      expect(unattribRow.textContent).not.toContain('$2.00');
      expect(unattribRow.textContent).toContain('$0 — not yet started');
    });
  });

  describe('Orchestrator row', () => {
    it('does not render orchestrator row when mixed with real tickets', () => {
      setupStore({
        byTicket: [
          { ticketId: '__orchestrator__', model: null, cost: 2.0, tokens: { input: 10, output: 5, cacheCreate: 0, cacheRead: 0, total: 15 }, cacheHit: 0, lifecycle: null, unpriced: false },
          { ticketId: '42', model: null, cost: 3.0, tokens: { input: 30, output: 15, cacheCreate: 0, cacheRead: 0, total: 45 }, cacheHit: 0, lifecycle: null, unpriced: false },
        ],
      });
      render(<TelemetryView />);
      expect(screen.queryByTestId('ticket-row-__orchestrator__')).toBeNull();
      expect(screen.getByTestId('ticket-row-42')).toBeDefined();
    });

    it('shows "No ticket data" empty state when orchestrator is the only entry', () => {
      setupStore({
        byTicket: [
          { ticketId: '__orchestrator__', model: null, cost: 2.0, tokens: { input: 10, output: 5, cacheCreate: 0, cacheRead: 0, total: 15 }, cacheHit: 0, lifecycle: null, unpriced: false },
        ],
      });
      render(<TelemetryView />);
      expect(screen.queryByTestId('ticket-row-__orchestrator__')).toBeNull();
      expect(screen.getByText('No ticket data')).toBeDefined();
    });

    it('large orchestrator cost does not appear and does not affect real-ticket bar scaling', () => {
      setupStore({
        byTicket: [
          { ticketId: '__orchestrator__', model: null, cost: 1000.0, tokens: { input: 10, output: 5, cacheCreate: 0, cacheRead: 0, total: 15 }, cacheHit: 0, lifecycle: null, unpriced: false },
          { ticketId: '55', model: null, cost: 5.0, tokens: { input: 50, output: 25, cacheCreate: 0, cacheRead: 0, total: 75 }, cacheHit: 0, lifecycle: null, unpriced: false },
        ],
      });
      render(<TelemetryView />);
      expect(screen.queryByTestId('ticket-row-__orchestrator__')).toBeNull();
      const bar = screen.getByTestId('ticket-bar-55');
      // bar should be 100% wide (it's the only real ticket, so maxTicketCost === its cost)
      expect(bar.getAttribute('style')).toContain('width: 100%');
    });
  });

  describe('Zero-cost tickets', () => {
    it('shows "no spend recorded yet" affordance for zero-cost tickets', () => {
      setupStore({
        byTicket: [
          { ticketId: '99', model: null, cost: 0, tokens: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 }, cacheHit: 0, lifecycle: null, unpriced: false },
        ],
      });
      render(<TelemetryView />);
      expect(screen.getByTestId('ticket-no-spend-99')).toBeDefined();
      expect(screen.getByTestId('ticket-no-spend-99').textContent).toContain('no spend recorded yet');
    });

    it('does not show no-spend affordance for tickets with cost > 0', () => {
      render(<TelemetryView />);
      expect(screen.queryByTestId('ticket-no-spend-42')).toBeNull();
    });
  });

  describe('Model legend scaffold', () => {
    it('renders Opus, Sonnet, and Haiku rows even when absent in byModel', () => {
      setupStore({ byModel: [] });
      render(<TelemetryView />);
      expect(screen.getByTestId('model-row-opus')).toBeDefined();
      expect(screen.getByTestId('model-row-sonnet')).toBeDefined();
      expect(screen.getByTestId('model-row-haiku')).toBeDefined();
    });

    it('absent scaffold model shows $0.00', () => {
      setupStore({
        byModel: [
          { model: 'claude-sonnet-4-6', cost: 5.0, tokens: { input: 50000, output: 20000, cacheCreate: 1000, cacheRead: 4000, total: 75000 }, sessions: 3, unpriced: false },
        ],
      });
      render(<TelemetryView />);
      // opus and haiku are absent
      expect(screen.getByTestId('model-row-opus').textContent).toContain('$0.00');
      expect(screen.getByTestId('model-row-haiku').textContent).toContain('$0.00');
    });

    it('donut center matches byModel sum (range total), not monthCost', () => {
      // monthCost = 10.50, but byModel sums to 10.50 (8.0+2.5)
      render(<TelemetryView />);
      const centerLabel = screen.getByTestId('donut-center-label');
      // byModel total = 8.0 + 2.5 = 10.5
      expect(centerLabel.textContent).toBe('$10.50');
    });

    it('donut center shows $0.00 when byModel is empty', () => {
      setupStore({ byModel: [] });
      render(<TelemetryView />);
      const centerLabel = screen.getByTestId('donut-center-label');
      expect(centerLabel.textContent).toBe('$0.00');
    });

    it('extra model not in scaffold is still rendered', () => {
      setupStore({
        byModel: [
          { model: 'claude-gemma-3', cost: 1.0, tokens: { input: 5000, output: 2000, cacheCreate: 0, cacheRead: 0, total: 7000 }, sessions: 1, unpriced: false },
        ],
      });
      render(<TelemetryView />);
      expect(screen.getByTestId('model-row-claude-gemma-3')).toBeDefined();
    });
  });

  describe('Eager telemetry fetch', () => {
    it('fetchTelemetry populates telemetrySummary independently of TelemetryView mounting', async () => {
      const api = mockSandstormApi();
      api.telemetry.summary.mockResolvedValue({
        monthCost: 7.5,
        prevMonthCost: 3.0,
        tokens: { input: 10000, output: 5000, cacheCreate: 500, cacheRead: 2000, total: 17500 },
        cacheHitPct: 16.7,
        sessions: 2,
        ticketsShipped: null,
        costPerTicket: null,
        unpricedModels: [],
        skippedLines: 0,
      });
      // Call directly — simulates App.tsx eager fetch without TelemetryView mounted
      await useAppStore.getState().fetchTelemetry();
      expect(useAppStore.getState().telemetrySummary?.monthCost).toBe(7.5);
    });
  });

  describe('Preload type guard (setup mock)', () => {
    it('window.sandstorm.telemetry.byTicket exists on the mock API', () => {
      expect(typeof window.sandstorm.telemetry.byTicket).toBe('function');
    });

    it('window.sandstorm.telemetry.refresh exists on the mock API', () => {
      expect(typeof window.sandstorm.telemetry.refresh).toBe('function');
    });
  });
});
