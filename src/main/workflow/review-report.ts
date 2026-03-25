export type ReviewDimension =
  | 'architecture'
  | 'bestPractices'
  | 'separationOfConcerns'
  | 'dry'
  | 'security'
  | 'scalability'
  | 'optimizations'
  | 'testCoverage';

export const ALL_REVIEW_DIMENSIONS: readonly ReviewDimension[] = [
  'architecture',
  'bestPractices',
  'separationOfConcerns',
  'dry',
  'security',
  'scalability',
  'optimizations',
  'testCoverage',
] as const;

export interface DimensionResult {
  dimension: ReviewDimension;
  passed: boolean;
  comments: string;
}

export interface ReviewReport {
  passed: boolean;
  dimensions: DimensionResult[];
  summary: string;
}

export function createPassingReport(summary = 'All checks passed'): ReviewReport {
  return {
    passed: true,
    dimensions: ALL_REVIEW_DIMENSIONS.map((dimension) => ({
      dimension,
      passed: true,
      comments: '',
    })),
    summary,
  };
}

export function createFailingReport(
  failedDimensions: Partial<Record<ReviewDimension, string>>,
  summary: string
): ReviewReport {
  const dimensions: DimensionResult[] = ALL_REVIEW_DIMENSIONS.map((dimension) => ({
    dimension,
    passed: !(dimension in failedDimensions),
    comments: failedDimensions[dimension] ?? '',
  }));

  return {
    passed: false,
    dimensions,
    summary,
  };
}
