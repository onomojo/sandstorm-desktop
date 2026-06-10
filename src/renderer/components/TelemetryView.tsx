import React, { useEffect, useState } from 'react';
import { useAppStore } from '../store';
import type { KanbanColumn } from '../types/kanban';
import type { ByTicketEntry, ByModelEntry, LifecycleCosts } from '@main/telemetry/types';
import { Sparkline } from './telemetry/Sparkline';
import { Donut } from './telemetry/Donut';
import { StackedBars } from './telemetry/StackedBars';
import type { TokenClass } from './telemetry/StackedBars';
import { TOKEN_COLORS, TOKEN_LABELS } from './telemetry/StackedBars';
import { groupByPipeline, ORCHESTRATOR_TICKET_ID } from './telemetry/utils';
import { formatTokensCompact } from '../utils/format';
import { StackedHBar } from './telemetry/StackedHBar';

type RangeOption = '7d' | '30d' | '90d' | 'all';
type LifecycleStage = keyof LifecycleCosts;
type SortKey = 'total' | LifecycleStage;

const RANGE_LABELS: Record<RangeOption, string> = {
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
  all: 'All',
};

const LIFECYCLE_STAGES: LifecycleStage[] = ['refine', 'spec', 'execution', 'review', 'verify', 'pr'];

const LIFECYCLE_COLORS: Record<LifecycleStage, string> = {
  refine: '#c9a227',
  spec: '#4a7fb5',
  execution: '#7b5ea7',
  review: '#d4a854',
  verify: '#4a8c6e',
  pr: '#e87b5a',
};

const MODEL_PALETTE = ['#d4a854', '#7b5ea7', '#4a7fb5', '#4a8c6e', '#c9a227', '#e87b5a'];

const MODEL_FAMILIES: Array<{ key: string; displayLabel: string; color: string }> = [
  { key: 'opus', displayLabel: 'Opus', color: MODEL_PALETTE[0] },
  { key: 'sonnet', displayLabel: 'Sonnet', color: MODEL_PALETTE[1] },
  { key: 'haiku', displayLabel: 'Haiku', color: MODEL_PALETTE[2] },
];

interface ModelRow {
  key: string;
  label: string;
  color: string;
  cost: number;
  unpriced: boolean;
}

function getModelFamily(model: string): string | null {
  const lc = model.toLowerCase();
  for (const { key } of MODEL_FAMILIES) {
    if (lc.includes(key)) return key;
  }
  return null;
}

function buildModelRows(byModel: ByModelEntry[]): ModelRow[] {
  const familyCosts: Record<string, { cost: number; unpriced: boolean }> = {};
  const extras: ByModelEntry[] = [];

  for (const entry of byModel) {
    const family = getModelFamily(entry.model);
    if (family) {
      if (!familyCosts[family]) familyCosts[family] = { cost: 0, unpriced: false };
      familyCosts[family].cost += entry.cost;
      familyCosts[family].unpriced = familyCosts[family].unpriced || entry.unpriced;
    } else {
      extras.push(entry);
    }
  }

  const rows: ModelRow[] = MODEL_FAMILIES.map(({ key, displayLabel, color }) => ({
    key,
    label: displayLabel,
    color,
    cost: familyCosts[key]?.cost ?? 0,
    unpriced: familyCosts[key]?.unpriced ?? false,
  }));

  extras.forEach((entry, i) => {
    rows.push({
      key: entry.model,
      label: entry.model,
      color: MODEL_PALETTE[(MODEL_FAMILIES.length + i) % MODEL_PALETTE.length],
      cost: entry.cost,
      unpriced: entry.unpriced,
    });
  });

  return rows;
}

function fmt$(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}


