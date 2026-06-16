import { ORCHESTRATOR_TICKET_ID } from '../../../shared/constants';
import type { ByTicketEntry, LifecycleCosts } from '@main/telemetry/types';
export { ORCHESTRATOR_TICKET_ID };

export type LifecycleStage = keyof LifecycleCosts;

export const LIFECYCLE_STAGES: LifecycleStage[] = ['refine', 'spec', 'execution', 'review', 'verify', 'pr'];

export const LIFECYCLE_STAGE_NAMES: Record<LifecycleStage, string> = {
  refine: 'Refine',
  spec: 'Spec',
  execution: 'Execution',
  review: 'Review',
  verify: 'Verify',
  pr: 'PR',
};

export const LIFECYCLE_COLORS: Record<LifecycleStage, string> = {
  refine: '#c9a227',
  spec: '#4a7fb5',
  execution: '#7b5ea7',
  review: '#d4a854',
  verify: '#4a8c6e',
  pr: '#e87b5a',
};

export interface LifecycleStageGroup {
  stage: LifecycleStage;
  displayName: string;
  color: string;
  totalCost: number;
  pct: number;
}

export function groupByLifecycleStage(byTicket: ByTicketEntry[]): LifecycleStageGroup[] {
  const stageTotals: Partial<Record<LifecycleStage, number>> = {};

  for (const entry of byTicket) {
    if (entry.ticketId === ORCHESTRATOR_TICKET_ID) continue;
    if (entry.lifecycle === null) continue;

    for (const stage of LIFECYCLE_STAGES) {
      stageTotals[stage] = (stageTotals[stage] ?? 0) + entry.lifecycle[stage];
    }
  }

  const grandTotal = LIFECYCLE_STAGES.reduce((s, st) => s + (stageTotals[st] ?? 0), 0);

  return LIFECYCLE_STAGES.map((stage) => {
    const totalCost = stageTotals[stage] ?? 0;
    const pct = grandTotal > 0 ? (totalCost / grandTotal) * 100 : 0;
    return {
      stage,
      displayName: LIFECYCLE_STAGE_NAMES[stage],
      color: LIFECYCLE_COLORS[stage],
      totalCost,
      pct,
    };
  });
}
