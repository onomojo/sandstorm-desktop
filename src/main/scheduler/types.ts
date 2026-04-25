/**
 * Types for the scheduled automation system.
 *
 * Design note (#250, reshaped per CLAUDE.md "Deterministic workflow
 * philosophy"): schedules carry a structured `ScheduleAction`, never a
 * freeform prompt. Scheduled fires MUST NOT route through the outer-Claude
 * chat session — that's the whole point of the action-kind discriminator.
 * Each kind maps to a deterministic primitive (a script, a bounded
 * ephemeral LLM subprocess, or a pure IPC path).
 */

/**
 * A scheduled action. This PR ships the escape-hatch kind (`run-script`);
 * follow-up PRs add kinds for the concrete workflows (refine-to-comments,
 * dispatch-ready-tickets, close-loop-prs).
 */
export type ScheduleAction =
  | {
      kind: 'run-script';
      /**
       * Script name under `<projectDir>/.sandstorm/scripts/scheduled/`.
       * Resolved with `.sh` appended if missing. Path traversal (any `..`
       * segment or absolute path) is rejected.
       */
      scriptName: string;
    };

export interface Schedule {
  id: string;
  label?: string;
  cronExpression: string;
  action: ScheduleAction;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleStore {
  version: 1;
  schedules: Schedule[];
}

export interface ScheduledDispatchRequest {
  type: 'scheduled-dispatch';
  version: 1;
  projectDir: string;
  scheduleId: string;
  firedAt: string;
}

export interface ScheduledDispatchSuccessResponse {
  ok: true;
  dispatchId: string;
}

export type ScheduledDispatchRejectReason =
  | 'app-not-running'
  | 'project-not-open'
  | 'schedule-not-found'
  | 'schedule-disabled'
  | 'rate-limited'
  | 'auth-halt'
  | 'orchestrator-busy'
  | 'internal-error';

export interface ScheduledDispatchRejectResponse {
  ok: false;
  reason: ScheduledDispatchRejectReason;
  message: string;
}

export type ScheduledDispatchResponse =
  | ScheduledDispatchSuccessResponse
  | ScheduledDispatchRejectResponse;
