import React, { useEffect, useState } from 'react';
import { useAppStore, selectProjectTickets, TicketBoardEntry } from '../store';
import { KanbanColumn } from '../types/kanban';
import { TicketCard } from './TicketCard';
import { RefinementIndicator } from './RefinementIndicator';

const COLUMNS: { id: KanbanColumn; label: string; colorClass: string }[] = [
  { id: 'backlog', label: 'Backlog', colorClass: 'text-sandstorm-muted' },
  { id: 'refining', label: 'Refining', colorClass: 'text-sandstorm-state-refining' },
  { id: 'spec_ready', label: 'Spec ready', colorClass: 'text-sandstorm-state-ready' },
  { id: 'in_stack', label: 'In stack', colorClass: 'text-sandstorm-state-instack' },
  { id: 'pr_open', label: 'PR open', colorClass: 'text-sandstorm-state-propen' },
  { id: 'merged', label: 'Merged', colorClass: 'text-sandstorm-state-merged' },
];

type BoardTab = 'active' | 'history';

export function KanbanBoard() {
  const {
    boardTickets,
    boardTicketsLoading,
    boardTicketsError,
    stacks,
    activeProject,
    refreshBoardTickets,
    setShowNewStackDialog,
  } = useAppStore();

  const [activeTab, setActiveTab] = useState<BoardTab>('active');

  const project = activeProject();

  useEffect(() => {
    if (project?.directory) {
      refreshBoardTickets(project.directory);
    }
  }, [project?.directory, refreshBoardTickets]);

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
                <span className="text-xs text-red-400" data-testid="board-tickets-error">Failed to load tickets</span>
              )}
            </>
          )}
        </div>

        {/* Right side controls */}
        <div className="flex items-center gap-2">
          <RefinementIndicator />
          <button
            onClick={() => setShowNewStackDialog(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sandstorm-accent text-sandstorm-rail text-xs font-semibold hover:bg-sandstorm-accent-hover transition-colors"
            data-testid="new-stack-btn"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
            </svg>
            New Stack
          </button>
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
              const cards = ticketsByColumn(col.id);
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
                    {cards.length > 0 && (
                      <span className="text-xs text-sandstorm-muted font-mono">{cards.length}</span>
                    )}
                  </div>

                  {/* Cards */}
                  <div className="flex flex-col gap-2 flex-1">
                    {cards.length === 0 ? (
                      <div className="flex items-center justify-center h-16 text-xs text-sandstorm-muted/50 border border-dashed border-sandstorm-border rounded-lg">
                        No cards
                      </div>
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
