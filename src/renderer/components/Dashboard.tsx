import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  useAppStore,
  StackHistoryRecord,
  GlobalTokenUsage,
  Task,
  outerClaudeTotal,
  OUTER_CLAUDE_BLOCK_THRESHOLD,
} from '../store';
import { StackCard } from './StackCard';
import { StackTableRow } from './StackTableRow';
import { TicketView } from './TicketView';
import { UninitializedProject } from './UninitializedProject';
import { MigrationModal } from './MigrationModal';
import { ComposeSetupModal } from './ComposeSetupModal';
import { AgentSession } from './AgentSession';
import { AuthIndicator } from './AuthIndicator';
import { ProjectContext } from './ProjectContext';
import { ModelSettingsModal } from './ModelSettings';
import { OrchestratorOverLimitModal } from './OrchestratorOverLimitModal';
import { ResizableTableHeader } from './ResizableTableHeader';
import { StaleWorkspaces } from './StaleWorkspaces';
import { useResizableColumns, ColumnDef } from '../hooks/useResizableColumns';
import { formatTokenCount } from '../utils/format';

const TABLE_COLUMNS: (ColumnDef & { label: string; align?: 'left' | 'right' })[] = [
  { key: 'status', label: 'Status', minWidth: 60, defaultWidth: 90 },
  { key: 'name', label: 'Name', minWidth: 80, defaultWidth: 140 },
  { key: 'description', label: 'Description', minWidth: 80, defaultWidth: 200 },
  { key: 'model', label: 'Model', minWidth: 50, defaultWidth: 70 },
  { key: 'services', label: 'Services', minWidth: 60, defaultWidth: 100 },
  { key: 'resources', label: 'Resources', minWidth: 60, defaultWidth: 120 },
  { key: 'duration', label: 'Duration', minWidth: 50, defaultWidth: 80 },
  { key: 'actions', label: '', minWidth: 40, defaultWidth: 60, align: 'right' as const },
];

type DashboardTab = 'active' | 'history';

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hrs}h ${remainMins}m` : `${hrs}h`;
}

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr + (dateStr.endsWith('Z') ? '' : 'Z'));
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

const HISTORY_STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  completed: { bg: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-400', label: 'Completed' },
  failed: { bg: 'bg-red-500/10 border-red-500/20', text: 'text-red-400', label: 'Failed' },
  torn_down: { bg: 'bg-gray-500/10 border-gray-500/20', text: 'text-gray-400', label: 'Torn Down' },
};

function TaskMetadataSection({ task }: { task: Task }) {
  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const toggle = (section: string) => setExpandedSection(expandedSection === section ? null : section);

  const reviewVerdicts: string[] = task.review_verdicts ? JSON.parse(task.review_verdicts) : [];
  const verifyOutputs: string[] = task.verify_outputs ? JSON.parse(task.verify_outputs) : [];
  const totalTokens = task.input_tokens + task.output_tokens;

  const TASK_STATUS_BADGE: Record<string, { text: string; label: string }> = {
    completed: { text: 'text-emerald-400', label: 'Completed' },
    failed: { text: 'text-red-400', label: 'Failed' },
    interrupted: { text: 'text-amber-400', label: 'Interrupted' },
    running: { text: 'text-blue-400', label: 'Running' },
  };
  const statusBadge = TASK_STATUS_BADGE[task.status] ?? { text: 'text-gray-400', label: task.status };

  return (
    <div className="mt-2 space-y-1.5 text-xs" data-testid="task-metadata">
      <div className="flex items-center gap-3 flex-wrap text-sandstorm-muted">
        <span className={`font-medium ${statusBadge.text}`}>{statusBadge.label}</span>
        {task.exit_code !== null && <span>Exit: {task.exit_code}</span>}
        {task.review_iterations > 0 && <span>Reviews: {task.review_iterations}</span>}
        {task.verify_retries > 0 && <span>Verify retries: {task.verify_retries}</span>}
        {totalTokens > 0 && (
          <span title={`Exec: ${(task.execution_input_tokens + task.execution_output_tokens).toLocaleString()} / Review: ${(task.review_input_tokens + task.review_output_tokens).toLocaleString()}`}>
            Tokens: {totalTokens.toLocaleString()}
          </span>
        )}
      </div>

      {/* Phase timing */}
      {task.execution_started_at && (
        <div className="flex items-center gap-3 flex-wrap text-[10px] text-sandstorm-muted/70">
          {task.execution_started_at && task.execution_finished_at && (
            <span>Exec: {formatPhaseDuration(task.execution_started_at, task.execution_finished_at)}</span>
          )}
          {task.review_started_at && task.review_finished_at && (
            <span>Review: {formatPhaseDuration(task.review_started_at, task.review_finished_at)}</span>
          )}
          {task.verify_started_at && task.verify_finished_at && (
            <span>Verify: {formatPhaseDuration(task.verify_started_at, task.verify_finished_at)}</span>
          )}
        </div>
      )}

      {/* Expandable sections */}
      {task.execution_summary && (
        <ExpandableSection
          title="Execution Summary"
          content={task.execution_summary}
          expanded={expandedSection === 'summary'}
          onToggle={() => toggle('summary')}
        />
      )}

      {reviewVerdicts.length > 0 && (
        <ExpandableSection
          title={`Review Verdicts (${reviewVerdicts.length})`}
          content={reviewVerdicts.map((v, i) => `--- Iteration ${i + 1} ---\n${v}`).join('\n\n')}
          expanded={expandedSection === 'verdicts'}
          onToggle={() => toggle('verdicts')}
        />
      )}

      {verifyOutputs.length > 0 && (
        <ExpandableSection
          title={`Verify Outputs (${verifyOutputs.length})`}
          content={verifyOutputs.map((v, i) => `--- Attempt ${i + 1} ---\n${v}`).join('\n\n')}
          expanded={expandedSection === 'verify'}
          onToggle={() => toggle('verify')}
        />
      )}
    </div>
  );
}

function formatPhaseDuration(start: string, end: string): string {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const seconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  return formatDuration(seconds);
}

function ExpandableSection({ title, content, expanded, onToggle }: {
  title: string; content: string; expanded: boolean; onToggle: () => void;
}) {
  return (
    <div className="border border-sandstorm-border rounded-md overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-sandstorm-text-secondary hover:bg-sandstorm-surface-hover transition-colors"
        data-testid={`expand-${title.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>
          <path d="M9 18l6-6-6-6"/>
        </svg>
        {title}
      </button>
      {expanded && (
        <pre className="px-2 py-1.5 text-[10px] text-sandstorm-muted bg-sandstorm-bg max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-sandstorm-border">
          {content}
        </pre>
      )}
    </div>
  );
}

