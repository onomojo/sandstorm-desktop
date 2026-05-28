import type { ScheduleAction } from './types';

export interface BuiltInAction {
  kind: ScheduleAction['kind'];
  label: string;
  description: string;
  defaultAction: ScheduleAction;
}

export const BUILT_IN_ACTIONS: BuiltInAction[] = [
  {
    kind: 'refine-to-comments',
    label: 'Refine `needs-spec` tickets',
    description:
      'Runs the spec quality gate against open tickets labelled `needs-spec` (or a custom label). ' +
      'Posts questions as comments; when answers are provided, refines the ticket and — once the gate passes — ' +
      'swaps `needs-spec` → `spec-ready`.',
    defaultAction: {
      kind: 'refine-to-comments',
      ticketLabel: 'needs-spec',
    },
  },
];
