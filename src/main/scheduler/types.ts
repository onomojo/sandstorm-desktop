/**
 * Types for the scheduled automation system.
 */

export interface Schedule {
  id: string;
  label?: string;
  cronExpression: string;
  prompt: string;
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
  prompt: string;
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
