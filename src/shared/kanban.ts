export const KANBAN_COLUMNS = ['backlog', 'refining', 'spec_ready', 'in_stack', 'pr_open', 'merged'] as const;
export type KanbanColumn = typeof KANBAN_COLUMNS[number];
