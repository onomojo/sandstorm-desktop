import React from 'react';
import { useAppStore, KanbanColumn, TicketBoardEntry, Stack } from '../store';

interface TicketCardProps {
  ticket: TicketBoardEntry;
  stacks: Stack[];
}

function getTicketStack(ticketId: string, stacks: Stack[]): Stack | undefined {
  return stacks.find((s) => s.ticket === ticketId);
}

export function TicketCard({ ticket, stacks }: TicketCardProps) {
  const {
    moveTicketColumn,
    openRefineDialogFromCard,
    openNewStackDialogForTicket,
    openCreatePRDialogForTicket,
    openRefinementSession,
    openRefineTicketDialogWith,
    refinementSessions,
  } = useAppStore();

  const stack = getTicketStack(ticket.ticket_id, stacks);

  const handleRefine = () => {
    openRefineDialogFromCard(ticket.ticket_id, ticket.project_dir, ticket.column as KanbanColumn);
  };

  const handleStartStack = () => {
    openNewStackDialogForTicket(ticket.ticket_id, ticket.project_dir, ticket.column as KanbanColumn);
  };

  const handleCreatePR = () => {
    if (stack) {
      openCreatePRDialogForTicket(stack.id, ticket.ticket_id, ticket.project_dir, ticket.column as KanbanColumn);
    }
  };

  const handleMerge = () => {
    moveTicketColumn(ticket.ticket_id, ticket.project_dir, 'merged');
  };

  const refinementSession = refinementSessions.find(
    (s) => s.ticketId === ticket.ticket_id && s.projectDir === ticket.project_dir
  );

  const questionsAwaiting = refinementSession?.result?.questions?.length ?? 0;

  return (
    <div
      className={`bg-sandstorm-surface border border-sandstorm-border rounded-lg p-3 flex flex-col gap-2 shadow-card ${ticket.column === 'merged' ? 'opacity-40' : ''}`}
      data-testid={`ticket-card-${ticket.ticket_id}`}
    >
      {/* Ticket ID + title */}
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-xs text-sandstorm-muted" data-testid={`ticket-id-${ticket.ticket_id}`}>
          #{ticket.ticket_id}
        </span>
        <span className="text-sm text-sandstorm-text leading-snug line-clamp-2">
          {ticket.title || `Ticket #${ticket.ticket_id}`}
        </span>
      </div>

      {/* Column-specific content */}
      {ticket.column === 'backlog' && (
        <button
          onClick={handleRefine}
          className="mt-1 w-full text-xs py-1.5 px-3 rounded-md bg-sandstorm-accent/10 text-sandstorm-accent border border-sandstorm-accent/30 hover:bg-sandstorm-accent/20 transition-colors font-medium"
          data-testid={`ticket-card-refine-${ticket.ticket_id}`}
        >
          Refine
        </button>
      )}

      {ticket.column === 'refining' && (
        <div className="flex flex-col gap-2">
          {refinementSession?.status === 'running' && (
            <div className="h-1 bg-sandstorm-border rounded-full overflow-hidden">
              <div className="h-full bg-sandstorm-state-refining rounded-full animate-pulse w-1/2" />
            </div>
          )}
          {questionsAwaiting > 0 && (
            <span className="text-xs text-sandstorm-state-refining">
              {questionsAwaiting} question{questionsAwaiting !== 1 ? 's' : ''} awaiting
            </span>
          )}
          <button
            onClick={() => {
              if (refinementSession) {
                openRefinementSession(refinementSession.id);
              } else {
                openRefineTicketDialogWith(ticket.ticket_id);
              }
            }}
            className="w-full text-xs py-1.5 px-3 rounded-md bg-sandstorm-state-refining/10 text-sandstorm-state-refining border border-sandstorm-state-refining/30 hover:bg-sandstorm-state-refining/20 transition-colors font-medium"
            data-testid={`ticket-card-answer-${ticket.ticket_id}`}
          >
            Answer
          </button>
        </div>
      )}

      {ticket.column === 'spec_ready' && (
        <button
          onClick={handleStartStack}
          className="mt-1 w-full text-xs py-1.5 px-3 rounded-md bg-sandstorm-state-ready/10 text-sandstorm-state-ready border border-sandstorm-state-ready/30 hover:bg-sandstorm-state-ready/20 transition-colors font-medium"
          data-testid={`ticket-card-start-stack-${ticket.ticket_id}`}
        >
          Start stack
        </button>
      )}

      {ticket.column === 'in_stack' && (
        <div className="flex flex-col gap-2">
          {stack && (
            <div className="flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  stack.status === 'running' || stack.status === 'building'
                    ? 'bg-sandstorm-state-instack animate-pulse'
                    : 'bg-sandstorm-muted'
                }`}
              />
              <span className="text-xs text-sandstorm-muted">{stack.status}</span>
            </div>
          )}
          <button
            onClick={handleCreatePR}
            disabled={!stack}
            className="w-full text-xs py-1.5 px-3 rounded-md bg-sandstorm-state-instack/10 text-sandstorm-state-instack border border-sandstorm-state-instack/30 hover:bg-sandstorm-state-instack/20 transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid={`ticket-card-create-pr-${ticket.ticket_id}`}
          >
            Create PR
          </button>
        </div>
      )}

      {ticket.column === 'pr_open' && (
        <div className="flex flex-col gap-2">
          {stack?.pr_number && (
            <a
              href={stack.pr_url && /^https?:\/\//i.test(stack.pr_url) ? stack.pr_url : '#'}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-sandstorm-state-propen hover:underline font-mono"
              data-testid={`ticket-card-pr-link-${ticket.ticket_id}`}
            >
              PR #{stack.pr_number}
            </a>
          )}
          <button
            onClick={handleMerge}
            className="w-full text-xs py-1.5 px-3 rounded-md bg-sandstorm-state-propen/10 text-sandstorm-state-propen border border-sandstorm-state-propen/30 hover:bg-sandstorm-state-propen/20 transition-colors font-medium"
            data-testid={`ticket-card-merge-${ticket.ticket_id}`}
          >
            Merge
          </button>
        </div>
      )}

      {ticket.column === 'merged' && (
        <span className="text-xs text-sandstorm-state-merged font-medium">Merged</span>
      )}
    </div>
  );
}
