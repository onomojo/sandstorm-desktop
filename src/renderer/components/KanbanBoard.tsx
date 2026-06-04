import React, { useEffect, useState } from 'react';
import { useAppStore, selectProjectTickets, TicketBoardEntry } from '../store';
import { KanbanColumn } from '../types/kanban';
import { TicketCard } from './TicketCard';
import { RefinementIndicator } from './RefinementIndicator';

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

type BoardTab = 'active' | 'history';
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
  } = useAppStore();

  const [activeTab, setActiveTab] = useState<BoardTab>('active');
  const [mergedMode, setMergedMode] = useState<MergedMode>('recent');
  const [backlogQuery, setBacklogQuery] = useState('');
  const [debouncedBacklogQuery, setDebouncedBacklogQuery] = useState('');

  const project = activeProject();

  useEffect(() => {
    if (project?.directory) {
      refreshBoardTickets(project.directory);
    }
    setBacklogQuery('');
    setDebouncedBacklogQuery('');
  }, [project?.directory, refreshBoardTickets]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedBacklogQuery(backlogQuery);
    }, 200);
    return () => clearTimeout(timer);
  }, [backlogQuery]);

  const projectTickets = selectProjectTickets(boardTickets, project?.directory);

  const ticketsByColumn = (column: KanbanColumn): TicketBoardEntry[] =>
    projectTickets.filter((t) => t.column === column);

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="kanban-board">
      {/* Board header — always rendered */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-sandstorm-border shrink-0">
        {/* Left: project name + tabs */}
        <div className="flex items-center gap-3">
          {project && (
            <h1 className="text-base font-semibold text-sandstorm-text">{project.name}</h1>
          )}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setActiveTab('active')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === 'active'
                  ? 'bg-sandstorm-surface text-sandstorm-text'
                  : 'text-sandstorm-muted hover:text-sandstorm-text'
              }`}
              data-testid="tab-active"
            >
              Active
            </button>
            <button
              onClick={() => setActiveTab('history')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === 'history'
                  ? 'bg-sandstorm-surface text-sandstorm-text'
                  : 'text-sandstorm-muted hover:text-sandstorm-text'
              }`}
              data-testid="tab-history"
            >
              History
            </button>
          </div>
          {project && (
            <>
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
            </>
          )}
        </div>

        {/* Right side controls */}
        <div className="flex items-center gap-2">
          <RefinementIndicator />
        </div>
      </div>

      {/* Board content */}
      <div className="flex-1 overflow-hidden flex flex-col" data-testid="kanban-board-content">
        {!project ? (
          <div className="flex-1 flex items-center justify-center text-sandstorm-muted text-sm" data-testid="kanban-board-no-project">
            No stacks yet
          </div>
        ) : activeTab === 'history' ? (
          <div className="flex-1 flex items-center justify-center text-sandstorm-muted text-sm">
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
              const isBacklog = col.id === 'backlog';
              const sortedCards = isMerged
                ? ticketsByColumn(col.id).slice().sort((a, b) => {
                    const dateCmp = b.updated_at.localeCompare(a.updated_at);
                    return dateCmp !== 0 ? dateCmp : a.ticket_id.localeCompare(b.ticket_id);
                  })
                : ticketsByColumn(col.id);
              const filteredCards = isBacklog
                ? sortedCards.filter((t) => matchesTicketQuery(t, debouncedBacklogQuery))
                : sortedCards;
              const totalCount = filteredCards.length;
              const cards = isMerged && mergedMode === 'recent'
                ? filteredCards.slice(0, RECENT_MERGED_LIMIT)
                : filteredCards;
              const activeQuery = isBacklog
                ? debouncedBacklogQuery.trim().replace(/^#/, '').trim()
                : '';
              return (
                <div
                  key={col.id}
                  className="flex flex-col gap-2"
                  style={{ flex: '1 1 0', minWidth: '240px' }}
                  data-testid={`kanban-column-${col.id}`}
                >
                  {/* Column header */}
                  <div className="flex items-center justify-between px-1">
                    <span className={`text-xs font-semibold uppercase tracking-wide ${col.colorClass}`}>
                      {col.label}
                    </span>
                    <div className="flex items-center gap-1.5">
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
                        <span className="text-xs text-sandstorm-muted font-mono" data-testid={isBacklog ? 'backlog-count-badge' : undefined}>{totalCount}</span>
                      )}
                    </div>
                  </div>

                  {/* Backlog search input */}
                  {col.id === 'backlog' && (
                    <div className="relative px-1">
                      <input
                        type="text"
                        value={backlogQuery}
                        onChange={(e) => setBacklogQuery(e.target.value)}
                        placeholder="Filter backlog…"
                        className="w-full px-2 py-1 pr-6 text-xs bg-sandstorm-surface border border-sandstorm-border rounded text-sandstorm-text placeholder-sandstorm-muted/50 focus:outline-none focus:border-sandstorm-accent"
                        data-testid="backlog-filter-input"
                      />
                      {backlogQuery && (
                        <button
                          onClick={() => setBacklogQuery('')}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-sandstorm-muted hover:text-sandstorm-text text-xs leading-none"
                          data-testid="backlog-filter-clear"
                          aria-label="Clear filter"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  )}

                  {/* Cards */}
                  <div className="flex flex-col gap-2 flex-1">
                    {cards.length === 0 ? (
                      activeQuery ? (
                        <div className="flex items-center justify-center h-16 text-xs text-sandstorm-muted/50 border border-dashed border-sandstorm-border rounded-lg" data-testid="backlog-no-match">
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
