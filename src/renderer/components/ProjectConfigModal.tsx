import React, { useState, useEffect, useCallback } from 'react';
import { ConfigPane } from './config/types';

interface ProjectConfigModalProps {
  open: boolean;
  title: string;
  subtitle?: string;
  panes: ConfigPane[];
  initialPaneId?: string;
  onClose: () => void;
  onSave: () => void;
  saving?: boolean;
  dirty?: boolean;
}

function resolveInitialPane(panes: ConfigPane[], initialPaneId?: string): string | null {
  const enabled = panes.filter((p) => !p.disabled);
  if (enabled.length === 0) return null;

  if (initialPaneId) {
    const target = panes.find((p) => p.id === initialPaneId);
    if (target && !target.disabled) return target.id;
  }

  return enabled[0].id;
}

export function ProjectConfigModal({
  open,
  title,
  subtitle,
  panes,
  initialPaneId,
  onClose,
  onSave,
  saving = false,
  dirty = false,
}: ProjectConfigModalProps) {
  const [activePaneId, setActivePaneId] = useState<string | null>(() =>
    resolveInitialPane(panes, initialPaneId)
  );

  useEffect(() => {
    setActivePaneId(resolveInitialPane(panes, initialPaneId));
  }, [panes, initialPaneId]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose]
  );

  const handlePaneClick = useCallback(
    (pane: ConfigPane) => {
      if (!pane.disabled) setActivePaneId(pane.id);
    },
    []
  );

  if (!open) return null;

  const activePane = panes.find((p) => p.id === activePaneId);

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={handleOverlayClick}
      onKeyDown={handleKeyDown}
      data-testid="project-config-modal-overlay"
    >
      <div
        className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[720px] max-h-[90vh] shadow-dialog animate-slide-up flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="project-config-modal"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-sandstorm-border flex-shrink-0">
          <h2 className="text-base font-semibold text-sandstorm-text">{title}</h2>
          {subtitle && (
            <p className="text-xs text-sandstorm-muted mt-0.5">{subtitle}</p>
          )}
        </div>

        {/* Body: left rail + content */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left rail */}
          <nav
            className="w-44 flex-shrink-0 border-r border-sandstorm-border py-3 flex flex-col gap-0.5 px-2"
            data-testid="project-config-rail"
          >
            {panes.map((pane) => {
              const isActive = pane.id === activePaneId;
              const isDisabled = !!pane.disabled;
              return (
                <button
                  key={pane.id}
                  onClick={() => handlePaneClick(pane)}
                  disabled={isDisabled}
                  aria-disabled={isDisabled}
                  aria-pressed={isActive}
                  data-testid={`config-rail-item-${pane.id}`}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all w-full text-left ${
                    isDisabled
                      ? 'text-sandstorm-muted/40 cursor-not-allowed'
                      : isActive
                        ? 'bg-sandstorm-accent/10 text-sandstorm-accent'
                        : 'text-sandstorm-text-secondary hover:bg-sandstorm-surface-hover hover:text-sandstorm-text'
                  }`}
                >
                  <span className="flex-shrink-0">{pane.icon}</span>
                  <span className="flex-1 truncate">{pane.label}</span>
                  {pane.badge && (
                    <span className="ml-auto text-[10px] bg-sandstorm-accent/20 text-sandstorm-accent rounded-full px-1.5 py-0.5 leading-none flex-shrink-0">
                      {pane.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Content area */}
          <div
            className="flex-1 overflow-y-auto px-6 py-5"
            data-testid="project-config-content"
          >
            {activePane ? activePane.render() : null}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-sandstorm-border flex items-center justify-end gap-3 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium rounded-lg border border-sandstorm-border text-sandstorm-text-secondary hover:text-sandstorm-text hover:border-sandstorm-border-light transition-all"
            data-testid="project-config-cancel"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={!dirty || saving}
            className={`px-4 py-2 text-xs font-medium rounded-lg transition-all flex items-center gap-2 ${
              dirty && !saving
                ? 'bg-sandstorm-accent text-sandstorm-bg hover:bg-sandstorm-accent/90'
                : 'bg-sandstorm-accent/30 text-sandstorm-muted cursor-not-allowed'
            }`}
            data-testid="project-config-save"
          >
            {saving && (
              <span
                className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin"
                data-testid="project-config-save-spinner"
              />
            )}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
