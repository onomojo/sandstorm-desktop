import { ReviewReport } from './review-report';

export type WorkflowPhase = 'idle' | 'execution' | 'review' | 'verify' | 'done' | 'failed';

export interface WorkflowState {
  phase: WorkflowPhase;
  innerCount: number;
  outerCount: number;
  reviewReports: ReviewReport[];
  verifyErrors: string[];
}

export const MAX_INNER_ITERATIONS = 5;
export const MAX_OUTER_ITERATIONS = 5;
export const HUMAN_INTERVENTION_MESSAGE = 'HUMAN INTERVENTION REQUIRED';

export class DualLoopWorkflow {
  private state: WorkflowState;

  constructor() {
    this.state = {
      phase: 'idle',
      innerCount: 0,
      outerCount: 0,
      reviewReports: [],
      verifyErrors: [],
    };
  }

  getState(): Readonly<WorkflowState> {
    return { ...this.state };
  }

  startExecution(): void {
    if (this.state.phase === 'idle') {
      this.state.outerCount = 1;
      this.state.innerCount = 1;
      this.state.phase = 'execution';
      return;
    }

    if (this.state.phase === 'execution') {
      return;
    }

    throw new Error(`Cannot start execution from phase: ${this.state.phase}`);
  }

  submitForReview(): void {
    if (this.state.phase !== 'execution') {
      throw new Error(`Cannot submit for review from phase: ${this.state.phase}`);
    }
    this.state.phase = 'review';
  }

  handleReviewResult(report: ReviewReport): void {
    if (this.state.phase !== 'review') {
      throw new Error(`Cannot handle review result from phase: ${this.state.phase}`);
    }

    this.state.reviewReports.push(report);

    if (report.passed) {
      this.state.phase = 'verify';
      return;
    }

    // Review failed — iterate inner loop
    if (this.state.innerCount >= MAX_INNER_ITERATIONS) {
      this.state.phase = 'failed';
      return;
    }

    this.state.innerCount += 1;
    this.state.phase = 'execution';
  }

  runVerify(passed: boolean, error?: string): void {
    if (this.state.phase !== 'verify') {
      throw new Error(`Cannot run verify from phase: ${this.state.phase}`);
    }

    if (passed) {
      this.state.phase = 'done';
      return;
    }

    if (error) {
      this.state.verifyErrors.push(error);
    }

    // Verify failed — iterate outer loop
    if (this.state.outerCount >= MAX_OUTER_ITERATIONS) {
      this.state.phase = 'failed';
      return;
    }

    this.state.outerCount += 1;
    this.state.innerCount = 1;
    this.state.phase = 'execution';
  }
}
