import React from 'react';
import { useAppStore, KanbanColumn, TicketBoardEntry, Stack } from '../store';
import { makePrEligible } from '../utils/duration';
import { suggestStackName } from '../lib/stack-name';

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
    createPRAutomatic,
    openRefinementSession,
    openRefineTicketDialogWith,
    refinementSessions,
    retryRefinementForTicket,
    resumeStackWithContinuation,
    startStackForTicket,
    stackCreateErrors,
    stackCreateInFlight,
    mergeTicket,
    mergeInFlight,
    prCreateInFlight,
    refineInFlight,
    refineStartErrors,
  } = useAppStore();

  const stack = getTicketStack(ticket.ticket_id, stacks);
  const stackKey = `${ticket.ticket_id}|${ticket.project_dir}`;
  const stackCreateError = stackCreateErrors[stackKey];
  const stackInFlight = stackCreateInFlight[stackKey] ?? false;
  const mergeInflight = mergeInFlight[stackKey] ?? false;

  const handleRefine = () => {
    openRefineDialogFromCard(ticket.ticket_id, ticket.project_dir, ticket.column as KanbanColumn);
  };

  const handleStartStack = () => {
    const name = suggestStackName(ticket.ticket_id);
    if (!name) return;
    void startStackForTicket(ticket.ticket_id, ticket.project_dir);
  };

  const prInFlight = stack ? (prCreateInFlight[stack.id] ?? false) : false;

  const handleCreatePR = () => {
    if (stack && !prInFlight) {
      void createPRAutomatic(stack.id, ticket.ticket_id, ticket.project_dir, ticket.column as KanbanColumn);
    }
  };

  const handleMerge = () => {
    void mergeTicket(ticket.ticket_id, ticket.project_dir);
  };

  const handleResume = () => {
    if (stack) {
      void resumeStackWithContinuation(stack.id, true);
    }
  };

  const refinementSession = refinementSessions.find(
    (s) => s.ticketId === ticket.ticket_id && s.projectDir === ticket.project_dir
  );

  const questionsAwaiting = refinementSession?.result?.questions?.length ?? 0;

  const isRefineInFlight = refineInFlight[stackKey] ?? false;
  const refineStartError = refineStartErrors[stackKey];

  // Error state takes priority: errored, interrupted, ready+result.error, or gate start failure
  const showErrorState = (refinementSession !== undefined && (
    refinementSession.status === 'errored' ||
    refinementSession.status === 'interrupted' ||
    (refinementSession.status === 'ready' && !!refinementSession.result?.error)
  )) || !!refineStartError;

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
          {/* Progress bar: running session or background gate start in-flight */}
          {(refinementSession?.status === 'running' || isRefineInFlight) && (
            <div className="h-1 bg-sandstorm-border rounded-full overflow-hidden">
              <div className="h-full bg-sandstorm-state-refining rounded-full animate-pulse w-1/2" />
            </div>
          )}
          {refinementSession?.status === 'ready' && !showErrorState && questionsAwaiting > 0 && (
            <span className="text-xs text-sandstorm-state-refining">
              {questionsAwaiting} question{questionsAwaiting !== 1 ? 's' : ''} awaiting
            </span>
          )}
          {/* Error badge for clear visual indication of failure */}
          {showErrorState && (
            <span
              className="text-xs text-red-400"
              data-testid={`ticket-card-error-badge-${ticket.ticket_id}`}
            >
              Refinement failed
            </span>
          )}
          {/* No session, not in-flight, no error: offer to start refinement */}
          {!refinementSession && !isRefineInFlight && !showErrorState && (
            <button
              onClick={() => openRefineTicketDialogWith(ticket.ticket_id)}
              className="w-full text-xs py-1.5 px-3 rounded-md bg-sandstorm-accent/10 text-sandstorm-accent border border-sandstorm-accent/30 hover:bg-sandstorm-accent/20 transition-colors font-medium"
              data-testid={`ticket-card-start-refine-${ticket.ticket_id}`}
            >
              Start refinement
            </button>
          )}
          {/* Error/interrupted: offer to retry */}
          {showErrorState && (
            <button
              onClick={() => void retryRefinementForTicket(ticket.ticket_id, ticket.project_dir)}
              className="w-full text-xs py-1.5 px-3 rounded-md bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 transition-colors font-medium"
              data-testid={`ticket-card-retry-${ticket.ticket_id}`}
            >
              Retry
            </button>
          )}
          {/* Inert state: ready + not-passed + no questions + no error — offer to retry */}
          {!showErrorState && refinementSession?.status === 'ready' && !refinementSession?.result?.passed && questionsAwaiting === 0 && !refinementSession?.result?.error && (
            <button
              onClick={() => void retryRefinementForTicket(ticket.ticket_id, ticket.project_dir)}
              className="w-full text-xs py-1.5 px-3 rounded-md bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 transition-colors font-medium"
              data-testid={`ticket-card-retry-${ticket.ticket_id}`}
            >
              Retry
            </button>
          )}
          {/* Ready with questions and no error: answer questions */}
          {!showErrorState && refinementSession?.status === 'ready' && questionsAwaiting > 0 && (
            <button
              onClick={() => openRefinementSession(refinementSession.id)}
              className="w-full text-xs py-1.5 px-3 rounded-md bg-sandstorm-state-refining/10 text-sandstorm-state-refining border border-sandstorm-state-refining/30 hover:bg-sandstorm-state-refining/20 transition-colors font-medium"
              data-testid={`ticket-card-answer-${ticket.ticket_id}`}
            >
              Answer
            </button>
          )}
        </div>
      )}

      {ticket.column === 'spec_ready' && (
        <button
          onClick={handleStartStack}
          disabled={stackInFlight}
          className="mt-1 w-full text-xs py-1.5 px-3 rounded-md bg-sandstorm-state-ready/10 text-sandstorm-state-ready border border-sandstorm-state-ready/30 hover:bg-sandstorm-state-ready/20 transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid={`ticket-card-start-stack-${ticket.ticket_id}`}
        >
          Start stack
        </button>
      )}

      {ticket.column === 'in_stack' && (
        <div className="flex flex-col gap-2">
          {stackCreateError && (
            <div
              className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-2 py-1.5 break-words"
              data-testid={`ticket-card-create-error-${ticket.ticket_id}`}
            >
              {stackCreateError}
            </div>
          )}
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
          {stack && stack.status === 'session_paused' && (
            <button
              onClick={handleResume}
              className="w-full text-xs py-1.5 px-3 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20 transition-colors font-medium"
              data-testid={`ticket-card-resume-${ticket.ticket_id}`}
            >
              Resume
            </button>
          )}
          {stack && (makePrEligible(stack) || prInFlight) && (
            <button
              onClick={handleCreatePR}
              disabled={prInFlight}
              className="w-full text-xs py-1.5 px-3 rounded-md bg-sandstorm-state-instack/10 text-sandstorm-state-instack border border-sandstorm-state-instack/30 hover:bg-sandstorm-state-instack/20 transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
              data-testid={`ticket-card-create-pr-${ticket.ticket_id}`}
            >
              {prInFlight ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="animate-spin flex-shrink-0">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="48" strokeDashoffset="32"/>
                  </svg>
                  Creating PR…
                </>
              ) : (
                'Create PR'
              )}
            </button>
          )}
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
            disabled={mergeInflight}
            className="w-full text-xs py-1.5 px-3 rounded-md bg-sandstorm-state-propen/10 text-sandstorm-state-propen border border-sandstorm-state-propen/30 hover:bg-sandstorm-state-propen/20 transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid={`ticket-card-merge-${ticket.ticket_id}`}
          >
            {mergeInflight ? 'Merging…' : 'Merge'}
          </button>
        </div>
      )}

      {ticket.column === 'merged' && (
        <span className="text-xs text-sandstorm-state-merged font-medium">Merged</span>
      )}
    </div>
  );
}
