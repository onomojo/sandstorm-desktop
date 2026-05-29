import React, { useState, useEffect } from 'react';
import { useAppStore, selectProjectTickets } from '../store';
import { cronNextFire, formatRelativeTime } from '../utils/cronNextFire';
import { AskClaudeModal } from './AskClaudeModal';
import trayIcon from '../tray-icon.png';

function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" stroke="currentColor" strokeWidth="2"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" strokeWidth="2"/>
    </svg>
  );
}

interface AuthState {
  loggedIn: boolean;
  email?: string;
  expired: boolean;
}

export function LeftRail() {
  const {
    projects,
    activeProjectId,
    setActiveProjectId,
    setShowOpenProjectDialog,
    stacks,
    boardTickets,
    schedules,
    refreshSchedules,
    setShowCreateTicketDialog,
    setShowModelSettings,
    activeProject,
  } = useAppStore();

  const [showAskClaude, setShowAskClaude] = useState(false);
  const [showGearForProject, setShowGearForProject] = useState<number | null>(null);
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [, setTick] = useState(0);

  const project = activeProject();

  // Refresh auth state on mount
  useEffect(() => {
    window.sandstorm.auth.status().then(setAuthState).catch(() => {});
  }, []);

  // Refresh schedules when project changes
  useEffect(() => {
    if (project?.directory) {
      refreshSchedules(project.directory);
    }
  }, [project?.directory, refreshSchedules]);

  // Tick every 30s to keep "next fire" and "synced ago" fresh — force re-render
  useEffect(() => {
    const interval = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  // Derived stats
  const projectDir = project?.directory;
  const projectTickets = selectProjectTickets(boardTickets, projectDir);

  const liveStacks = stacks.filter((s) => {
    const isActive = ['running', 'building', 'rebuilding', 'up', 'idle'].includes(s.status);
    return isActive && (!projectDir || s.project_dir === projectDir);
  });

  const prStacks = stacks.filter((s) => {
    const hasPr = s.pr_url != null;
    return hasPr && (!projectDir || s.project_dir === projectDir);
  });

  const enabledSchedules = schedules.filter((s) => s.enabled);

  return (
    <>
      <div
        className="flex flex-col h-full shrink-0 border-r border-sandstorm-border overflow-hidden bg-sandstorm-rail"
        style={{ width: '320px' }}
        data-testid="left-rail"
      >
        {/* Brand mark */}
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-4 shrink-0">
          <img src={trayIcon} alt="Sandstorm" className="w-7 h-7" />
          <div className="flex flex-col">
            <span className="text-sm font-bold text-sandstorm-text tracking-wide">Sandstorm</span>
            <span className="text-[10px] text-sandstorm-muted uppercase tracking-widest">Agent Control</span>
          </div>
        </div>

        {/* Scroll area */}
        <div className="flex-1 overflow-y-auto flex flex-col gap-4 px-3 pb-3 min-h-0">

          {/* Workspaces */}
          <section data-testid="rail-workspaces">
            <div className="px-2 mb-1.5">
              <span className="text-[10px] font-semibold text-sandstorm-muted uppercase tracking-widest">
                Workspaces
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              {projects.map((proj) => {
                const isActive = proj.id === activeProjectId;
                const projTicketCount = boardTickets.filter((t) => t.project_dir === proj.directory).length;
                return (
                  <div
                    key={proj.id}
                    className={`group relative flex items-center justify-between rounded-lg px-3 py-2 cursor-pointer transition-colors ${
                      isActive
                        ? 'bg-sandstorm-accent/15 text-sandstorm-text'
                        : 'hover:bg-sandstorm-surface text-sandstorm-text-secondary hover:text-sandstorm-text'
                    }`}
                    onClick={() => setActiveProjectId(proj.id)}
                    onMouseEnter={() => setShowGearForProject(proj.id)}
                    onMouseLeave={() => setShowGearForProject(null)}
                    data-testid={`workspace-pill-${proj.id}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isActive && (
                        <span className="w-1.5 h-1.5 rounded-full bg-sandstorm-accent shrink-0" />
                      )}
                      <span className="text-sm truncate">{proj.name}</span>
                    </div>

                    {/* Badge or gear on hover */}
                    {isActive && showGearForProject === proj.id ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowModelSettings(true);
                        }}
                        className="p-0.5 rounded hover:bg-sandstorm-accent/20 text-sandstorm-muted hover:text-sandstorm-accent transition-colors"
                        data-testid={`workspace-gear-${proj.id}`}
                        title="Project settings"
                      >
                        <GearIcon />
                      </button>
                    ) : (
                      projTicketCount > 0 && (
                        <span
                          className={`text-xs font-mono px-1.5 py-0.5 rounded-full ${
                            isActive
                              ? 'bg-sandstorm-accent text-sandstorm-rail'
                              : 'bg-sandstorm-border text-sandstorm-muted'
                          }`}
                          data-testid={`workspace-badge-${proj.id}`}
                        >
                          {projTicketCount}
                        </span>
                      )
                    )}
                  </div>
                );
              })}

              {/* Add project */}
              <button
                onClick={() => setShowOpenProjectDialog(true)}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sandstorm-muted hover:text-sandstorm-text hover:bg-sandstorm-surface transition-colors w-full text-left"
                data-testid="add-project-btn"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
                <span className="text-sm">Add project</span>
              </button>
            </div>
          </section>

          {/* New Ticket button */}
          {project && (
            <button
              onClick={() => setShowCreateTicketDialog(true)}
              className="flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-lg bg-sandstorm-accent text-sandstorm-rail font-semibold text-sm hover:bg-sandstorm-accent-hover transition-colors shrink-0"
              data-testid="new-ticket-btn"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              New ticket
            </button>
          )}

          {/* Project stats */}
          {project && (
            <section data-testid="rail-project-stats">
              <div className="px-2 mb-1.5">
                <span className="text-[10px] font-semibold text-sandstorm-muted uppercase tracking-widest">
                  Project stats
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <StatTile label="Tickets" value={projectTickets.length} testId="stat-tickets" />
                <StatTile label="Live" value={liveStacks.length} testId="stat-live" />
                <StatTile label="PRs" value={prStacks.length} testId="stat-prs" />
              </div>
            </section>
          )}

          {/* Automation */}
          {project && enabledSchedules.length > 0 && (
            <section data-testid="rail-automation">
              <div className="px-2 mb-1.5">
                <span className="text-[10px] font-semibold text-sandstorm-muted uppercase tracking-widest">
                  Automation
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {enabledSchedules.map((sched) => {
                  const nextFire = cronNextFire(sched.cronExpression);
                  return (
                    <div
                      key={sched.id}
                      className="flex items-center justify-between px-3 py-2 rounded-lg bg-sandstorm-surface border border-sandstorm-border"
                      data-testid={`schedule-row-${sched.id}`}
                    >
                      <span className="text-xs text-sandstorm-text-secondary truncate flex-1 mr-2">
                        {sched.label ?? sched.action.kind}
                      </span>
                      <span className="text-[10px] font-mono text-sandstorm-muted shrink-0" data-testid={`schedule-next-${sched.id}`}>
                        {nextFire ? formatRelativeTime(nextFire) : sched.cronExpression}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Ask Claude */}
          <section data-testid="rail-ask-claude">
            <button
              onClick={() => setShowAskClaude(true)}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-sandstorm-surface border border-sandstorm-border hover:border-sandstorm-border-light transition-colors text-left"
              data-testid="ask-claude-btn"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="text-sandstorm-muted shrink-0">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <div className="flex flex-col min-w-0">
                <span className="text-sm text-sandstorm-text-secondary font-medium">Ask Claude</span>
                <span className="text-[11px] text-sandstorm-muted">Outer orchestrator</span>
              </div>
            </button>
          </section>
        </div>

        {/* Identity footer */}
        <div className="border-t border-sandstorm-border px-4 py-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-full bg-sandstorm-accent/20 flex items-center justify-center shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-sandstorm-accent">
                <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="flex flex-col min-w-0">
              {authState?.email ? (
                <>
                  <span className="text-xs text-sandstorm-text truncate">{authState.email}</span>
                  <span className="text-[10px] text-sandstorm-muted">
                    {authState.expired ? 'Session expired' : 'Connected'}
                  </span>
                </>
              ) : (
                <span className="text-xs text-sandstorm-muted">Not logged in</span>
              )}
            </div>
          </div>
          <button
            onClick={() => setShowModelSettings(true)}
            className="p-1.5 rounded-lg text-sandstorm-muted hover:text-sandstorm-text hover:bg-sandstorm-surface transition-colors"
            data-testid="settings-cog-btn"
            title="Settings"
          >
            <GearIcon />
          </button>
        </div>
      </div>

      {/* Ask Claude modal */}
      {showAskClaude && (
        <AskClaudeModal
          onClose={() => setShowAskClaude(false)}
          projectDir={project?.directory}
        />
      )}
    </>
  );
}

function StatTile({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <div
      className="flex flex-col items-center gap-0.5 py-2.5 px-2 rounded-lg bg-sandstorm-surface border border-sandstorm-border"
      data-testid={testId}
    >
      <span className="text-base font-bold font-mono text-sandstorm-text">{value}</span>
      <span className="text-[10px] text-sandstorm-muted">{label}</span>
    </div>
  );
}
