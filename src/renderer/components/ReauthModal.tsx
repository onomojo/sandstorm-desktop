import React, { useState, useEffect, useCallback } from 'react';

interface ReauthModalProps {
  onClose: () => void;
}

export function ReauthModal({ onClose }: ReauthModalProps) {
  const [loginInProgress, setLoginInProgress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlOpened, setUrlOpened] = useState(false);

  useEffect(() => {
    const unsubUrl = window.sandstorm.on('auth:url-opened', () => {
      setUrlOpened(true);
    });
    const unsubCompleted = window.sandstorm.on('auth:completed', (success: unknown) => {
      setLoginInProgress(false);
      if (success) {
        onClose();
      } else {
        setError('Authentication failed. Please try again.');
        setUrlOpened(false);
      }
    });
    return () => {
      unsubUrl();
      unsubCompleted();
    };
  }, [onClose]);

  const handleReauthenticate = useCallback(async () => {
    setLoginInProgress(true);
    setError(null);
    setUrlOpened(false);
    try {
      const result = await window.sandstorm.auth.login();
      if (!result.success) {
        setLoginInProgress(false);
        setError(result.error || 'Authentication failed. Please try again.');
        setUrlOpened(false);
      }
      // Success is handled by auth:completed event
    } catch {
      setLoginInProgress(false);
      setError('Failed to start authentication. Is Claude Code installed?');
      setUrlOpened(false);
    }
  }, []);

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget && !loginInProgress) onClose();
      }}
    >
      <div className="bg-sandstorm-surface rounded-xl w-[440px] shadow-dialog animate-slide-up border border-sandstorm-border">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-sandstorm-border">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <h2 className="text-sm font-semibold text-sandstorm-text">Authentication Required</h2>
          </div>
          {!loginInProgress && (
            <button
              onClick={onClose}
              className="text-sandstorm-muted hover:text-sandstorm-text transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-sandstorm-text-secondary leading-relaxed">
            Your Claude Code session has expired or is unauthorized. Click the button below to
            re-authenticate. This will open your browser where you can sign in.
          </p>

          {urlOpened && loginInProgress && (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-sandstorm-accent/10 border border-sandstorm-accent/20 text-sm text-sandstorm-accent">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 animate-pulse">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
              Browser opened. Complete sign-in there, then return here.
            </div>
          )}

          {error && (
            <div className="px-3 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-sandstorm-border">
          {!loginInProgress && (
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-sandstorm-text-secondary hover:text-sandstorm-text transition-colors"
            >
              Dismiss
            </button>
          )}
          <button
            onClick={handleReauthenticate}
            disabled={loginInProgress}
            className="px-4 py-2 text-sm font-medium rounded-lg transition-all
              bg-amber-500 hover:bg-amber-400 text-black
              disabled:opacity-60 disabled:cursor-wait
              flex items-center gap-2"
          >
            {loginInProgress ? (
              <>
                <span className="w-3 h-3 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                {urlOpened ? 'Waiting for sign-in...' : 'Opening browser...'}
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4" />
                  <polyline points="10 17 15 12 10 7" />
                  <line x1="15" y1="12" x2="3" y2="12" />
                </svg>
                Re-authenticate
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
