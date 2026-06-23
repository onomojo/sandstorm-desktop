import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useAppStore, ThresholdLevel } from './store';
import { EVENT_CHANNELS } from '../main/ipc-channels';
import { StackDetail } from './components/StackDetail';
import { RefineTicketDialog } from './components/RefineTicketDialog';
import { CreateTicketDialog } from './components/CreateTicketDialog';
import { EditTicketDialog } from './components/EditTicketDialog';
import { StartTicketDialog } from './components/StartTicketDialog';
import { CreatePRDialog } from './components/CreatePRDialog';
import { OpenProjectDialog } from './components/OpenProjectDialog';
import { SessionWarningModal } from './components/SessionWarningModal';
import { SessionTokenLimitModal } from './components/SessionTokenLimitModal';
import { ProjectConfigModal } from './components/ProjectConfigModal';
import { buildConfigPanes } from './components/config/panes';
import type { ConfigPane } from './components/config/types';
import { StaleWorkspaces } from './components/StaleWorkspaces';
import { GlobalSettingsModal } from './components/GlobalSettingsModal';
import { TopNav } from './components/TopNav';
import { KanbanBoard } from './components/KanbanBoard';
import { TelemetryView } from './components/TelemetryView';

function ProjectConfigModalMount({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activeProject } = useAppStore();
  const project = activeProject();
  const [panes, setPanes] = useState<ConfigPane[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const pendingSave = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!open || !project) {
      setPanes([]);
      setDirty(false);
      pendingSave.current = null;
      return;
    }
    const ctx = {
      projectDir: project.directory,
      routing: window.sandstorm.modelRouting,
      darkFactory: window.sandstorm.darkFactory,
      ticketing: window.sandstorm.projectTicketConfig,
      providerSecrets: window.sandstorm.providerSecrets,
      onDirtyChange: setDirty,
      registerSave: (fn: () => Promise<void>) => { pendingSave.current = fn; },
    };
    void buildConfigPanes(ctx).then(setPanes);
  }, [open, project?.directory]);

  const handleSave = useCallback(async () => {
    if (!pendingSave.current) return;
    setSaving(true);
    try {
      await pendingSave.current();
      setDirty(false);
      onClose();
    } finally {
      setSaving(false);
    }
  }, [onClose]);

  if (!project) {
    return open ? <GlobalSettingsModal onClose={onClose} /> : null;
  }

  return (
    <ProjectConfigModal
      open={open}
      title={project.name}
      subtitle="Configure models, providers, and automation"
      panes={panes}
      onClose={onClose}
      onSave={handleSave}
      saving={saving}
      dirty={dirty}
    />
  );
}

/** Polling interval when Docker is connected (ms) */
const STACK_POLL_INTERVAL = 3000;
/** Polling interval when Docker is disconnected (ms) */
const STACK_POLL_INTERVAL_DISCONNECTED = 10_000;
/** Metrics polling interval (ms) */
const METRICS_POLL_INTERVAL = 15_000;
/** Throttle for activity reporting (ms) */
const ACTIVITY_REPORT_THROTTLE = 10_000;

