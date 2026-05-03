import type { ScheduleAction } from './types';

export interface BuiltInAction {
  kind: ScheduleAction['kind'];
  label: string;
  description: string;
  defaultAction: ScheduleAction;
}

// Populated as #325 / #326 / #327 land.
export const BUILT_IN_ACTIONS: BuiltInAction[] = [];
