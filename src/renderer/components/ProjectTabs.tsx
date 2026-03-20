import React from 'react';
import { useAppStore } from '../store';

export function ProjectTabs() {
  const {
    projects,
    activeProjectId,
    setActiveProjectId,
    setShowOpenProjectDialog,
    removeProject,
  } = useAppStore();

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
      {projects.map((project) => (
        <button
          key={project.id}
          onClick={() => setActiveProjectId(project.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (confirm(`Remove project "${project.name}" from tabs?`)) {
              removeProject(project.id);
            }
          }}
          className={`group shrink-0 px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
            activeProjectId === project.id
              ? 'border-sandstorm-accent text-sandstorm-accent'
              : 'border-transparent text-sandstorm-muted hover:text-sandstorm-text-secondary'
          }`}
          title={project.directory}
        >
          {project.name}
        </button>
      ))}

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
    </div>
  );
}
