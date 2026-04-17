import React, { useState } from 'react';
import { Project } from '../store';

export function UninitializedProject({ project }: { project: Project }) {
  const [initializing, setInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [skippedFiles, setSkippedFiles] = useState<string[]>([]);

  const handleInitialize = async () => {
    setInitializing(true);
    setError(null);
    try {
      const result = await window.sandstorm.projects.initialize(project.directory);
      if (result.success) {
        setSkippedFiles(result.skippedFiles ?? []);
        setInitialized(true);
      } else {
        setError(result.error || 'Initialization failed');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setInitializing(false);
    }
  };

  if (initialized) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-sandstorm-muted">
        <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-4">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-emerald-400">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
        </div>
        <p className="text-sm font-medium text-sandstorm-text mb-1">Sandstorm initialized!</p>
        <p className="text-xs text-sandstorm-muted">You can now create stacks for this project.</p>
        {skippedFiles.length > 0 && (
          <div className="mt-4 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5 max-w-xs">
            <p className="font-medium mb-1">Some files already existed and were not overwritten:</p>
            <ul className="list-disc list-inside space-y-0.5">
              {skippedFiles.map((f) => (
                <li key={f} className="font-mono">{f}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full text-sandstorm-muted">
      <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mb-4">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-amber-400">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      </div>
      <p className="text-sm font-medium text-sandstorm-text mb-1">Sandstorm is not initialized</p>
      <p className="text-xs text-sandstorm-muted mb-5 text-center max-w-xs">
        This project needs to be set up before you can create stacks.
      </p>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5 mb-4 animate-fade-in">
          {error}
        </div>
      )}

      <button
        onClick={handleInitialize}
        disabled={initializing}
        className="px-5 py-2.5 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-sm font-medium rounded-lg disabled:opacity-40 transition-all active:scale-[0.98] shadow-glow"
      >
        {initializing ? 'Initializing...' : 'Initialize Sandstorm'}
      </button>
    </div>
  );
}
