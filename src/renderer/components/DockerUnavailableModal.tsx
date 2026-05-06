import React from 'react';

interface Props {
  onDismiss: () => void;
}

export function DockerUnavailableModal({ onDismiss }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      data-testid="docker-unavailable-modal"
    >
      <div className="bg-sandstorm-surface border border-red-500/30 rounded-xl shadow-2xl w-[440px] p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center shrink-0">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-red-400"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold text-sandstorm-text">Docker is not running</h2>
            <p className="text-xs text-red-400 font-medium">Stack status could not be reconciled</p>
          </div>
        </div>

        <p className="text-sm text-sandstorm-text-secondary mb-4">
          Sandstorm requires Docker to manage agent stacks. Please start Docker Desktop (or the
          Docker daemon) and relaunch the app to ensure stack statuses are up to date.
        </p>

        <p className="text-xs text-sandstorm-muted mb-5">
          Stack data shown may be stale until Docker is available and the app is restarted.
        </p>

        <button
          onClick={onDismiss}
          className="w-full py-2 px-4 bg-sandstorm-surface-hover hover:bg-sandstorm-border text-sandstorm-text text-sm font-medium rounded-lg transition-colors"
          data-testid="docker-unavailable-dismiss"
        >
          Continue anyway
        </button>
      </div>
    </div>
  );
}
