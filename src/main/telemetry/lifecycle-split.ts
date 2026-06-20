/**
 * Pure, electron-free lifecycle cost split.
 *
 * Takes the authoritative ticket cost (from transcripts) and per-stage weights,
 * returns the six-stage USD breakdown whose sum equals cost exactly.
 *
 * verify weight is always forced to 0 — verify runs .sandstorm/verify.sh
 * (tests/build), not run_claude, so it has no LLM spend.
 */

import type { LifecycleCosts } from './types';

export type LifecycleStage = 'refine' | 'spec' | 'execution' | 'review' | 'verify' | 'pr' | 'reconcile';

export const LIFECYCLE_STAGES: readonly LifecycleStage[] = [
  'refine', 'spec', 'execution', 'review', 'verify', 'pr', 'reconcile',
];

export type LifecycleWeights = Partial<Record<LifecycleStage, number>>;

/**
 * Split `cost` across the six lifecycle stages proportionally by `weights`.
 *
 * Rules:
 * - verify is always 0 (no LLM spend) regardless of the weights input
 * - All six keys are always present in the result
 * - When cost === 0, returns all-zero object
 * - When all effective weights are 0 and cost > 0, returns null (no signal)
 * - Residual from floating-point rounding is assigned to the largest-weight
 *   stage so sum(result) === cost exactly (within 1e-10 tolerance)
 */
export function computeLifecycleSplit(
  cost: number,
  weights: LifecycleWeights,
): LifecycleCosts | null {
  const effective: Record<LifecycleStage, number> = {
    refine: weights.refine ?? 0,
    spec: weights.spec ?? 0,
    execution: weights.execution ?? 0,
    review: weights.review ?? 0,
    verify: 0,  // always zero — no LLM spend
    pr: weights.pr ?? 0,
    reconcile: 0,  // no per-ticket producer yet; sourced from epic_tasks.role in aggregateByEpic
  };

  if (cost === 0) {
    return { refine: 0, spec: 0, execution: 0, review: 0, verify: 0, pr: 0 };
  }

  const totalWeight = LIFECYCLE_STAGES.reduce((s, stage) => s + effective[stage], 0);
  if (totalWeight === 0) return null;

  const splits: Record<LifecycleStage, number> = {} as Record<LifecycleStage, number>;
  for (const stage of LIFECYCLE_STAGES) {
    splits[stage] = cost * (effective[stage] / totalWeight);
  }

  // Assign floating-point residual to the largest-weight stage
  const sumSplits = LIFECYCLE_STAGES.reduce((s, stage) => s + splits[stage], 0);
  const residual = cost - sumSplits;

  let largestStage: LifecycleStage = LIFECYCLE_STAGES[0];
  let largestWeight = -1;
  for (const stage of LIFECYCLE_STAGES) {
    if (effective[stage] > largestWeight) {
      largestWeight = effective[stage];
      largestStage = stage;
    }
  }
  splits[largestStage] += residual;

  // Return only the six LifecycleCosts keys — reconcile is tracked in effective but
  // has no per-ticket producer yet (it is sourced from epic_tasks.role at the epic level).
  return {
    refine: splits.refine,
    spec: splits.spec,
    execution: splits.execution,
    review: splits.review,
    verify: splits.verify,
    pr: splits.pr,
  };
}
