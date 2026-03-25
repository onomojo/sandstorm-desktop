import { describe, it, expect, beforeEach } from 'vitest';
import {
  DualLoopWorkflow,
  MAX_INNER_ITERATIONS,
  MAX_OUTER_ITERATIONS,
  HUMAN_INTERVENTION_MESSAGE,
} from '../../../src/main/workflow/dual-loop';
import {
  ReviewReport,
  createPassingReport,
  createFailingReport,
  ALL_REVIEW_DIMENSIONS,
  DimensionResult,
} from '../../../src/main/workflow/review-report';

describe('DualLoopWorkflow', () => {
  let workflow: DualLoopWorkflow;

  beforeEach(() => {
    workflow = new DualLoopWorkflow();
  });

  describe('initial state', () => {
    it('starts in idle phase with zero counters', () => {
      const state = workflow.getState();
      expect(state.phase).toBe('idle');
      expect(state.innerCount).toBe(0);
      expect(state.outerCount).toBe(0);
      expect(state.reviewReports).toEqual([]);
      expect(state.verifyErrors).toEqual([]);
    });
  });

  describe('state transitions', () => {
    it('transitions idle -> execution -> review -> verify -> done', () => {
      workflow.startExecution();
      expect(workflow.getState().phase).toBe('execution');

      workflow.submitForReview();
      expect(workflow.getState().phase).toBe('review');

      workflow.handleReviewResult(createPassingReport());
      expect(workflow.getState().phase).toBe('verify');

      workflow.runVerify(true);
      expect(workflow.getState().phase).toBe('done');
    });

    it('loops back to execution when review fails', () => {
      workflow.startExecution();
      workflow.submitForReview();

      const failReport = createFailingReport({ security: 'SQL injection risk' }, 'Issues found');
      workflow.handleReviewResult(failReport);

      expect(workflow.getState().phase).toBe('execution');
      expect(workflow.getState().innerCount).toBe(2);
    });

    it('loops back to execution when verify fails', () => {
      workflow.startExecution();
      workflow.submitForReview();
      workflow.handleReviewResult(createPassingReport());
      workflow.runVerify(false, 'Type errors found');

      expect(workflow.getState().phase).toBe('execution');
      expect(workflow.getState().outerCount).toBe(2);
      expect(workflow.getState().verifyErrors).toEqual(['Type errors found']);
    });
  });

  describe('inner loop counting and max limit', () => {
    it('increments inner count on each review failure', () => {
      workflow.startExecution();
      const fail = createFailingReport({ dry: 'Duplicated code' }, 'Fix needed');

      for (let i = 1; i < MAX_INNER_ITERATIONS; i++) {
        workflow.submitForReview();
        workflow.handleReviewResult(fail);
        expect(workflow.getState().innerCount).toBe(i + 1);
        expect(workflow.getState().phase).toBe('execution');
      }
    });

    it('transitions to failed when inner loop exceeds max iterations', () => {
      workflow.startExecution();
      const fail = createFailingReport({ architecture: 'Bad pattern' }, 'Needs rework');

      // Use all 5 inner iterations
      for (let i = 1; i < MAX_INNER_ITERATIONS; i++) {
        workflow.submitForReview();
        workflow.handleReviewResult(fail);
      }

      // 5th review failure should trigger failed state
      workflow.submitForReview();
      workflow.handleReviewResult(fail);
      expect(workflow.getState().phase).toBe('failed');
      expect(workflow.getState().innerCount).toBe(MAX_INNER_ITERATIONS);
    });
  });

  describe('outer loop counting and max limit', () => {
    it('increments outer count on each verify failure', () => {
      for (let i = 1; i < MAX_OUTER_ITERATIONS; i++) {
        workflow.startExecution();
        workflow.submitForReview();
        workflow.handleReviewResult(createPassingReport());
        workflow.runVerify(false, `Error ${i}`);
        expect(workflow.getState().outerCount).toBe(i + 1);
        expect(workflow.getState().phase).toBe('execution');
      }
    });

    it('transitions to failed when outer loop exceeds max iterations', () => {
      // Use all 5 outer iterations
      for (let i = 0; i < MAX_OUTER_ITERATIONS; i++) {
        workflow.startExecution();
        workflow.submitForReview();
        workflow.handleReviewResult(createPassingReport());

        if (i < MAX_OUTER_ITERATIONS - 1) {
          workflow.runVerify(false, `Error ${i}`);
        }
      }

      // 5th verify failure should trigger failed state
      workflow.runVerify(false, 'Final error');
      expect(workflow.getState().phase).toBe('failed');
      expect(workflow.getState().outerCount).toBe(MAX_OUTER_ITERATIONS);
    });
  });

  describe('inner counter resets on outer loop iteration', () => {
    it('resets inner count to 1 when verify fails and outer loop iterates', () => {
      workflow.startExecution();

      // Burn through some inner iterations
      const fail = createFailingReport({ dry: 'Dup' }, 'Fix');
      workflow.submitForReview();
      workflow.handleReviewResult(fail);
      expect(workflow.getState().innerCount).toBe(2);

      workflow.submitForReview();
      workflow.handleReviewResult(fail);
      expect(workflow.getState().innerCount).toBe(3);

      // Now pass review and fail verify
      workflow.submitForReview();
      workflow.handleReviewResult(createPassingReport());
      workflow.runVerify(false, 'Build failed');

      // Inner counter should reset
      expect(workflow.getState().innerCount).toBe(1);
      expect(workflow.getState().outerCount).toBe(2);
      expect(workflow.getState().phase).toBe('execution');
    });
  });

  describe('human intervention message', () => {
    it('exports the HUMAN_INTERVENTION_REQUIRED message constant', () => {
      expect(HUMAN_INTERVENTION_MESSAGE).toBe('HUMAN INTERVENTION REQUIRED');
    });

    it('enters failed state when inner limit exceeded', () => {
      workflow.startExecution();
      const fail = createFailingReport({ security: 'Issue' }, 'Fail');

      for (let i = 0; i < MAX_INNER_ITERATIONS; i++) {
        workflow.submitForReview();
        if (i < MAX_INNER_ITERATIONS - 1) {
          workflow.handleReviewResult(fail);
        }
      }

      workflow.handleReviewResult(fail);
      expect(workflow.getState().phase).toBe('failed');
    });

    it('enters failed state when outer limit exceeded', () => {
      for (let i = 0; i < MAX_OUTER_ITERATIONS; i++) {
        workflow.startExecution();
        workflow.submitForReview();
        workflow.handleReviewResult(createPassingReport());
        if (i < MAX_OUTER_ITERATIONS - 1) {
          workflow.runVerify(false);
        }
      }

      workflow.runVerify(false);
      expect(workflow.getState().phase).toBe('failed');
    });
  });

  describe('error handling', () => {
    it('throws when submitting for review from non-execution phase', () => {
      expect(() => workflow.submitForReview()).toThrow('Cannot submit for review from phase: idle');
    });

    it('throws when handling review result from non-review phase', () => {
      expect(() => workflow.handleReviewResult(createPassingReport())).toThrow(
        'Cannot handle review result from phase: idle'
      );
    });

    it('throws when running verify from non-verify phase', () => {
      expect(() => workflow.runVerify(true)).toThrow('Cannot run verify from phase: idle');
    });

    it('throws when starting execution from invalid phase', () => {
      workflow.startExecution();
      workflow.submitForReview();
      expect(() => workflow.startExecution()).toThrow(
        'Cannot start execution from phase: review'
      );
    });

    it('allows calling startExecution when already in execution phase', () => {
      workflow.startExecution();
      expect(() => workflow.startExecution()).not.toThrow();
      expect(workflow.getState().phase).toBe('execution');
    });
  });

  describe('review reports are accumulated', () => {
    it('stores all review reports in state', () => {
      workflow.startExecution();

      const fail = createFailingReport({ dry: 'Duplicated' }, 'Fix duplication');
      workflow.submitForReview();
      workflow.handleReviewResult(fail);

      const pass = createPassingReport('Looks good');
      workflow.submitForReview();
      workflow.handleReviewResult(pass);

      const state = workflow.getState();
      expect(state.reviewReports).toHaveLength(2);
      expect(state.reviewReports[0].passed).toBe(false);
      expect(state.reviewReports[1].passed).toBe(true);
    });
  });
});

