import React, { useState } from 'react';
import { useAppStore, KanbanColumn, TicketBoardEntry, Stack } from '../store';
import { makePrEligible } from '../utils/duration';
import { suggestStackName } from '../lib/stack-name';
import { DiscardStackDialog } from './DiscardStackDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { AnswerQuestionsModal } from './AnswerQuestionsModal';

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
    openEditTicketDialog,
    refinementSessions,
    retryRefinementForTicket,
    resumeStackWithContinuation,
    startStackForTicket,
    stackCreateErrors,
    stackCreateInFlight,
    mergeTicket,
    mergeInFlight,
    prCreateInFlight,
    prCreateErrors,
    refineInFlight,
    refineStartErrors,
    discardStack,
    discardInFlight,
    discardErrors,
    removeRefinementSession,
    autoResolveConflicts,
    autoResolveInFlight,
    autoResolveErrors,
    mergeConflicts,
    refreshStacks,
  } = useAppStore();

  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const [showEarlyDiscardDialog, setShowEarlyDiscardDialog] = useState(false);
  const [showMoveToBacklogDialog, setShowMoveToBacklogDialog] = useState(false);
  const [showAnswerModal, setShowAnswerModal] = useState(false);

  const stack = getTicketStack(ticket.ticket_id, stacks);
  const stackKey = `${ticket.ticket_id}|${ticket.project_dir}`;
  const stackCreateError = stackCreateErrors[stackKey];
  const stackInFlight = stackCreateInFlight[stackKey] ?? false;
  const mergeInflight = mergeInFlight[stackKey] ?? false;
  const discardInflight = discardInFlight[stackKey] ?? false;
  const discardError = discardErrors[stackKey];
  const autoResolveInflight = autoResolveInFlight[stackKey] ?? false;
  const autoResolveError = autoResolveErrors[stackKey];
  const hasConflict = mergeConflicts[stackKey] ?? false;

  const handleRefine = () => {
    openRefineDialogFromCard(ticket.ticket_id, ticket.project_dir, ticket.column as KanbanColumn);
  };

  const handleEdit = () => {
    openEditTicketDialog(ticket.ticket_id, ticket.project_dir);
  };

  const handleStartStack = () => {
    const name = suggestStackName(ticket.ticket_id);
    if (!name) return;
    void startStackForTicket(ticket.ticket_id, ticket.project_dir);
  };

  const prInFlight = stack ? (prCreateInFlight[stack.id] ?? false) : false;
  const prCreateError = stack ? (prCreateErrors[stack.id] ?? null) : null;

  const handleCreatePR = () => {
    if (stack && !prInFlight) {
      void createPRAutomatic(stack.id, ticket.ticket_id, ticket.project_dir, ticket.column as KanbanColumn);
    }
  };

  const handleMerge = () => {
    void mergeTicket(ticket.ticket_id, ticket.project_dir);
  };

  const handleAutoResolve = () => {
    void autoResolveConflicts(ticket.ticket_id, ticket.project_dir);
  };

  const handleResume = () => {
    if (stack) {
      void resumeStackWithContinuation(stack.id, true);
    }
  };

  const handleAnswer = () => {
    setShowAnswerModal(true);
  };

  const handleAnswerResumed = () => {
    setShowAnswerModal(false);
    void refreshStacks();
  };

  const handleDiscardBackToBacklog = () => {
    setShowDiscardDialog(false);
    void discardStack(ticket.ticket_id, ticket.project_dir, 'backlog');
  };

  const handleDiscardCloseTicket = () => {
    setShowDiscardDialog(false);
    void discardStack(ticket.ticket_id, ticket.project_dir, 'close');
  };

  const handleEarlyDiscardConfirm = async () => {
    setShowEarlyDiscardDialog(false);
    if (ticket.column === 'refining' && refinementSession) {
      await window.sandstorm.tickets.cancelRefinement(refinementSession.id).catch(() => {});
      removeRefinementSession(refinementSession.id);
    }
    void discardStack(ticket.ticket_id, ticket.project_dir, 'close');
  };

  const handleMoveToBacklog = async () => {
    setShowMoveToBacklogDialog(false);
    if (refinementSession) {
      await window.sandstorm.tickets.cancelRefinement(refinementSession.id).catch(() => {});
      removeRefinementSession(refinementSession.id);
    }
    void moveTicketColumn(ticket.ticket_id, ticket.project_dir, 'backlog');
  };

  const isEarlyColumn = ticket.column === 'backlog' || ticket.column === 'refining' || ticket.column === 'spec_ready';
  const isDiscardColumn = ticket.column === 'in_stack' || ticket.column === 'pr_open';

  const discardIcon = (isEarlyColumn || isDiscardColumn) ? (
    <button
      onClick={isEarlyColumn ? () => setShowEarlyDiscardDialog(true) : () => setShowDiscardDialog(true)}
      disabled={discardInflight}
      className="p-1 text-red-400/40 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
      data-testid={`ticket-card-discard-${ticket.ticket_id}`}
      aria-label="Discard"
      title="Discard"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        <path d="M10 11v6"/>
        <path d="M14 11v6"/>
        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
      </svg>
    </button>
  ) : null;

  const discardErrorBlock = discardError ? (
    <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-2 py-1.5 break-words">
      {discardError}
    </div>
  ) : null;

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

  const refineErrorMessage =
    refinementSession?.error ??
    refinementSession?.result?.error ??
    refineStartError ??
    'Refinement failed';

  return (
    <div
      className={`bg-sandstorm-surface border border-sandstorm-border rounded-lg p-3 flex flex-col gap-2 shadow-card ${ticket.column === 'merged' ? 'opacity-40' : ''}`}
      data-testid={`ticket-card-${ticket.ticket_id}`}
    >
      {/* Ticket ID + title + discard icon */}
      <div className="flex items-start gap-2">
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <span className="font-mono text-xs text-sandstorm-muted" data-testid={`ticket-id-${ticket.ticket_id}`}>
            #{ticket.ticket_id}
          </span>
          <span className="text-sm text-sandstorm-text leading-snug line-clamp-2">
            {ticket.title || `Ticket #${ticket.ticket_id}`}
          </span>
        </div>
        {discardIcon}
      </div>

      {/* Column-specific content */}
      {ticket.column === 'backlog' && (
        <div className="flex flex-col gap-2 mt-1">
          <button
            onClick={handleEdit}
            className="w-full text-xs py-1.5 px-3 rounded-md bg-sandstorm-surface-hover text-sandstorm-muted border border-sandstorm-border hover:border-sandstorm-accent/30 hover:text-sandstorm-text transition-colors font-medium"
            data-testid={`ticket-card-edit-${ticket.ticket_id}`}
          >
            Edit
          </button>
          <button
            onClick={handleRefine}
            className="w-full text-xs py-1.5 px-3 rounded-md bg-sandstorm-accent/10 text-sandstorm-accent border border-sandstorm-accent/30 hover:bg-sandstorm-accent/20 transition-colors font-medium"
            data-testid={`ticket-card-refine-${ticket.ticket_id}`}
          >
            Refine
          </button>
          {discardErrorBlock}
        </div>
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
              className="text-xs text-red-400 truncate block max-w-full"
              data-testid={`ticket-card-error-badge-${ticket.ticket_id}`}
              title={refineErrorMessage}
            >
              {refineErrorMessage}
            </span>
          )}
          {/* No session, not in-flight, no error: offer to start refinement */}
          {!refinementSession && !isRefineInFlight && !showErrorState && (
            <button
              onClick={() => openRefineDialogFromCard(ticket.ticket_id, ticket.project_dir, ticket.column as KanbanColumn)}
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
          <button
            onClick={() => setShowMoveToBacklogDialog(true)}
            className="w-full text-xs py-1.5 px-3 rounded-md bg-sandstorm-surface-hover text-sandstorm-muted border border-sandstorm-border hover:border-sandstorm-accent/30 hover:text-sandstorm-text transition-colors font-medium"
            data-testid={`ticket-card-move-to-backlog-${ticket.ticket_id}`}
          >
            Move to backlog
          </button>
          {discardErrorBlock}
        </div>
      )}

      {ticket.column === 'spec_ready' && (
        <div className="flex flex-col gap-2 mt-1">
          <button
            onClick={handleStartStack}
            disabled={stackInFlight}
            className="w-full text-xs py-1.5 px-3 rounded-md bg-sandstorm-state-ready/10 text-sandstorm-state-ready border border-sandstorm-state-ready/30 hover:bg-sandstorm-state-ready/20 transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid={`ticket-card-start-stack-${ticket.ticket_id}`}
          >
            Start stack
          </button>
          {discardErrorBlock}
        </div>
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
          {prCreateError && (
            <div
              className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-2 py-1.5 break-words"
              data-testid={`ticket-card-pr-create-error-${ticket.ticket_id}`}
            >
              {prCreateError}
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
          {stack && stack.status === 'needs_human' && (
            <button
              onClick={handleAnswer}
              className="w-full text-xs py-1.5 px-3 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20 transition-colors font-medium"
              data-testid={`ticket-card-in-stack-answer-${ticket.ticket_id}`}
            >
              Answer
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
          {discardErrorBlock}
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
          {stack?.pr_number != null && !hasConflict && (
            <button
              onClick={handleMerge}
              disabled={mergeInflight}
              className="w-full text-xs py-1.5 px-3 rounded-md bg-sandstorm-state-propen/10 text-sandstorm-state-propen border border-sandstorm-state-propen/30 hover:bg-sandstorm-state-propen/20 transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid={`ticket-card-merge-${ticket.ticket_id}`}
            >
              {mergeInflight ? 'Merging…' : 'Merge'}
            </button>
          )}
          {autoResolveError && (
            <div
              className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-2 py-1.5 break-words"
              data-testid={`ticket-card-auto-resolve-error-${ticket.ticket_id}`}
            >
              {autoResolveError}
            </div>
          )}
          {hasConflict && (
            <button
              onClick={handleAutoResolve}
              disabled={autoResolveInflight}
              className="w-full text-xs py-1.5 px-3 rounded-md bg-sandstorm-surface-hover text-sandstorm-muted border border-sandstorm-border hover:border-sandstorm-accent/30 hover:text-sandstorm-text transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
              data-testid={`ticket-card-auto-resolve-${ticket.ticket_id}`}
            >
              {autoResolveInflight ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="animate-spin flex-shrink-0">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="48" strokeDashoffset="32"/>
                  </svg>
                  Resolving…
                </>
              ) : (
                'Auto-resolve conflicts'
              )}
            </button>
          )}
          {discardErrorBlock}
        </div>
      )}

      {ticket.column === 'merged' && (
        <span className="text-xs text-sandstorm-state-merged font-medium">Merged</span>
      )}

      {showEarlyDiscardDialog && (
        <ConfirmDialog
          title="Discard ticket?"
          body="This closes the issue on the provider and removes the card from your board. Reopening the issue on the provider will re-add it to the backlog on the next sync."
          confirmLabel="Discard ticket"
          onConfirm={() => void handleEarlyDiscardConfirm()}
          onCancel={() => setShowEarlyDiscardDialog(false)}
        />
      )}

      {showMoveToBacklogDialog && (
        <ConfirmDialog
          title="Move ticket back to backlog?"
          body="This discards the current refinement session and moves the ticket back to the backlog. Answers you already submitted and any title/body edits are kept on the ticket — only the in-progress refinement session is lost."
          confirmLabel="Move to backlog"
          onConfirm={() => void handleMoveToBacklog()}
          onCancel={() => setShowMoveToBacklogDialog(false)}
          data-testid={`move-to-backlog-dialog-${ticket.ticket_id}`}
        />
      )}

      {showDiscardDialog && (
        <DiscardStackDialog
          onBackToBacklog={handleDiscardBackToBacklog}
          onCloseTicket={handleDiscardCloseTicket}
          onCancel={() => setShowDiscardDialog(false)}
          data-testid={`discard-stack-dialog-${ticket.ticket_id}`}
        />
      )}

      {showAnswerModal && stack && (
        <AnswerQuestionsModal
          stackId={stack.id}
          onClose={() => setShowAnswerModal(false)}
          onResumed={handleAnswerResumed}
        />
      )}
    </div>
  );
}