function HistoryWorkflowPhases({ task }: { task: Task }) {
  type PhaseStatus = 'passed' | 'failed' | 'pending';
  let execStatus: PhaseStatus = 'pending';
  let reviewStatus: PhaseStatus = 'pending';
  let verifyStatus: PhaseStatus = 'pending';

  if (task.status === 'completed') {
    execStatus = 'passed';
    reviewStatus = 'passed';
    verifyStatus = 'passed';
  } else if (task.status === 'failed') {
    if (task.verify_started_at) {
      execStatus = 'passed';
      reviewStatus = 'passed';
      verifyStatus = 'failed';
    } else if (task.review_started_at) {
      execStatus = 'passed';
      reviewStatus = 'failed';
    } else {
      execStatus = 'failed';
    }
  } else {
    // interrupted or other status
    if (task.execution_started_at) execStatus = 'passed';
    if (task.review_started_at) reviewStatus = 'passed';
    if (task.verify_started_at) verifyStatus = 'passed';
  }

  const phaseColor = (status: PhaseStatus) =>
    status === 'passed' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
    : status === 'failed' ? 'text-red-400 border-red-500/30 bg-red-500/10'
    : 'text-sandstorm-muted border-sandstorm-border bg-sandstorm-bg';

  const phaseIcon = (status: PhaseStatus) =>
    status === 'passed' ? '\u2713' : status === 'failed' ? '\u2717' : '\u2014';

  return (
    <div className="flex items-center gap-1.5 text-[10px]" data-testid="history-workflow-phases">
      {[
        { label: 'Exec', status: execStatus },
        { label: 'Review', status: reviewStatus },
        { label: 'Verify', status: verifyStatus },
      ].map(({ label, status }, i) => (
        <React.Fragment key={label}>
          {i > 0 && <span className="text-sandstorm-muted/40">&rarr;</span>}
          <span className={`px-1.5 py-0.5 rounded border font-medium ${phaseColor(status)}`}>
            {label} {phaseIcon(status)}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

function HistoryCard({ record, showProject }: { record: StackHistoryRecord; showProject?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const badge = HISTORY_STATUS_BADGE[record.final_status] ?? HISTORY_STATUS_BADGE.torn_down;

  // Parse task_history JSON blob
  const tasks: Task[] = useMemo(() => {
    if (!record.task_history) return [];
    try { return JSON.parse(record.task_history); } catch { return []; }
  }, [record.task_history]);

  return (
    <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl p-4 opacity-80 hover:opacity-100 transition-all duration-150">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full shrink-0 ${
              record.final_status === 'completed' ? 'bg-emerald-400' :
              record.final_status === 'failed' ? 'bg-red-400' : 'bg-gray-500'
            }`} />
            {showProject && (
              <span className="text-[13px] text-sandstorm-muted truncate">{record.project} /</span>
            )}
            <span className="font-semibold text-[15px] text-sandstorm-text truncate">{record.stack_id}</span>
            <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${badge.bg} ${badge.text}`}>
              {badge.label}
            </span>
            <span className="text-[11px] text-sandstorm-muted ml-auto shrink-0">
              {formatRelativeDate(record.finished_at)}
            </span>
          </div>

          {(record.ticket || record.branch) && (
            <div className="mt-2 ml-5 flex items-center gap-1.5 text-xs text-sandstorm-muted">
              {record.ticket && (
                <span className="bg-sandstorm-bg px-2 py-0.5 rounded-md font-mono text-[11px] border border-sandstorm-border">
                  {record.ticket}
                </span>
              )}
              {record.branch && (
                <span className="bg-sandstorm-bg px-2 py-0.5 rounded-md font-mono text-[11px] border border-sandstorm-border flex items-center gap-1">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="opacity-60">
                    <path d="M6 3v12M18 9a3 3 0 01-3 3H9M18 9a3 3 0 10-3-3"/>
                  </svg>
                  {record.branch}
                </span>
              )}
            </div>
          )}

          {record.description && (
            <div className="mt-1.5 ml-5 text-xs text-sandstorm-text-secondary truncate">
              {record.description}
            </div>
          )}

          {record.task_prompt && (
            <div
              className={`mt-1.5 ml-5 text-xs text-sandstorm-muted cursor-pointer ${expanded ? '' : 'truncate'}`}
              title={expanded ? undefined : record.task_prompt}
              onClick={() => setExpanded(!expanded)}
              data-testid="task-prompt"
            >
              Task: {record.task_prompt}
            </div>
          )}

          {record.error && record.final_status === 'failed' && (
            <div className="mt-2 ml-5 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-2.5 py-1.5 truncate" title={record.error}>
              {record.error}
            </div>
          )}

          <div className="mt-2 ml-5 flex items-center gap-3 text-[11px] text-sandstorm-muted">
            <span>Duration: {formatDuration(record.duration_seconds)}</span>
            <span>Started: {new Date(record.created_at + (record.created_at.endsWith('Z') ? '' : 'Z')).toLocaleString()}</span>
          </div>

          {/* Workflow phases for the most recent task */}
          {tasks.length > 0 && (
            <div className="mt-2 ml-5">
              <HistoryWorkflowPhases task={tasks[0]} />
            </div>
          )}

          {/* Task metadata from archived tasks */}
          {tasks.length > 0 && (
            <div className="mt-3 ml-5 space-y-2">
              {tasks.map((task) => (
                <TaskMetadataSection key={task.id} task={task} />
              ))}
            </div>
          )}

          {/* No metadata available for pre-existing stacks */}
          {!record.task_history && record.task_prompt && (
            <div className="mt-2 ml-5 text-[10px] text-sandstorm-muted/50 italic">
              No detailed metadata available
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TokenUsageSummary({ usage }: { usage: GlobalTokenUsage }) {
  if (usage.total_tokens === 0) return null;

  return (
    <div className="flex items-center gap-3 text-[11px] text-sandstorm-muted" data-testid="token-usage-summary">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
      </svg>
      <span className="tabular-nums" title={`Input: ${usage.total_input_tokens.toLocaleString()} / Output: ${usage.total_output_tokens.toLocaleString()}`}>
        {formatTokenCount(usage.total_tokens)} tokens
      </span>
      <span className="text-sandstorm-muted/50">
        ({formatTokenCount(usage.total_input_tokens)} in / {formatTokenCount(usage.total_output_tokens)} out)
      </span>
    </div>
  );
}

export function Dashboard() {
  const { setShowNewStackDialog, setShowRefineTicketDialog, setShowModelSettings, showModelSettings, filteredStacks, filteredStackHistory, activeProject, globalTokenUsage } = useAppStore();
  const stacks = filteredStacks();
  const history = filteredStackHistory();
  const project = activeProject();

  // Orchestrator session tokens for the currently visible tab — used to block
  // "New Stack" when the session exceeds the hard limit (issue #238).
  const claudeTabId = project ? `project-${project.id}` : 'all';
  const orchestratorTokens = useAppStore((s) => s.outerClaudeTokens[claudeTabId]);
  const orchestratorTotal = outerClaudeTotal(orchestratorTokens);
  const [showOverLimitModal, setShowOverLimitModal] = useState(false);

  const handleNewStackClick = useCallback(() => {
    if (orchestratorTotal >= OUTER_CLAUDE_BLOCK_THRESHOLD) {
      setShowOverLimitModal(true);
      return;
    }
    setShowNewStackDialog(true);
  }, [orchestratorTotal, setShowNewStackDialog]);

  const [dashboardTab, setDashboardTab] = useState<DashboardTab>('active');
  const [projectInitState, setProjectInitState] = useState<'uninitialized' | 'partial' | 'full' | null>(null);
  const [migrationState, setMigrationState] = useState<{
    needsMigration: boolean;
    missingVerifyScript: boolean;
    missingServiceLabels: boolean;
    missingSpecQualityGate: boolean;
    missingReviewPrompt: boolean;
    legacyPortMappings: boolean;
  } | null>(null);
  const [showMigrationModal, setShowMigrationModal] = useState(false);
  const [showComposeSetup, setShowComposeSetup] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [viewMode, _setViewMode] = useState<'cards' | 'table'>(() => {
    const saved = localStorage.getItem('sandstorm-view-mode');
    return saved === 'table' ? 'table' : 'cards';
  });
  const setViewMode = (mode: 'cards' | 'table') => {
    localStorage.setItem('sandstorm-view-mode', mode);
    _setViewMode(mode);
  };
  const [dashboardView, _setDashboardView] = useState<'stacks' | 'tickets'>(() => {
    const saved = localStorage.getItem('sandstorm-dashboard-view');
    return saved === 'tickets' ? 'tickets' : 'stacks';
  });
  const setDashboardView = (view: 'stacks' | 'tickets') => {
    localStorage.setItem('sandstorm-dashboard-view', view);
    _setDashboardView(view);
  };
  const [leftWidth, setLeftWidth] = useState(55); // percentage
  const dragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { columnWidths, startResize } = useResizableColumns('stack-table', TABLE_COLUMNS);

  useEffect(() => {
    if (!project) {
      setProjectInitState(null);
      setMigrationState(null);
      return;
    }
    let cancelled = false;
    window.sandstorm.projects.checkInit(project.directory).then((result) => {
      if (cancelled) return;
      setProjectInitState(result.state);

      // Partially initialized — show compose setup modal
      if (result.state === 'partial') {
        setShowComposeSetup(true);
        return;
      }

      // Fully initialized — check if migration is needed
      if (result.state === 'full') {
        window.sandstorm.projects.checkMigration(project.directory).then((migration) => {
          if (!cancelled) {
            setMigrationState(migration.needsMigration ? {
              needsMigration: true,
              missingVerifyScript: migration.missingVerifyScript ?? false,
              missingServiceLabels: migration.missingServiceLabels ?? false,
              missingSpecQualityGate: migration.missingSpecQualityGate ?? false,
              missingReviewPrompt: migration.missingReviewPrompt ?? false,
              legacyPortMappings: migration.legacyPortMappings ?? false,
            } : null);
            if (migration.needsMigration) {
              setShowMigrationModal(true);
            }
          }
        });
      }
    });
    return () => { cancelled = true; };
  }, [project]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftWidth(Math.min(80, Math.max(20, pct)));
    };
    const handleMouseUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      // Clean up body styles if component unmounts mid-drag
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
  }, []);

  // If we have a selected project that isn't initialized, show that state
  if (project && projectInitState === 'uninitialized') {
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-6 py-5 border-b border-sandstorm-border shrink-0">
          <div>
            <h1 className="text-lg font-semibold text-sandstorm-text tracking-tight">{project.name}</h1>
            <p className="text-xs text-sandstorm-muted mt-0.5 font-mono">{project.directory}</p>
          </div>
        </div>
        <div className="flex-1">
          <UninitializedProject project={project} />
        </div>
      </div>
    );
  }

  const runningCount = stacks.filter((s) => s.status === 'running' || s.status === 'up').length;
  const completedCount = stacks.filter((s) => s.status === 'completed' || s.status === 'pushed' || s.status === 'pr_created').length;
  const stoppedCount = stacks.filter((s) => s.status === 'stopped').length;

  const title = project ? project.name : 'All Stacks';
  const subtitle = project
    ? `${stacks.length} stack${stacks.length === 1 ? '' : 's'}`
    : stacks.length === 0
      ? 'No stacks running'
      : `${stacks.length} stack${stacks.length === 1 ? '' : 's'}`;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-sandstorm-border shrink-0">
        <div>
          <h1 className="text-lg font-semibold text-sandstorm-text tracking-tight">{title}</h1>
          <p className="text-xs text-sandstorm-muted mt-0.5">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowModelSettings(true)}
            className="flex items-center gap-1.5 px-3 py-2 bg-sandstorm-surface-hover hover:bg-sandstorm-border text-sandstorm-text-secondary rounded-lg transition-all text-sm font-medium active:scale-[0.98]"
            data-testid="model-settings-btn"
            title="Model settings"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
          {project && (
            <button
              onClick={() => setShowContext(true)}
              className="flex items-center gap-1.5 px-3 py-2 bg-sandstorm-surface-hover hover:bg-sandstorm-border text-sandstorm-text-secondary rounded-lg transition-all text-sm font-medium active:scale-[0.98]"
              data-testid="context-btn"
              title="Custom context for this project"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
              Context
            </button>
          )}
          {project && (
            <button
              onClick={() => setShowRefineTicketDialog(true)}
              className="flex items-center gap-1.5 px-3 py-2 bg-sandstorm-surface-hover hover:bg-sandstorm-border text-sandstorm-text-secondary rounded-lg transition-all text-sm font-medium active:scale-[0.98]"
              data-testid="refine-ticket-btn"
              title="Run the spec gate on a ticket and start a stack"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 11l3 3L22 4"/>
                <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
              </svg>
              Refine Ticket
            </button>
          )}
          <button
            onClick={handleNewStackClick}
            className="flex items-center gap-1.5 px-4 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white rounded-lg transition-all text-sm font-medium shadow-glow hover:shadow-lg active:scale-[0.98]"
            data-testid="new-stack-btn"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            New Stack
          </button>
        </div>
      </div>

      {/* Two-column layout: Claude chat (left) + Stacks (right) */}
      <div className="flex-1 flex min-h-0" ref={containerRef}>
        {/* Left column — Claude orchestration chat */}
        <div className="shrink-0 border-r border-sandstorm-border" style={{ width: `${leftWidth}%` }}>
          <AgentSession key={claudeTabId} tabId={claudeTabId} projectDir={project?.directory} />
        </div>

        {/* Draggable divider */}
        <div
          className="w-1 shrink-0 cursor-col-resize hover:bg-sandstorm-accent/30 active:bg-sandstorm-accent/50 transition-colors relative group"
          onMouseDown={handleMouseDown}
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
        </div>

        {/* Right column — Stacks panel */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          <div className="flex items-center gap-3 px-4 border-b border-sandstorm-border shrink-0 h-10">
            {/* Active / History tabs */}
            <div className="flex gap-0.5">
              <button
                onClick={() => setDashboardTab('active')}
                className={`flex items-center gap-1.5 px-2 py-2 text-xs font-medium border-b-2 transition-colors ${
                  dashboardTab === 'active'
                    ? 'border-sandstorm-accent text-sandstorm-text'
                    : 'border-transparent text-sandstorm-muted hover:text-sandstorm-text-secondary'
                }`}
                data-testid="tab-active"
              >
                Active
                {stacks.length > 0 && (
                  <span className="ml-1 text-[10px] bg-sandstorm-accent/10 text-sandstorm-accent px-1.5 py-0.5 rounded-full">
                    {stacks.length}
                  </span>
                )}
              </button>
              <button
                onClick={() => setDashboardTab('history')}
                className={`flex items-center gap-1.5 px-2 py-2 text-xs font-medium border-b-2 transition-colors ${
                  dashboardTab === 'history'
                    ? 'border-sandstorm-accent text-sandstorm-text'
                    : 'border-transparent text-sandstorm-muted hover:text-sandstorm-text-secondary'
                }`}
                data-testid="tab-history"
              >
                History
                {history.length > 0 && (
                  <span className="ml-1 text-[10px] bg-sandstorm-surface text-sandstorm-muted px-1.5 py-0.5 rounded-full border border-sandstorm-border">
                    {history.length}
                  </span>
                )}
              </button>
            </div>

            {runningCount > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                {runningCount} active
              </span>
            )}
            {completedCount > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-sandstorm-accent">
                <span className="w-1.5 h-1.5 rounded-full bg-sandstorm-accent" />
                {completedCount} review
              </span>
            )}
            {globalTokenUsage && <TokenUsageSummary usage={globalTokenUsage} />}
            {dashboardTab === 'active' && (
              <div className="ml-auto flex items-center gap-2">
                {/* Stack View / Ticket View toggle */}
                <div className="flex items-center gap-0.5 bg-sandstorm-bg rounded-md p-0.5 border border-sandstorm-border">
                  <button
                    onClick={() => setDashboardView('stacks')}
                    className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${dashboardView === 'stacks' ? 'bg-sandstorm-surface text-sandstorm-text shadow-sm' : 'text-sandstorm-muted hover:text-sandstorm-text-secondary'}`}
                    title="Stack view"
                    data-testid="view-stacks"
                  >
                    Stacks
                  </button>
                  <button
                    onClick={() => setDashboardView('tickets')}
                    className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${dashboardView === 'tickets' ? 'bg-sandstorm-surface text-sandstorm-text shadow-sm' : 'text-sandstorm-muted hover:text-sandstorm-text-secondary'}`}
                    title="Ticket view"
                    data-testid="view-tickets"
                  >
                    Tickets
                  </button>
                </div>

                {/* Card / Table toggle (only in stack view) */}
                {dashboardView === 'stacks' && (
                  <div className="flex items-center gap-0.5 bg-sandstorm-bg rounded-md p-0.5 border border-sandstorm-border">
                    <button
                      onClick={() => setViewMode('cards')}
                      className={`p-1 rounded transition-colors ${viewMode === 'cards' ? 'bg-sandstorm-surface text-sandstorm-text shadow-sm' : 'text-sandstorm-muted hover:text-sandstorm-text-secondary'}`}
                      title="Card view"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="7" height="7" rx="1" />
                        <rect x="14" y="3" width="7" height="7" rx="1" />
                        <rect x="3" y="14" width="7" height="7" rx="1" />
                        <rect x="14" y="14" width="7" height="7" rx="1" />
                      </svg>
                    </button>
                    <button
                      onClick={() => setViewMode('table')}
                      className={`p-1 rounded transition-colors ${viewMode === 'table' ? 'bg-sandstorm-surface text-sandstorm-text shadow-sm' : 'text-sandstorm-muted hover:text-sandstorm-text-secondary'}`}
                      title="Table view"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="3" y1="6" x2="21" y2="6" />
                        <line x1="3" y1="12" x2="21" y2="12" />
                        <line x1="3" y1="18" x2="21" y2="18" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          {dashboardTab === 'active' && <StaleWorkspaces />}
          {/* Partial init banner */}
          {projectInitState === 'partial' && project && (
            <div className="mx-4 mt-2 mb-1 flex items-center justify-between bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2" data-testid="partial-init-banner">
              <span className="text-xs text-amber-400">
                Compose setup incomplete — stacks cannot spin up until configured.
              </span>
              <button
                onClick={() => setShowComposeSetup(true)}
                className="text-xs font-medium text-sandstorm-accent hover:text-sandstorm-accent-hover transition-colors ml-3 shrink-0"
                data-testid="compose-setup-btn"
              >
                Set Up
              </button>
            </div>
          )}
          <div className="flex-1 overflow-y-auto min-h-0">
          {dashboardTab === 'active' ? (
            stacks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-sandstorm-muted p-4">
                <div className="relative mb-6">
                  <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-sandstorm-surface to-sandstorm-bg border border-sandstorm-border flex items-center justify-center">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-sandstorm-muted">
                      <rect x="2" y="3" width="20" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                      <rect x="2" y="10" width="20" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                      <rect x="2" y="17" width="20" height="4" rx="1.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2"/>
                    </svg>
                  </div>
                  <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-lg bg-sandstorm-accent/10 border border-sandstorm-accent/20 flex items-center justify-center">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-sandstorm-accent">
                      <path d="M12 5v14M5 12h14"/>
                    </svg>
                  </div>
                </div>
                <p className="text-sm font-medium text-sandstorm-text-secondary mb-1">No stacks yet</p>
                <p className="text-xs text-sandstorm-muted mb-4">
                  Create your first stack to get started
                </p>
                <button
                  onClick={() => setShowNewStackDialog(true)}
                  className="text-xs font-medium text-sandstorm-accent hover:text-sandstorm-accent-hover transition-colors"
                >
                  Create a stack &rarr;
                </button>
              </div>
            ) : dashboardView === 'tickets' ? (
              <TicketView stacks={stacks} showProject={!project} />
            ) : viewMode === 'cards' ? (
              <div className="space-y-2 p-4">
                {stacks.map((stack) => (
                  <StackCard key={stack.id} stack={stack} showProject={!project} />
                ))}
              </div>
            ) : (
              <table className="w-full text-xs" style={{ tableLayout: 'fixed' }} data-testid="stack-table">
                <ResizableTableHeader
                  columns={TABLE_COLUMNS}
                  columnWidths={columnWidths}
                  onResizeStart={startResize}
                />
                <tbody>
                  {stacks.map((stack) => (
                    <StackTableRow key={stack.id} stack={stack} showProject={!project} columnWidths={columnWidths} />
                  ))}
                </tbody>
              </table>
            )
          ) : (
            history.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-sandstorm-muted p-4">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-4 opacity-50">
                  <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
                <p className="text-sm font-medium text-sandstorm-text-secondary mb-1">No history yet</p>
                <p className="text-xs text-sandstorm-muted">
                  Completed and torn-down stacks will appear here
                </p>
              </div>
            ) : (
              <div className="space-y-2 p-4">
                {history.map((record) => (
                  <HistoryCard key={record.id} record={record} showProject={!project} />
                ))}
              </div>
            )
          )}
          </div>
        </div>
      </div>

      {/* Model settings dialog */}
      {showModelSettings && <ModelSettingsModal />}

      {/* Custom context dialog */}
      {showContext && project && (
        <ProjectContext
          projectDir={project.directory}
          onClose={() => setShowContext(false)}
        />
      )}

      {/* Migration modal */}
      {showMigrationModal && project && migrationState && (
        <MigrationModal
          projectDir={project.directory}
          missingVerifyScript={migrationState.missingVerifyScript}
          missingServiceLabels={migrationState.missingServiceLabels}
          missingSpecQualityGate={migrationState.missingSpecQualityGate}
          missingReviewPrompt={migrationState.missingReviewPrompt}
          legacyPortMappings={migrationState.legacyPortMappings}
          onComplete={() => {
            setShowMigrationModal(false);
            setMigrationState(null);
          }}
          onDismiss={() => setShowMigrationModal(false)}
        />
      )}

      {/* Compose setup modal */}
      {showComposeSetup && project && (
        <ComposeSetupModal
          projectDir={project.directory}
          onComplete={() => {
            setShowComposeSetup(false);
            setProjectInitState('full');
            // Now check for migration needs
            window.sandstorm.projects.checkMigration(project.directory).then((migration) => {
              if (migration.needsMigration) {
                setMigrationState({
                  needsMigration: true,
                  missingVerifyScript: migration.missingVerifyScript ?? false,
                  missingServiceLabels: migration.missingServiceLabels ?? false,
                  missingSpecQualityGate: migration.missingSpecQualityGate ?? false,
                  missingReviewPrompt: migration.missingReviewPrompt ?? false,
                  legacyPortMappings: migration.legacyPortMappings ?? false,
                });
                setShowMigrationModal(true);
              }
            });
          }}
          onDismiss={() => setShowComposeSetup(false)}
        />
      )}

      {/* Orchestrator over-limit modal — blocks new stack creation at >=250K */}
      {showOverLimitModal && (
        <OrchestratorOverLimitModal onDismiss={() => setShowOverLimitModal(false)} />
      )}
    </div>
  );
}