describe('ReviewReport structure', () => {
  it('createPassingReport creates a report with all dimensions passing', () => {
    const report = createPassingReport();
    expect(report.passed).toBe(true);
    expect(report.dimensions).toHaveLength(ALL_REVIEW_DIMENSIONS.length);
    report.dimensions.forEach((dim: DimensionResult) => {
      expect(dim.passed).toBe(true);
      expect(dim.comments).toBe('');
    });
  });

  it('createFailingReport marks specified dimensions as failed', () => {
    const report = createFailingReport(
      {
        security: 'XSS vulnerability',
        dry: 'Code duplicated in 3 places',
      },
      'Two issues found'
    );

    expect(report.passed).toBe(false);
    expect(report.summary).toBe('Two issues found');

    const secDim = report.dimensions.find((d) => d.dimension === 'security');
    expect(secDim?.passed).toBe(false);
    expect(secDim?.comments).toBe('XSS vulnerability');

    const dryDim = report.dimensions.find((d) => d.dimension === 'dry');
    expect(dryDim?.passed).toBe(false);
    expect(dryDim?.comments).toBe('Code duplicated in 3 places');

    const archDim = report.dimensions.find((d) => d.dimension === 'architecture');
    expect(archDim?.passed).toBe(true);
    expect(archDim?.comments).toBe('');
  });

  it('ALL_REVIEW_DIMENSIONS contains all 8 dimensions', () => {
    expect(ALL_REVIEW_DIMENSIONS).toEqual([
      'architecture',
      'bestPractices',
      'separationOfConcerns',
      'dry',
      'security',
      'scalability',
      'optimizations',
      'testCoverage',
    ]);
  });
});

describe('workflow constants', () => {
  it('MAX_INNER_ITERATIONS is 5', () => {
    expect(MAX_INNER_ITERATIONS).toBe(5);
  });

  it('MAX_OUTER_ITERATIONS is 5', () => {
    expect(MAX_OUTER_ITERATIONS).toBe(5);
  });
});