function fmtDelta(curr: number, prev: number): string {
  if (prev === 0) return '—';
  const pct = ((curr - prev) / prev) * 100;
  const sign = pct >= 0 ? '▲' : '▼';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

function fmtDeltaWithDir(curr: number, prev: number): string {
  if (prev === 0) return '—';
  const pct = ((curr - prev) / prev) * 100;
  const sign = pct >= 0 ? '▲' : '▼';
  const dir = pct >= 0 ? 'higher' : 'lower';
  return `${sign}${Math.abs(pct).toFixed(1)}% ${dir}`;
}

const ALL_TOKEN_CLASSES: TokenClass[] = ['input', 'output', 'cacheCreate', 'cacheRead'];

export function TelemetryView() {
  const {
    telemetryRange,
    setTelemetryRange,
    fetchTelemetry,
    refreshTelemetry,
    telemetrySummary,
    telemetryDaily,
    telemetryByModel,
    telemetryByTicket,
    telemetryLoading,
    telemetryError,
    boardTickets,
    activeProject,
  } = useAppStore();

  const project = activeProject();

  // Fetch on mount
  useEffect(() => {
    void fetchTelemetry();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Daily chart toggle state
  const [activeClasses, setActiveClasses] = useState<Set<TokenClass>>(
    new Set(ALL_TOKEN_CLASSES),
  );

  // Per-ticket sort state
  const [sortKey, setSortKey] = useState<SortKey>('total');

  const toggleClass = (cls: TokenClass) => {
    setActiveClasses((prev) => {
      const next = new Set(prev);
      if (next.has(cls)) {
        next.delete(cls);
      } else {
        next.add(cls);
      }
      return next;
    });
  };

  // Derived: daily cost for sparkline
  const dailyCosts = telemetryDaily.map((d) => d.cost);

  // Derived: per-ticket rows (join with boardTickets for title/column), orchestrator excluded
  const ticketRows = telemetryByTicket
    .filter((entry) => entry.ticketId !== ORCHESTRATOR_TICKET_ID)
    .map((entry) => {
      const board = boardTickets.find((t) => t.ticket_id === entry.ticketId);
      return {
        ...entry,
        title: board?.title ?? `#${entry.ticketId}`,
        column: board?.column as KanbanColumn | undefined,
        displayId: `#${entry.ticketId}`,
      };
    });

  // Sort tickets
  const sortedTickets = [...ticketRows].sort((a, b) => {
    if (sortKey === 'total') return b.cost - a.cost;
    const aVal = a.lifecycle?.[sortKey] ?? 0;
    const bVal = b.lifecycle?.[sortKey] ?? 0;
    if (bVal !== aVal) return bVal - aVal;
    return b.cost - a.cost; // stable tie-break
  });

  // Max ticket cost for bar scaling (zero-cost tickets get affordance, not bars)
  const maxTicketCost = sortedTickets.reduce((m, t) => Math.max(m, t.cost), 0);

  // Pipeline groups
  const pipelineGroups = groupByPipeline(telemetryByTicket, boardTickets);
  const pipelineTotal = pipelineGroups.reduce((s, g) => s + g.totalCost, 0);

  // Month-vs-last bar scaling
  const monthMax = Math.max(
    telemetrySummary?.monthCost ?? 0,
    telemetrySummary?.prevMonthCost ?? 0,
    0.0001,
  );

  // Model rows with fixed scaffold + extras
  const modelRows = buildModelRows(telemetryByModel);
  const modelTotal = modelRows.reduce((s, r) => s + r.cost, 0);
  const modelSegments = modelRows
    .filter((r) => r.cost > 0)
    .map((r) => ({ value: r.cost, color: r.color, label: r.label }));

  const hasLifecycle = telemetryByTicket.some((e) => e.lifecycle !== null);

  if (telemetryLoading && !telemetrySummary) {
    return (
      <div className="flex-1 flex items-center justify-center text-sandstorm-muted" data-testid="telemetry-loading">
        Loading telemetry…
      </div>
    );
  }

  if (telemetryError) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3" data-testid="telemetry-error">
        <span className="text-sandstorm-muted text-sm">{telemetryError}</span>
        <button
          onClick={() => void fetchTelemetry()}
          className="px-4 py-2 bg-sandstorm-surface border border-sandstorm-border rounded-lg text-sandstorm-text text-sm hover:border-sandstorm-border-light transition-colors"
          data-testid="telemetry-retry-btn"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-sandstorm-bg" data-testid="telemetry-view">
      {/* Header */}
      <div className="shrink-0 border-b border-sandstorm-border px-6 pt-5 pb-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            {project && (
              <span className="text-sandstorm-muted text-sm truncate max-w-[200px]">{project.name}</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Range chips */}
            <div className="flex items-center gap-1" data-testid="range-chips">
              {(['7d', '30d', '90d', 'all'] as RangeOption[]).map((r) => (
                <button
                  key={r}
                  onClick={() => setTelemetryRange(r)}
                  className={`px-2.5 py-1 rounded text-xs font-mono transition-colors ${
                    telemetryRange === r
                      ? 'bg-sandstorm-accent text-sandstorm-rail font-semibold'
                      : 'bg-sandstorm-surface border border-sandstorm-border text-sandstorm-muted hover:text-sandstorm-text'
                  }`}
                  data-testid={`range-chip-${r}`}
                >
                  {RANGE_LABELS[r]}
                </button>
              ))}
            </div>

            <button
              onClick={() => void refreshTelemetry()}
              className="p-1.5 rounded text-sandstorm-muted hover:text-sandstorm-text hover:bg-sandstorm-surface transition-colors"
              title="Refresh telemetry"
              data-testid="telemetry-refresh-btn"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <polyline points="23 4 23 10 17 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Panels */}
      <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">

        {/* Panel 1: KPI bar */}
        <div className="grid grid-cols-4 gap-3" data-testid="panel-kpi">
          {/* Spend this month */}
          <div className="bg-sandstorm-surface rounded-xl border border-sandstorm-border p-4 flex flex-col gap-2">
            <span className="text-[11px] text-sandstorm-muted uppercase tracking-wider">Spend this month</span>
            <span className="text-2xl font-mono font-bold text-sandstorm-text" data-testid="kpi-month-cost">
              {telemetrySummary ? fmt$(telemetrySummary.monthCost) : '—'}
            </span>
            <div className="flex items-center justify-between">
              <span
                className="text-xs font-mono text-sandstorm-muted"
                data-testid="kpi-month-delta"
              >
                {telemetrySummary
                  ? fmtDelta(telemetrySummary.monthCost, telemetrySummary.prevMonthCost)
                  : '—'}
              </span>
              <Sparkline data={dailyCosts} width={60} height={24} />
            </div>
          </div>

          {/* Tokens */}
          <div className="bg-sandstorm-surface rounded-xl border border-sandstorm-border p-4 flex flex-col gap-2">
            <span className="text-[11px] text-sandstorm-muted uppercase tracking-wider">Tokens</span>
            <span className="text-2xl font-mono font-bold text-sandstorm-text" data-testid="kpi-tokens-total">
              {telemetrySummary ? formatTokensCompact(telemetrySummary.tokens.total) : '—'}
            </span>
            <span className="text-xs font-mono text-sandstorm-muted" data-testid="kpi-tokens-inout">
              {telemetrySummary
                ? `in ${formatTokensCompact(telemetrySummary.tokens.input)} / out ${formatTokensCompact(telemetrySummary.tokens.output)}`
                : '—'}
            </span>
          </div>

          {/* Cache hit rate */}
          <div className="bg-sandstorm-surface rounded-xl border border-sandstorm-border p-4 flex flex-col gap-2">
            <span className="text-[11px] text-sandstorm-muted uppercase tracking-wider">Cache hit rate</span>
            <span className="text-2xl font-mono font-bold text-sandstorm-text" data-testid="kpi-cache-hit">
              {telemetrySummary ? `${telemetrySummary.cacheHitPct.toFixed(1)}%` : '—'}
            </span>
            <span className="text-xs text-sandstorm-muted">of input tokens</span>
          </div>

          {/* Cost/ticket */}
          <div className="bg-sandstorm-surface rounded-xl border border-sandstorm-border p-4 flex flex-col gap-2">
            <span className="text-[11px] text-sandstorm-muted uppercase tracking-wider">Cost / ticket</span>
            <span className="text-2xl font-mono font-bold text-sandstorm-text" data-testid="kpi-cost-per-ticket">
              {telemetrySummary?.costPerTicket != null ? fmt$(telemetrySummary.costPerTicket) : '—'}
            </span>
            <span className="text-xs font-mono text-sandstorm-muted" data-testid="kpi-tickets-subline">
              {telemetrySummary?.ticketsShipped != null
                ? `${telemetrySummary.ticketsShipped} merged · ${telemetrySummary.sessions} sessions`
                : '—'}
            </span>
          </div>
        </div>

        {/* Panel 2: Daily token usage */}
        <div className="bg-sandstorm-surface rounded-xl border border-sandstorm-border p-4" data-testid="panel-daily">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-sandstorm-text">Daily Token Usage</span>
            <div className="flex items-center gap-1.5" data-testid="token-class-toggles">
              {ALL_TOKEN_CLASSES.map((cls) => (
                <button
                  key={cls}
                  onClick={() => toggleClass(cls)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors border ${
                    activeClasses.has(cls)
                      ? 'border-transparent text-sandstorm-text'
                      : 'border-sandstorm-border text-sandstorm-muted opacity-50'
                  }`}
                  style={activeClasses.has(cls) ? { backgroundColor: TOKEN_COLORS[cls] + '33', borderColor: TOKEN_COLORS[cls] + '66' } : {}}
                  data-testid={`toggle-${cls}`}
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: TOKEN_COLORS[cls] }}
                  />
                  {TOKEN_LABELS[cls]}
                </button>
              ))}
            </div>
          </div>
          <StackedBars
            data={telemetryDaily}
            activeClasses={activeClasses}
            width={900}
            height={120}
          />
        </div>

        {/* Panels 3 & 6 side by side */}
        <div className="grid grid-cols-2 gap-4">
          {/* Panel 3: Cost by model */}
          <div className="bg-sandstorm-surface rounded-xl border border-sandstorm-border p-4" data-testid="panel-by-model">
            <div className="text-sm font-medium text-sandstorm-text mb-3">Cost by Model</div>
            <div className="flex items-center gap-4">
              <Donut
                segments={modelSegments}
                size={100}
                centerLabel={fmt$(modelTotal)}
              />
              <div className="flex flex-col gap-1.5 flex-1 min-w-0">
                {modelRows.map((row) => (
                  <div key={row.key} className="flex items-center justify-between gap-2" data-testid={`model-row-${row.key}`}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: row.color }}
                      />
                      <span className="text-xs text-sandstorm-text-secondary truncate">{row.label}</span>
                      {row.unpriced && (
                        <span className="text-[10px] text-amber-400 shrink-0" title="No price data for this model">unpriced</span>
                      )}
                    </div>
                    <span className="text-xs font-mono text-sandstorm-text shrink-0">{fmt$(row.cost)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Panel 6: This month vs last */}
          <div className="bg-sandstorm-surface rounded-xl border border-sandstorm-border p-4" data-testid="panel-month-vs-last">
            <div className="text-sm font-medium text-sandstorm-text mb-3">This Month vs Last</div>
            {telemetrySummary ? (
              <div className="flex flex-col gap-3">
                {/* Horizontal bars */}
                <div className="flex flex-col gap-2" data-testid="month-vs-bars">
                  {[
                    { label: 'This month', cost: telemetrySummary.monthCost, testId: 'bar-this-month' },
                    { label: 'Last month', cost: telemetrySummary.prevMonthCost, testId: 'bar-last-month' },
                  ].map(({ label, cost, testId }) => (
                    <div key={label} className="flex items-center gap-2">
                      <span className="text-xs text-sandstorm-muted w-[72px] shrink-0">{label}</span>
                      <div className="flex-1 bg-sandstorm-border/30 rounded overflow-hidden h-4">
                        <div
                          className="h-full rounded bg-sandstorm-accent"
                          style={{ width: `${Math.max((cost / monthMax) * 100, cost > 0 ? 1 : 0)}%` }}
                          data-testid={testId}
                          data-cost={cost}
                          data-width-pct={(cost / monthMax) * 100}
                        />
                      </div>
                      <span className="text-xs font-mono text-sandstorm-text w-12 text-right shrink-0">{fmt$(cost)}</span>
                    </div>
                  ))}
                </div>
                <span
                  className={`text-sm font-mono font-bold ${
                    telemetrySummary.monthCost >= telemetrySummary.prevMonthCost
                      ? 'text-red-400'
                      : 'text-emerald-400'
                  }`}
                  data-testid="month-delta"
                >
                  {fmtDeltaWithDir(telemetrySummary.monthCost, telemetrySummary.prevMonthCost)}
                </span>
                <Sparkline data={dailyCosts} width={220} height={40} />
              </div>
            ) : (
              <div className="text-sandstorm-muted text-xs py-4 text-center">No data</div>
            )}
          </div>
        </div>

        {/* Panel 4: Per-ticket lifecycle breakdown */}
        <div className="bg-sandstorm-surface rounded-xl border border-sandstorm-border p-4" data-testid="panel-by-ticket">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <span className="text-sm font-medium text-sandstorm-text">Per-Ticket Cost</span>
            <div className="flex items-center gap-1 flex-wrap" data-testid="sort-chips">
              {/* Total chip */}
              <button
                onClick={() => setSortKey('total')}
                className={`px-2 py-1 rounded text-xs transition-colors border ${
                  sortKey === 'total'
                    ? 'bg-sandstorm-accent/20 border-sandstorm-accent/40 text-sandstorm-accent font-semibold'
                    : 'border-sandstorm-border text-sandstorm-muted hover:text-sandstorm-text'
                }`}
                data-testid="sort-total"
              >
                Total
              </button>
              {/* Stage chips */}
              {LIFECYCLE_STAGES.map((stage) => (
                <button
                  key={stage}
                  onClick={() => hasLifecycle && setSortKey(stage)}
                  disabled={!hasLifecycle}
                  className={`px-2 py-1 rounded text-xs transition-colors border ${
                    sortKey === stage
                      ? 'border-transparent font-semibold text-sandstorm-rail'
                      : !hasLifecycle
                      ? 'border-sandstorm-border text-sandstorm-muted opacity-40 cursor-not-allowed'
                      : 'border-sandstorm-border text-sandstorm-muted hover:text-sandstorm-text'
                  }`}
                  style={sortKey === stage ? { backgroundColor: LIFECYCLE_COLORS[stage] } : {}}
                  data-testid={`sort-${stage}`}
                >
                  {stage}
                </button>
              ))}
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            {LIFECYCLE_STAGES.map((stage) => (
              <div key={stage} className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: LIFECYCLE_COLORS[stage] }} />
                <span className="text-[10px] text-sandstorm-muted">{stage}</span>
              </div>
            ))}
          </div>

          {sortedTickets.length === 0 ? (
            <div className="text-sandstorm-muted text-xs py-4 text-center">No ticket data</div>
          ) : (
            <div className="flex flex-col gap-2" data-testid="ticket-rows">
              {sortedTickets.map((entry) => {
                const barWidthPct = maxTicketCost > 0 ? (entry.cost / maxTicketCost) * 100 : 0;
                const rightValue =
                  sortKey === 'total' || !entry.lifecycle
                    ? fmt$(entry.cost)
                    : fmt$(entry.lifecycle[sortKey as LifecycleStage]);

                return (
                  <div key={entry.ticketId} className="flex items-center gap-3" data-testid={`ticket-row-${entry.ticketId}`}>
                    <span className="text-xs font-mono text-sandstorm-muted shrink-0 w-14 truncate">
                      {entry.displayId}
                    </span>
                    <span className="text-xs text-sandstorm-text-secondary shrink-0 w-32 truncate" title={entry.title}>
                      {entry.title}
                    </span>
                    <div className="flex-1 relative h-4 bg-sandstorm-border/30 rounded overflow-hidden">
                      {entry.cost === 0 ? (
                        <span className="text-xs text-sandstorm-muted italic pl-1" data-testid={`ticket-no-spend-${entry.ticketId}`}>
                          no spend recorded yet
                        </span>
                      ) : entry.lifecycle ? (
                        <div style={{ width: `${barWidthPct}%`, height: '100%' }}>
                          <StackedHBar
                            segments={LIFECYCLE_STAGES.map((stage) => ({
                              value: entry.lifecycle![stage],
                              color: LIFECYCLE_COLORS[stage],
                              label: `${stage}: ${fmt$(entry.lifecycle![stage])}`,
                              dimmed: sortKey !== 'total' && sortKey !== stage,
                            }))}
                            height={16}
                          />
                        </div>
                      ) : (
                        // Single full-width bar (no lifecycle)
                        <div
                          className="h-full rounded bg-sandstorm-muted/50"
                          style={{ width: `${barWidthPct}%` }}
                          data-testid={`ticket-bar-${entry.ticketId}`}
                        />
                      )}
                    </div>
                    <span className="text-xs font-mono text-sandstorm-text shrink-0 w-16 text-right" data-testid={`ticket-cost-${entry.ticketId}`}>
                      {rightValue}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Panel 5: Spend by pipeline stage */}
        <div className="bg-sandstorm-surface rounded-xl border border-sandstorm-border p-4" data-testid="panel-pipeline">
          <div className="text-sm font-medium text-sandstorm-text mb-3">Spend by Pipeline Stage</div>
          {/* Single 100% stacked bar */}
          <div className="mb-3" data-testid="pipeline-bar">
            <StackedHBar
              segments={pipelineGroups
                .filter((g) => g.totalCost > 0)
                .map((g) => ({
                  value: g.totalCost,
                  color: g.color,
                  label: `${g.displayName}: ${fmt$(g.totalCost)} (${pipelineTotal > 0 ? g.pct.toFixed(1) : '0'}%)`,
                }))}
              height={16}
            />
          </div>
          {/* Per-column figure rows */}
          <div className="flex flex-col gap-2">
            {pipelineGroups.map((group) => (
              <div key={group.column} className="flex items-center gap-3" data-testid={`pipeline-row-${group.column}`}>
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: group.color }}
                />
                <span className="text-xs text-sandstorm-text-secondary shrink-0 w-24">{group.displayName}</span>
                {group.totalCost > 0 ? (
                  <>
                    <span className="text-xs font-mono text-sandstorm-text" data-testid={`pipeline-cost-${group.column}`}>
                      {fmt$(group.totalCost)}
                    </span>
                    <span className="text-xs font-mono text-sandstorm-muted" data-testid={`pipeline-pct-${group.column}`}>
                      {pipelineTotal > 0 ? `${group.pct.toFixed(1)}%` : '0%'}
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-sandstorm-muted" data-testid={`pipeline-empty-${group.column}`}>
                    $0 — not yet started
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
