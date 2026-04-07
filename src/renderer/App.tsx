import React, { useEffect } from 'react';
import { useAppStore, ThresholdLevel } from './store';
import { Dashboard } from './components/Dashboard';
import { StackDetail } from './components/StackDetail';
import { NewStackDialog } from './components/NewStackDialog';
import { ProjectTabs } from './components/ProjectTabs';
import { OpenProjectDialog } from './components/OpenProjectDialog';
import { AccountUsageBar } from './components/AccountUsageBar';
import { SessionWarningModal } from './components/SessionWarningModal';
import trayIcon from './tray-icon.png';
import buildVersion from './build-version.txt?raw';

/** Polling interval when Docker is connected (ms) */
const STACK_POLL_INTERVAL = 3000;
/** Polling interval when Docker is disconnected (ms) — slow down to avoid hammering */
const STACK_POLL_INTERVAL_DISCONNECTED = 10_000;
/** Metrics polling interval (ms) */
const METRICS_POLL_INTERVAL = 15_000;
/** Account usage polling interval (ms) — polls independently of Docker status */
const ACCOUNT_USAGE_POLL_INTERVAL = 30_000;

export default function App() {
  const {
    selectedStackId,
    showNewStackDialog,
    showOpenProjectDialog,
    dockerConnected,
    refreshStacks,
    refreshProjects,
    refreshStackHistory,
    refreshMetrics,
    refreshAccountUsage,
    refreshSessionState,
    selectStack,
    setDockerConnected,
    sessionMonitorState,
    sessionWarningLevel,
    showSessionWarningModal,
    setShowSessionWarningModal,
    error,
  } = useAppStore();

  // Check Docker status on mount and listen for connection events
  useEffect(() => {
    // Initial status check
    window.sandstorm.docker.status().then(({ connected }) => {
      setDockerConnected(connected);
    }).catch(() => {});

    const unsubConnected = window.sandstorm.on('docker:connected', () => {
      setDockerConnected(true);
      // Immediately refresh on reconnect
      refreshStacks();
      refreshMetrics();
    });
    const unsubDisconnected = window.sandstorm.on('docker:disconnected', () => {
      setDockerConnected(false);
    });

    return () => {
      unsubConnected();
      unsubDisconnected();
    };
  }, [setDockerConnected, refreshStacks, refreshMetrics]);

  // Poll account usage independently of Docker — it's account-level, not stack-level
  useEffect(() => {
    refreshAccountUsage();
    const interval = setInterval(refreshAccountUsage, ACCOUNT_USAGE_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [refreshAccountUsage]);

  // Session monitor: listen for threshold/halt/reset IPC events from main process
  useEffect(() => {
    refreshSessionState();

    const unsubThreshold = window.sandstorm.on('session:threshold', (data: unknown) => {
      const { level, usage } = data as { level: ThresholdLevel; usage: unknown };
      useAppStore.setState({ sessionWarningLevel: level });
      if (level === 'critical' || level === 'limit' || level === 'over_limit') {
        useAppStore.setState({ showSessionWarningModal: true });
      }
      refreshSessionState();
    });

    const unsubHalted = window.sandstorm.on('session:halted', () => {
      refreshSessionState();
      refreshStacks();
    });

    const unsubReset = window.sandstorm.on('session:reset', () => {
      useAppStore.setState({ sessionWarningLevel: null, showSessionWarningModal: false });
      refreshSessionState();
      refreshStacks();
    });

    const unsubState = window.sandstorm.on('session:state', () => {
      refreshSessionState();
    });

    return () => {
      unsubThreshold();
      unsubHalted();
      unsubReset();
      unsubState();
    };
  }, [refreshSessionState, refreshStacks]);

  useEffect(() => {
    refreshProjects();
    refreshStacks();
    refreshStackHistory();
    refreshMetrics();

    // Adaptive polling: slower when Docker is disconnected
    const pollInterval = dockerConnected
      ? STACK_POLL_INTERVAL
      : STACK_POLL_INTERVAL_DISCONNECTED;
    const interval = setInterval(refreshStacks, pollInterval);
    // Only poll metrics when Docker is connected
    const metricsInterval = dockerConnected
      ? setInterval(refreshMetrics, METRICS_POLL_INTERVAL)
      : null;

    const unsubCompleted = window.sandstorm.on('task:completed', () => {
      refreshStacks();
    });
    const unsubFailed = window.sandstorm.on('task:failed', () => {
      refreshStacks();
    });
    const unsubNavigate = window.sandstorm.on(
      'navigate:stack',
      (stackId: unknown) => {
        selectStack(stackId as string);
      }
    );
    const unsubStacksUpdated = window.sandstorm.on('stacks:updated', () => {
      refreshStacks();
      refreshStackHistory();
    });

    return () => {
      clearInterval(interval);
      if (metricsInterval) clearInterval(metricsInterval);
      unsubCompleted();
      unsubFailed();
      unsubNavigate();
      unsubStacksUpdated();
    };
  }, [dockerConnected, refreshStacks, refreshProjects, refreshStackHistory, refreshMetrics, selectStack]);

  return (
    <div className="h-screen flex flex-col bg-sandstorm-bg text-sandstorm-text">
      {/* Title bar — centered on macOS to avoid traffic lights, left-aligned elsewhere */}
      <div className={`titlebar-drag h-10 bg-sandstorm-surface border-b border-sandstorm-border flex items-center px-4 shrink-0 relative ${navigator.platform.includes('Mac') ? 'justify-center' : ''}`}>
        <div className="titlebar-no-drag flex items-center gap-2.5">
          <img src={trayIcon} alt="Sandstorm" className="w-6 h-6" />
          <span className="text-xs font-semibold text-sandstorm-muted tracking-wide uppercase">
            Sandstorm
          </span>
          <span className="text-[10px] text-sandstorm-muted/50 font-mono" title={`Build: ${buildVersion.trim()}`}>
            {buildVersion.trim()}
          </span>
        </div>
        <div className="titlebar-no-drag absolute right-4">
          <AccountUsageBar />
        </div>
      </div>

      {/* Project tabs */}
      <ProjectTabs />

      {/* Docker disconnected banner */}
      {!dockerConnected && (
        <div className="bg-yellow-500/10 border-b border-yellow-500/20 px-4 py-2.5 text-sm text-yellow-400 flex items-center gap-2 shrink-0 animate-fade-in">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0">
            <path d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Docker is unavailable — waiting for reconnection. Stack data may be stale.
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="bg-red-500/10 border-b border-red-500/20 px-4 py-2.5 text-sm text-red-400 flex items-center gap-2 shrink-0 animate-fade-in">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
            <path d="M12 8v4m0 4h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          {error}
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 overflow-hidden">
        {selectedStackId ? (
          <StackDetail
            stackId={selectedStackId}
            onBack={() => selectStack(null)}
          />
        ) : (
          <Dashboard />
        )}
      </div>

      {/* Session warning banner (non-blocking, at 80% threshold) */}
      {sessionWarningLevel === 'warning' && sessionMonitorState?.usage && (
        <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2.5 text-sm text-amber-400 flex items-center gap-2 shrink-0 animate-fade-in" data-testid="session-warning-banner">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            <line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          You've used {Math.round(sessionMonitorState.usage.percent)}% of your session token limit. Consider pausing non-critical stacks.
        </div>
      )}

      {/* Dialogs */}
      {showNewStackDialog && <NewStackDialog />}
      {showOpenProjectDialog && <OpenProjectDialog />}

      {/* Session warning modal (blocking, at 95% and 100% thresholds) */}
      {showSessionWarningModal && sessionWarningLevel && sessionWarningLevel !== 'warning' && sessionWarningLevel !== 'normal' && (
        <SessionWarningModal
          level={sessionWarningLevel}
          usage={sessionMonitorState?.usage ?? null}
          onClose={() => setShowSessionWarningModal(false)}
        />
      )}
    </div>
  );
}
