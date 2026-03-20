import React, { useState } from 'react';
import { useAppStore } from '../store';

export function OpenProjectDialog() {
  const { setShowOpenProjectDialog, addProject, setActiveProjectId } = useAppStore();
  const [directory, setDirectory] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBrowse = async () => {
    const selected = await window.sandstorm.projects.browse();
    if (selected) setDirectory(selected);
  };

  const handleOpen = async () => {
    if (!directory.trim()) {
      setError('Directory is required');
      return;
    }

    setAdding(true);
    setError(null);
    try {
      const project = await addProject(directory.trim());
      setActiveProjectId(project.id);
      setShowOpenProjectDialog(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) setShowOpenProjectDialog(false); }}
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[440px] shadow-dialog animate-slide-up">
        <div className="px-6 py-4 border-b border-sandstorm-border flex items-center justify-between">
          <h2 className="text-base font-semibold text-sandstorm-text">Open Project</h2>
          <button
            onClick={() => setShowOpenProjectDialog(false)}
            className="text-sandstorm-muted hover:text-sandstorm-text transition-colors p-1.5 rounded-md hover:bg-sandstorm-surface-hover"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5 flex items-start gap-2 animate-fade-in">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>
              </svg>
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
              Directory <span className="text-sandstorm-accent ml-0.5">*</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                placeholder="/home/user/projects/myapp"
                className="flex-1 bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-[12px] font-mono text-sandstorm-text placeholder-sandstorm-muted/50 outline-none transition-all focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleOpen(); }}
              />
              <button
                onClick={handleBrowse}
                className="px-3 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text border border-sandstorm-border rounded-lg hover:bg-sandstorm-surface-hover transition-all"
              >
                Browse...
              </button>
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-sandstorm-border flex justify-end gap-2">
          <button
            onClick={() => setShowOpenProjectDialog(false)}
            className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text transition-colors rounded-lg hover:bg-sandstorm-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={handleOpen}
            disabled={adding || !directory.trim()}
            className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-glow"
          >
            {adding ? 'Opening...' : 'Open'}
          </button>
        </div>
      </div>
    </div>
  );
}
