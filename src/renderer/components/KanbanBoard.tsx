import React, { useEffect, useState } from 'react';
import { useAppStore, selectProjectTickets, TicketBoardEntry } from '../store';
import { KanbanColumn } from '../types/kanban';
import { TicketCard } from './TicketCard';

export function matchesTicketQuery(ticket: TicketBoardEntry, query: string): boolean {
  const normalized = query.trim().replace(/^#/, '').toLowerCase();
  if (!normalized) return true;
  if (ticket.ticket_id.toLowerCase().includes(normalized)) return true;
  if (ticket.title && ticket.title.toLowerCase().includes(normalized)) return true;
  return false;
}

const COLUMNS: { id: KanbanColumn; label: string; colorClass: string }[] = [
  { id: 'backlog', label: 'Backlog', colorClass: 'text-sandstorm-muted' },
  { id: 'refining', label: 'Refining', colorClass: 'text-sandstorm-state-refining' },
  { id: 'spec_ready', label: 'Spec ready', colorClass: 'text-sandstorm-state-ready' },
  { id: 'in_stack', label: 'In stack', colorClass: 'text-sandstorm-state-instack' },
  { id: 'pr_open', label: 'PR open', colorClass: 'text-sandstorm-state-propen' },
  { id: 'merged', label: 'Merged', colorClass: 'text-sandstorm-state-merged' },
];

const RECENT_MERGED_LIMIT = 10;

type MergedMode = 'recent' | 'all';

export function KanbanBoard() {
  const {
    boardTickets,
    boardTicketsLoading,
    boardTicketsError,
    moveTicketColumnError,
    clearMoveTicketColumnError,
    stacks,
    activeProject,
    refreshBoardTickets,
    searchQuery,
  } = useAppStore();

  const [mergedMode, setMergedMode] = useState<MergedMode>('recent');

  const project = activeProject();

  useEffect(() => {
    if (project?.directory) {
      refreshBoardTickets(project.directory);
    }
  }, [project?.directory, refreshBoardTickets]);

  const projectTickets = selectProjectTickets(boardTickets, project?.directory);

  const ticketsByColumn = (column: KanbanColumn): TicketBoardEntry[] =>
    projectTickets.filter((t) => t.column === column);

  const activeQuery = searchQuery.trim().replace(/^#/, '').trim();

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="kanban-board">
      {/* Board content */}
      <div className="flex-1 overflow-hidden flex flex-col" data-testid="kanban-board-content">
        {/* Inline status banner */}
        {(boardTicketsLoading || boardTicketsError || moveTicketColumnError) && (
          <div className="flex items-center gap-3 px-6 py-2 border-b border-sandstorm-border shrink-0">
            {boardTicketsLoading && (
              <span className="text-xs text-sandstorm-muted animate-pulse">Refreshing…</span>
            )}
            {boardTicketsError && !boardTicketsLoading && (
              <span className="text-xs text-red-400" data-testid="board-tickets-error">{boardTicketsError}</span>
            )}
            {moveTicketColumnError && (
              <button
                onClick={clearMoveTicketColumnError}
                className="text-xs text-red-400 hover:text-red-300 underline decoration-dotted"
                data-testid="move-ticket-column-error"
                title={moveTicketColumnError}
              >
                Failed to update ticket column — click to dismiss
              </button>
            )}
          </div>
        )}
        {!project ? (
          <div className="flex-1 flex items-center justify-center text-sandstorm-muted text-sm" data-testid="kanban-board-no-project">
            No stacks yet
          </div>
        ) : (
          /* Kanban columns */
          <div
            className="flex-1 flex gap-3 p-4 overflow-x-auto"
            data-testid="kanban-columns"
          >
            {COLUMNS.map((col) => {
              const isMerged = col.id === 'merged';
              const sortedCards = isMerged
                ? ticketsByColumn(col.id).slice().sort((a, b) => {
                    const dateCmp = b.updated_at.localeCompare(a.updated_at);
                    return dateCmp !== 0 ? dateCmp : a.ticket_id.localeCompare(b.ticket_id);
                  })
                : ticketsByColumn(col.id);
              const cappedCards = isMerged && mergedMode === 'recent'
                ? sortedCards.slice(0, RECENT_MERGED_LIMIT)
                : sortedCards;
              const cards = cappedCards.filter((t) => matchesTicketQuery(t, searchQuery));
              const totalCount = cappedCards.length;
              return (
                <div
                  key={col.id}
                  className="flex flex-col"
                  style={{ flex: '1 1 0', minWidth: '240px' }}
                  data-testid={`kanban-column-${col.id}`}
                >
                  {/* Column header — pinned */}
                  <div
                    className="flex items-center justify-between px-1 pb-2 shrink-0"
                    data-testid={`column-header-${col.id}`}
                  >
                    <span className={`text-xs font-semibold uppercase tracking-wide ${col.colorClass}`}>
                      {col.label}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {col.id === 'backlog' && (
                        <button
                          onClick={() => { if (project?.directory) refreshBoardTickets(project.directory); }}
                          disabled={boardTicketsLoading}
                          aria-label="Refresh backlog"
                          data-testid="backlog-refresh-button"
                          className="text-sandstorm-muted hover:text-sandstorm-text disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                            <path d="M21 3v5h-5" />
                            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                            <path d="M8 16H3v5" />
                          </svg>
                        </button>
                      )}
                      {isMerged && (
                        <div
                          className="flex items-center rounded overflow-hidden border border-sandstorm-border"
                          data-testid="merged-mode-toggle"
                        >
                          <button
                            onClick={() => setMergedMode('recent')}
                            className={`text-xs px-1.5 py-0.5 transition-colors ${
                              mergedMode === 'recent'
                                ? 'bg-sandstorm-surface text-sandstorm-text'
                                : 'text-sandstorm-muted hover:text-sandstorm-text'
                            }`}
                            data-testid="merged-mode-recent"
                          >
                            Recent
                          </button>
                          <button
                            onClick={() => setMergedMode('all')}
                            className={`text-xs px-1.5 py-0.5 border-l border-sandstorm-border transition-colors ${
                              mergedMode === 'all'
                                ? 'bg-sandstorm-surface text-sandstorm-text'
                                : 'text-sandstorm-muted hover:text-sandstorm-text'
                            }`}
                            data-testid="merged-mode-all"
                          >
                            All
                          </button>
                        </div>
                      )}
                      {totalCount > 0 && (
                        <span className="text-xs text-sandstorm-muted font-mono" data-testid={col.id === 'backlog' ? 'backlog-count-badge' : undefined}>{totalCount}</span>
                      )}
                    </div>
                  </div>

                  {/* Cards — scrollable */}
                  <div
                    className="flex flex-col gap-2 flex-1 overflow-y-auto min-h-0"
                    data-testid={`column-cards-${col.id}`}
                  >
                    {cards.length === 0 ? (
                      activeQuery ? (
                        <div className="flex items-center justify-center h-16 text-xs text-sandstorm-muted/50 border border-dashed border-sandstorm-border rounded-lg" data-testid={`no-match-${col.id}`}>
                          No tickets match your search
                        </div>
                      ) : (
                        <div className="flex items-center justify-center h-16 text-xs text-sandstorm-muted/50 border border-dashed border-sandstorm-border rounded-lg">
                          No cards
                        </div>
                      )
                    ) : (
                      cards.map((ticket) => (
                        <TicketCard
                          key={`${ticket.ticket_id}-${ticket.project_dir}`}
                          ticket={ticket}
                          stacks={stacks}
                        />
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
