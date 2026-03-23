import React, { useEffect, useState, useCallback } from 'react';

interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  expired: boolean;
  expiresAt?: number;
}

export function AuthIndicator() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loginInProgress, setLoginInProgress] = useState(false);

  const checkStatus = useCallback(async () => {
    try {
      const s = await window.sandstorm.auth.status();
      setStatus(s);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    checkStatus();
    // Re-check every 60 seconds
    const interval = setInterval(checkStatus, 60_000);

    // Listen for auth completion events
    const unsub = window.sandstorm.on('auth:completed', () => {
      setLoginInProgress(false);
      checkStatus();
    });

    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [checkStatus]);

  const handleLogin = async () => {
    setLoginInProgress(true);
    try {
      const result = await window.sandstorm.auth.login();
      if (!result.success) {
        setLoginInProgress(false);
      }
      // Status will update via the auth:completed event
    } catch {
      setLoginInProgress(false);
    }
    await checkStatus();
  };

  if (!status) return null;

  const needsAuth = !status.loggedIn || status.expired;

  if (needsAuth) {
    return (
      <button
        onClick={handleLogin}
        disabled={loginInProgress}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-all
          border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 hover:border-amber-500/50
          disabled:opacity-50 disabled:cursor-wait"
        title={status.expired ? 'OAuth token expired — click to reauthenticate' : 'Not logged in — click to authenticate'}
      >
        {/* Warning icon */}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        {loginInProgress ? 'Authenticating...' : status.expired ? 'Token Expired' : 'Login'}
      </button>
    );
  }

  // Logged in and valid
  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-sandstorm-muted"
      title={status.email ? `Signed in as ${status.email}` : 'Claude authenticated'}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
      {status.email ? status.email : 'Authenticated'}
    </div>
  );
}
