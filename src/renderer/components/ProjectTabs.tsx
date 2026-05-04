import React, { useState } from 'react';
import { useAppStore, RefinementSession } from '../store';

export function ProjectTabs() {
  const {
    projects,
    activeProjectId,
    setActiveProjectId,
    setShowOpenProjectDialog,
    removeProject,
    refinementSessions,
  } = useAppStore();

  const [confirmingCloseId, setConfirmingCloseId] = useState<number | null>(null);

  const handleClose = (e: React.MouseEvent, projectId: number) => {
    e.stopPropagation();
    setConfirmingCloseId(projectId);
  };

  const confirmClose = async (projectId: number) => {
    setConfirmingCloseId(null);
    await removeProject(projectId);
  };

  const cancelClose = () => {
    setConfirmingCloseId(null);
  };

  return (
    <div className="titlebar-no-drag flex items-center bg-sandstorm-surface border-b border-sandstorm-border shrink-0 overflow-x-auto">
      {/* All tab */}
      <button
        onClick={() => setActiveProjectId(null)}
        className={`shrink-0 px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
          activeProjectId === null
            ? 'border-sandstorm-accent text-sandstorm-accent'
            : 'border-transparent text-sandstorm-muted hover:text-sandstorm-text-secondary'
        }`}
      >
        <span className="flex items-center gap-1.5">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.27 5.82 22 7 14.14l-5-4.87 6.91-1.01z"/>
          </svg>
          All
        </span>
      </button>

      {/* Project tabs */}
      {projects.map((project) => {
        const isActive = activeProjectId === project.id;
        const badgeCount = isActive
          ? 0
          : refinementSessions.filter((s: RefinementSession) => s.projectDir === project.directory).length;
        return (
        <div key={project.id} className="group relative shrink-0">
          <button
            onClick={() => setActiveProjectId(project.id)}
            className={`shrink-0 pl-4 pr-7 py-2 text-xs font-medium transition-colors border-b-2 ${
              isActive
                ? 'border-sandstorm-accent text-sandstorm-accent'
                : 'border-transparent text-sandstorm-muted hover:text-sandstorm-text-secondary'
            }`}
            title={project.directory}
          >
            <span className="flex items-center gap-1.5">
              {project.name}
              {badgeCount > 0 && (
                <span
                  data-testid={`refinement-badge-${project.id}`}
                  className="flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-sandstorm-accent text-white text-[10px] font-semibold leading-none"
                >
                  {badgeCount}
                </span>
              )}
            </span>
          </button>
          <button
            onClick={(e) => handleClose(e, project.id)}
            className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:!opacity-100 hover:bg-sandstorm-border text-sandstorm-muted hover:text-sandstorm-text-secondary transition-opacity"
            aria-label={`Close ${project.name}`}
            title={`Close ${project.name}`}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
        );
      })}

      {/* Add project button */}
      <button
        onClick={() => setShowOpenProjectDialog(true)}
        className="shrink-0 px-3 py-2 text-xs text-sandstorm-muted hover:text-sandstorm-text-secondary transition-colors"
        title="Open project"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 5v14M5 12h14"/>
        </svg>
      </button>

      {/* Close confirmation dialog */}
      {confirmingCloseId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={cancelClose}>
          <div className="bg-sandstorm-surface border border-sandstorm-border rounded-lg p-4 shadow-lg max-w-sm" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm text-sandstorm-text-primary mb-1">
              Close project &quot;{projects.find((p) => p.id === confirmingCloseId)?.name}&quot;?
            </p>
            <p className="text-xs text-sandstorm-muted mb-4">
              This won&apos;t affect running stacks.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={cancelClose}
                className="px-3 py-1.5 text-xs rounded bg-sandstorm-border text-sandstorm-text-secondary hover:bg-sandstorm-border/80"
              >
                Cancel
              </button>
              <button
                onClick={() => confirmClose(confirmingCloseId)}
                className="px-3 py-1.5 text-xs rounded bg-sandstorm-accent text-white hover:bg-sandstorm-accent/80"
              >
                Close Project
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
