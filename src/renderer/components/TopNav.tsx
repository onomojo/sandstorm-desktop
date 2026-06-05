import React, { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { AskClaudeModal } from './AskClaudeModal';
import { AuthIndicator } from './AuthIndicator';
import trayIcon from '../tray-icon.png';

function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" stroke="currentColor" strokeWidth="2"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" strokeWidth="2"/>
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

function AskClaudeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="text-sandstorm-muted shrink-0">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}


export function TopNav() {
  const {
    projects,
    activeProjectId,
    setActiveProjectId,
    setShowOpenProjectDialog,
    boardTickets,
    setShowCreateTicketDialog,
    setShowModelSettings,
    activeProject,
    mainView,
    setMainView,
    selectStack,
    searchQuery,
    setSearchQuery,
  } = useAppStore();

  const [showAskClaude, setShowAskClaude] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);

  const workspaceRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  const project = activeProject();

  useEffect(() => {
    if (!workspaceOpen) return;
    function handleOutsideClick(e: MouseEvent) {
      if (workspaceRef.current && !workspaceRef.current.contains(e.target as Node)) {
        setWorkspaceOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [workspaceOpen]);

  useEffect(() => {
    if (!viewOpen) return;
    function handleOutsideClick(e: MouseEvent) {
      if (viewRef.current && !viewRef.current.contains(e.target as Node)) {
        setViewOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [viewOpen]);

  return (
    <>
      <nav
        className="grid grid-cols-3 items-center px-4 shrink-0 border-b border-sandstorm-border bg-sandstorm-rail"
        style={{ height: '62px' }}
        data-testid="top-nav"
      >
        {/* Left zone: brand + workspace switcher + view switcher */}
        <div className="flex items-center gap-1 min-w-0">
          <img src={trayIcon} alt="Sandstorm" className="w-6 h-6 shrink-0 mr-1" />
          <span className="text-sm font-bold text-sandstorm-text tracking-wide shrink-0">Sandstorm</span>

          <span className="text-sandstorm-muted/60 px-1 shrink-0">/</span>

          {/* Workspace switcher */}
          <div className="relative" ref={workspaceRef}>
            <button
              onClick={() => setWorkspaceOpen((o) => !o)}
              className="flex items-center gap-1 px-2 py-1 rounded text-sm text-sandstorm-text hover:bg-sandstorm-surface transition-colors max-w-[160px]"
              data-testid="workspace-switcher-btn"
            >
              <span className="truncate">{project?.name ?? '—'}</span>
              <ChevronDown />
            </button>

            {workspaceOpen && (
              <div
                className="absolute top-full left-0 mt-1 z-50 min-w-[200px] rounded-lg bg-sandstorm-surface border border-sandstorm-border shadow-dialog py-1"
                data-testid="workspace-dropdown"
              >
                {projects.map((proj) => {
                  const ticketCount = boardTickets.filter((t) => t.project_dir === proj.directory).length;
                  return (
                    <button
                      key={proj.id}
                      onClick={() => {
                        setActiveProjectId(proj.id);
                        setWorkspaceOpen(false);
                      }}
                      className={`flex items-center justify-between w-full px-3 py-2 text-sm text-left hover:bg-sandstorm-accent/10 transition-colors ${
                        proj.id === activeProjectId ? 'text-sandstorm-text' : 'text-sandstorm-text-secondary'
                      }`}
                      data-testid={`workspace-item-${proj.id}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {proj.id === activeProjectId && (
                          <span className="w-1.5 h-1.5 rounded-full bg-sandstorm-accent shrink-0" />
                        )}
                        <span className="truncate">{proj.name}</span>
                      </div>
                      {ticketCount > 0 && (
                        <span
                          className="text-xs font-mono px-1.5 py-0.5 rounded-full bg-sandstorm-border text-sandstorm-muted ml-2 shrink-0"
                          data-testid={`workspace-badge-${proj.id}`}
                        >
                          {ticketCount}
                        </span>
                      )}
                    </button>
                  );
                })}
                <div className="border-t border-sandstorm-border mt-1 pt-1">
                  <button
                    onClick={() => {
                      setShowOpenProjectDialog(true);
                      setWorkspaceOpen(false);
                    }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-sm text-sandstorm-muted hover:text-sandstorm-text hover:bg-sandstorm-accent/10 transition-colors"
                    data-testid="add-project-btn"
                  >
                    <PlusIcon />
                    Add project
                  </button>
                </div>
              </div>
            )}
          </div>

          <span className="text-sandstorm-muted/60 px-1 shrink-0">/</span>

          {/* View switcher */}
          <div className="relative" ref={viewRef}>
            <button
              onClick={() => setViewOpen((o) => !o)}
              className="flex items-center gap-1 px-2 py-1 rounded text-sm text-sandstorm-text hover:bg-sandstorm-surface transition-colors"
              data-testid="view-switcher-btn"
            >
              <span>{mainView === 'telemetry' ? 'Telemetry' : 'Board'}</span>
              <ChevronDown />
            </button>

            {viewOpen && (
              <div
                className="absolute top-full left-0 mt-1 z-50 min-w-[140px] rounded-lg bg-sandstorm-surface border border-sandstorm-border shadow-dialog py-1"
                data-testid="view-dropdown"
              >
                <button
                  onClick={() => {
                    setMainView('board');
                    setViewOpen(false);
                  }}
                  className={`flex items-center w-full px-3 py-2 text-sm text-left hover:bg-sandstorm-accent/10 transition-colors ${
                    mainView === 'board' ? 'text-sandstorm-text' : 'text-sandstorm-text-secondary'
                  }`}
                  data-testid="view-item-board"
                >
                  Board
                </button>
                <button
                  onClick={() => {
                    setMainView('telemetry');
                    selectStack(null);
                    setViewOpen(false);
                  }}
                  className={`flex items-center w-full px-3 py-2 text-sm text-left hover:bg-sandstorm-accent/10 transition-colors ${
                    mainView === 'telemetry' ? 'text-sandstorm-text' : 'text-sandstorm-text-secondary'
                  }`}
                  data-testid="view-item-telemetry"
                >
                  Telemetry
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Center zone: search */}
        <div className="flex justify-center px-4">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tickets…"
            className="w-full max-w-sm px-3 py-1.5 text-sm bg-sandstorm-surface border border-sandstorm-border rounded-lg text-sandstorm-text placeholder-sandstorm-muted/60 focus:outline-none focus:border-sandstorm-accent"
            data-testid="search-input"
          />
        </div>

        {/* Right zone: actions + identity */}
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => setShowAskClaude(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sandstorm-surface border border-sandstorm-border hover:border-sandstorm-border-light transition-colors text-sm text-sandstorm-text-secondary hover:text-sandstorm-text"
            data-testid="ask-claude-btn"
          >
            <AskClaudeIcon />
            Ask Claude
          </button>

          <button
            onClick={() => setShowCreateTicketDialog(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sandstorm-accent text-sandstorm-rail font-semibold text-sm hover:bg-sandstorm-accent-hover transition-colors"
            data-testid="new-ticket-btn"
          >
            <PlusIcon />
            New ticket
          </button>

          <div className="w-px h-5 bg-sandstorm-border shrink-0" />

          <button
            onClick={() => setShowModelSettings(true)}
            className="p-1.5 rounded-lg text-sandstorm-muted hover:text-sandstorm-text hover:bg-sandstorm-surface transition-colors"
            data-testid="settings-cog-btn"
            title="Settings"
          >
            <GearIcon />
          </button>

          <div data-testid="nav-identity">
            <AuthIndicator />
          </div>
        </div>
      </nav>

      {showAskClaude && (
        <AskClaudeModal
          onClose={() => setShowAskClaude(false)}
          projectDir={project?.directory}
        />
      )}
    </>
  );
}