export default function App() {
  const {
    selectedStackId,
    mainView,
    showRefineTicketDialog,
    showCreateTicketDialog,
    showEditTicketDialog,
    showStartTicketDialog,
    showCreatePRDialog,
    showOpenProjectDialog,
    showModelSettings,
    setShowModelSettings,
    dockerConnected,
    refreshStacks,
    refreshProjects,
    refreshMetrics,
    refreshSessionState,
    fetchTelemetry,
    selectStack,
    setDockerConnected,
    sessionMonitorState,
    sessionWarningLevel,
    showSessionWarningModal,
    setShowSessionWarningModal,
    upsertRefinementSession,
    appendRefinementStreamChunk,
    error,
  } = useAppStore();

  // Check Docker status on mount and listen for connection events
  useEffect(() => {
    window.sandstorm.docker.status().then(({ connected }) => {
      setDockerConnected(connected);
    }).catch(() => {});

    const unsubConnected = window.sandstorm.on(EVENT_CHANNELS.DOCKER_CONNECTED, () => {
      setDockerConnected(true);
      refreshStacks();
      refreshMetrics();
    });
    const unsubDisconnected = window.sandstorm.on(EVENT_CHANNELS.DOCKER_DISCONNECTED, () => {
      setDockerConnected(false);
    });

    return () => {
      unsubConnected();
      unsubDisconnected();
    };
  }, [setDockerConnected, refreshStacks, refreshMetrics]);

  // Report user activity to session monitor for idle gating
  useEffect(() => {
    let lastReport = 0;
    const report = () => {
      const now = Date.now();
      if (now - lastReport > ACTIVITY_REPORT_THROTTLE) {
        lastReport = now;
        window.sandstorm.session.reportActivity();
      }
    };
    window.addEventListener('mousedown', report);
    window.addEventListener('keydown', report);
    window.addEventListener('scroll', report, true);
    window.addEventListener('focus', report);
    return () => {
      window.removeEventListener('mousedown', report);
      window.removeEventListener('keydown', report);
      window.removeEventListener('scroll', report, true);
      window.removeEventListener('focus', report);
    };
  }, []);

  // Close create-ticket and edit-ticket dialogs on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const state = useAppStore.getState();
      if (state.showCreateTicketDialog) state.setShowCreateTicketDialog(false);
      if (state.showEditTicketDialog) state.setShowEditTicketDialog(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Refinement sessions: restore persisted sessions and listen for updates
  useEffect(() => {
    window.sandstorm.tickets.listRefinements().then((sessions) => {
      sessions.forEach((s) => upsertRefinementSession(s, { replay: true }));
    }).catch(() => {});

    const unsubRefinement = window.sandstorm.on(EVENT_CHANNELS.REFINEMENT_UPDATE, (data: unknown) => {
      upsertRefinementSession(data as Parameters<typeof upsertRefinementSession>[0]);
    });

    const unsubProgress = window.sandstorm.on(EVENT_CHANNELS.REFINEMENT_PROGRESS, (data: unknown) => {
      const { sessionId, delta } = data as { sessionId: string; delta: string };
      appendRefinementStreamChunk(sessionId, delta);
    });

    return () => {
      unsubRefinement();
      unsubProgress();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Session monitor
  useEffect(() => {
    refreshSessionState();

    const unsubThreshold = window.sandstorm.on(EVENT_CHANNELS.SESSION_THRESHOLD, (data: unknown) => {
      const { level } = data as { level: ThresholdLevel; usage: unknown };
      useAppStore.setState({ sessionWarningLevel: level });
      if (level === 'critical' || level === 'limit' || level === 'over_limit') {
        useAppStore.setState({ showSessionWarningModal: true });
      }
      refreshSessionState();
    });

    const unsubHalted = window.sandstorm.on(EVENT_CHANNELS.SESSION_HALTED, () => {
      refreshSessionState();
      refreshStacks();
    });

    const unsubReset = window.sandstorm.on(EVENT_CHANNELS.SESSION_RESET, () => {
      useAppStore.setState({ sessionWarningLevel: null, showSessionWarningModal: false });
      refreshSessionState();
      refreshStacks();
    });

    const unsubState = window.sandstorm.on(EVENT_CHANNELS.SESSION_STATE, () => {
      refreshSessionState();
    });

    const unsubCronHealth = window.sandstorm.on(EVENT_CHANNELS.SCHEDULER_CRON_HEALTH, (data: unknown) => {
      const { running } = data as { running: boolean };
      useAppStore.setState({ cronHealthy: running });
    });

    return () => {
      unsubThreshold();
      unsubHalted();
      unsubReset();
      unsubState();
      unsubCronHealth();
    };
  }, [refreshSessionState, refreshStacks]);

  useEffect(() => {
    refreshProjects();
    refreshStacks();
    refreshMetrics();
    void fetchTelemetry();

    const pollInterval = dockerConnected
      ? STACK_POLL_INTERVAL
      : STACK_POLL_INTERVAL_DISCONNECTED;
    const interval = setInterval(refreshStacks, pollInterval);
    const metricsInterval = dockerConnected
      ? setInterval(refreshMetrics, METRICS_POLL_INTERVAL)
      : null;

    const unsubCompleted = window.sandstorm.on(EVENT_CHANNELS.TASK_COMPLETED, () => {
      refreshStacks();
    });
    const unsubFailed = window.sandstorm.on(EVENT_CHANNELS.TASK_FAILED, () => {
      refreshStacks();
    });
    const unsubNavigate = window.sandstorm.on(
      EVENT_CHANNELS.NAVIGATE_STACK,
      (stackId: unknown) => {
        selectStack(stackId as string);
      }
    );
    const unsubStacksUpdated = window.sandstorm.on(EVENT_CHANNELS.STACKS_UPDATED, () => {
      refreshStacks();
      const state = useAppStore.getState();
      const project = state.activeProject();
      if (project) {
        void state.refreshBoardTickets(project.directory);
      }
    });

    return () => {
      clearInterval(interval);
      if (metricsInterval) clearInterval(metricsInterval);
      unsubCompleted();
      unsubFailed();
      unsubNavigate();
      unsubStacksUpdated();
    };
  }, [dockerConnected, refreshStacks, refreshProjects, refreshMetrics, selectStack, fetchTelemetry]);

  return (
    <div className="h-screen flex flex-col bg-sandstorm-bg text-sandstorm-text">
      {/* Docker disconnected banner */}
      {!dockerConnected && (
        <div className="bg-yellow-500/10 border-b border-yellow-500/20 px-4 py-2 text-sm text-yellow-400 flex items-center gap-2 shrink-0 animate-fade-in">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0">
            <path d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Docker is unavailable — waiting for reconnection. Stack data may be stale.
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="bg-red-500/10 border-b border-red-500/20 px-4 py-2 text-sm text-red-400 flex items-center gap-2 shrink-0 animate-fade-in">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
            <path d="M12 8v4m0 4h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          {error}
        </div>
      )}

      {/* Top nav */}
      <TopNav />

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedStackId ? (
          <StackDetail
            stackId={selectedStackId}
            onBack={() => selectStack(null)}
          />
        ) : mainView === 'telemetry' ? (
          <TelemetryView />
        ) : (
          <KanbanBoard />
        )}
      </div>

      {/* Session warning banner (non-blocking) */}
      {sessionWarningLevel === 'warning' && sessionMonitorState?.usage && (
        <div className="bg-amber-500/10 border-t border-amber-500/20 px-4 py-2 text-sm text-amber-400 flex items-center gap-2 shrink-0 animate-fade-in" data-testid="session-warning-banner">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            <line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          You've used {Math.round(sessionMonitorState.usage.session?.percent ?? 0)}% of your session token limit. Consider pausing non-critical stacks.
        </div>
      )}

      {/* Dialogs */}
      {showRefineTicketDialog && <RefineTicketDialog />}
      {showCreateTicketDialog && <CreateTicketDialog />}
      {showEditTicketDialog && <EditTicketDialog />}
      {showStartTicketDialog && <StartTicketDialog />}
      {showCreatePRDialog && <CreatePRDialog stackId={showCreatePRDialog.stackId} initialError={showCreatePRDialog.initialError} />}
      {showOpenProjectDialog && <OpenProjectDialog />}
      <ProjectConfigModalMount
        open={showModelSettings}
        onClose={() => setShowModelSettings(false)}
      />

      {/* Stale workspaces modal — shown on app start when stale workspaces exist */}
      <StaleWorkspaces />

      {/* Session warning modal (blocking) */}
      {showSessionWarningModal && sessionWarningLevel && sessionWarningLevel !== 'warning' && sessionWarningLevel !== 'normal' && (
        <SessionWarningModal
          level={sessionWarningLevel}
          usage={sessionMonitorState?.usage ?? null}
          onClose={() => setShowSessionWarningModal(false)}
        />
      )}

      <SessionTokenLimitModal />
    </div>
  );
}
