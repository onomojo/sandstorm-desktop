import React, { useState, useEffect, useCallback } from 'react';
import { useAppStore, Task, StackMetrics } from '../store';
import { ServiceList } from './ServiceList';
import { TaskOutput } from './TaskOutput';
import { DiffViewer } from './DiffViewer';
import { LogViewer } from './LogViewer';
import { formatTokenCount, formatBytes, formatMs } from '../utils/format';

type Tab = 'output' | 'diff' | 'logs' | 'history';

const TAB_CONFIG: { key: Tab; label: string; icon: string }[] = [
  { key: 'output', label: 'Claude Output', icon: 'M8 9h8M8 13h6' },
  { key: 'diff', label: 'Diff', icon: 'M12 3v18M3 12h18' },
  { key: 'logs', label: 'Logs', icon: 'M4 6h16M4 10h16M4 14h16M4 18h10' },
  { key: 'history', label: 'History', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
];

export function StackDetail({
  stackId,
  onBack,
}: {
  stackId: string;
  onBack: () => void;
}) {
  const { stacks, refreshStacks, stackMetrics } = useAppStore();
  const stack = stacks.find((s) => s.id === stackId);
  const metrics: StackMetrics | undefined = stackMetrics[stackId];

  const [activeTab, setActiveTab] = useState<Tab>('output');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [diff, setDiff] = useState('');
  const [selectedLogContainer, setSelectedLogContainer] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [taskModel, setTaskModel] = useState<string>('auto');

  const loadTasks = useCallback(async () => {
    const taskList = await window.sandstorm.tasks.list(stackId);
    setTasks(taskList);
  }, [stackId]);

  const loadDiff = useCallback(async () => {
    const diffContent = await window.sandstorm.diff.get(stackId);
    setDiff(diffContent);
  }, [stackId]);

  useEffect(() => {
    loadTasks();
    loadDiff();
  }, [loadTasks, loadDiff]);

  useEffect(() => {
    if (activeTab === 'history') loadTasks();
    if (activeTab === 'diff') loadDiff();
  }, [activeTab, loadTasks, loadDiff]);

  if (!stack) {
    return (
      <div className="p-6 animate-fade-in">
        <button onClick={onBack} className="text-sandstorm-muted hover:text-sandstorm-text transition-colors text-sm flex items-center gap-1">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
          Back
        </button>
        <p className="mt-4 text-sandstorm-muted text-sm">Stack not found</p>
      </div>
    );
  }

  const handleDispatch = async () => {
    if (!taskPrompt.trim()) return;
    setDispatching(true);
    try {
      await window.sandstorm.tasks.dispatch(stackId, taskPrompt, taskModel);
      setTaskPrompt('');
      setActiveTab('output');
      await refreshStacks();
      await loadTasks();
    } catch (err) {
      alert(`Failed to dispatch task: ${err}`);
    } finally {
      setDispatching(false);
    }
  };

  const handlePush = async () => {
    try {
      await window.sandstorm.push.execute(stackId);
      alert('Pushed successfully');
    } catch (err) {
      alert(`Push failed: ${err}`);
    }
  };

  const handleTeardown = async () => {
    if (!confirm(`Tear down stack "${stackId}"?`)) return;
    try {
      // Navigate back immediately — teardown deletes the stack from the
      // registry synchronously so the UI won't find it after refresh.
      onBack();
      await window.sandstorm.stacks.teardown(stackId);
      refreshStacks();
    } catch (err) {
      alert(`Teardown failed: ${err}`);
    }
  };

  const STATUS_DETAIL_LABELS: Record<string, string> = {
    completed: 'Needs Review',
    pushed: 'Pushed',
    pr_created: 'PR Open',
    rate_limited: 'Rate Limited',
  };
  const statusLabel = STATUS_DETAIL_LABELS[stack.status]
    ?? stack.status.charAt(0).toUpperCase() + stack.status.slice(1);

  const statusStyle =
    stack.status === 'completed'
      ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
      : stack.status === 'failed'
        ? 'bg-red-500/10 border-red-500/20 text-red-400'
        : stack.status === 'running'
          ? 'bg-blue-500/10 border-blue-500/20 text-blue-400'
          : stack.status === 'pushed' || stack.status === 'pr_created'
            ? 'bg-violet-500/10 border-violet-500/20 text-violet-400'
            : stack.status === 'rate_limited'
              ? 'bg-orange-500/10 border-orange-500/20 text-orange-400'
              : 'bg-gray-500/10 border-gray-500/20 text-gray-400';

  return (
    <div className="h-full flex flex-col animate-fade-in">
      {/* Header */}
      <div className="px-5 py-4 border-b border-sandstorm-border shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="text-sandstorm-muted hover:text-sandstorm-text transition-colors p-1 rounded-md hover:bg-sandstorm-surface-hover"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="text-base font-semibold text-sandstorm-text truncate">{stack.id}</h1>
              <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${statusStyle}`}>
                {statusLabel}
              </span>
            </div>
            <div className="text-[11px] text-sandstorm-muted mt-0.5 flex items-center gap-1.5">
              {stack.ticket && (
                <span className="bg-sandstorm-bg px-1.5 py-0.5 rounded font-mono border border-sandstorm-border">{stack.ticket}</span>
              )}
              {stack.branch && (
                <span className="bg-sandstorm-bg px-1.5 py-0.5 rounded font-mono border border-sandstorm-border">{stack.branch}</span>
              )}
              <span>{new Date(stack.created_at).toLocaleDateString()}</span>
            </div>
            {stack.status === 'failed' && stack.error && (
              <div className="mt-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                {stack.error}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Rate limit banner */}
      {stack.status === 'rate_limited' && (
        <div className="px-5 py-2 border-b border-orange-500/20 bg-orange-500/5 shrink-0 flex items-center gap-3 text-xs text-orange-400">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <span className="font-medium">Rate limit hit</span>
          {stack.rate_limit_reset_at && (
            <span>
              — auto-resumes at {new Date(stack.rate_limit_reset_at).toLocaleTimeString()}
            </span>
          )}
          {stack.error && <span className="text-orange-300/70 ml-auto truncate max-w-[300px]">{stack.error}</span>}
        </div>
      )}

      {/* Metrics bar */}
      {(metrics || stack.total_input_tokens > 0 || stack.total_output_tokens > 0) && (
        <div className="px-5 py-2 border-b border-sandstorm-border shrink-0 flex items-center gap-4 text-[11px]">
          {metrics && metrics.totalMemory > 0 && (
            <MetricBadge label="Memory" value={formatBytes(metrics.totalMemory)} />
          )}
          {metrics && metrics.containers.length > 0 && (
            <MetricBadge
              label="CPU"
              value={`${metrics.containers.reduce((s, c) => s + c.cpuPercent, 0).toFixed(1)}%`}
            />
          )}
          {metrics && metrics.taskMetrics.totalTasks > 0 && (
            <>
              <MetricBadge
                label="Tasks"
                value={`${metrics.taskMetrics.completedTasks}/${metrics.taskMetrics.totalTasks}`}
              />
              {metrics.taskMetrics.avgTaskDurationMs > 0 && (
                <MetricBadge
                  label="Avg Task"
                  value={formatMs(metrics.taskMetrics.avgTaskDurationMs)}
                />
              )}
            </>
          )}
          {stack.services.filter((s) => s.status === 'running').length > 0 && (
            <MetricBadge
              label="Running"
              value={`${stack.services.filter((s) => s.status === 'running').length}/${stack.services.length}`}
            />
          )}
          {(stack.total_input_tokens > 0 || stack.total_output_tokens > 0) && (
            <>
              <MetricBadge
                label="Input"
                value={formatTokenCount(stack.total_input_tokens)}
              />
              <MetricBadge
                label="Output"
                value={formatTokenCount(stack.total_output_tokens)}
              />
              <MetricBadge
                label="Total"
                value={formatTokenCount(stack.total_input_tokens + stack.total_output_tokens)}
              />
            </>
          )}
        </div>
      )}

      {/* Services panel */}
      <ServiceList
        services={stack.services}
        runtime={stack.runtime}
        stackId={stackId}
        onViewLogs={(containerId) => {
          setSelectedLogContainer(containerId);
          setActiveTab('logs');
        }}
      />

      {/* Tabs */}
      <div className="border-b border-sandstorm-border px-5 shrink-0">
        <div className="flex gap-0.5">
          {TAB_CONFIG.map(({ key, label, icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                activeTab === key
                  ? 'border-sandstorm-accent text-sandstorm-text'
                  : 'border-transparent text-sandstorm-muted hover:text-sandstorm-text-secondary'
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-70">
                <path d={icon}/>
              </svg>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'output' && (
          <TaskOutput
            stackId={stackId}
            runtime={stack.runtime}
            claudeContainerId={
              stack.services.find((s) => s.name === 'claude')?.containerId ?? null
            }
          />
        )}
        {activeTab === 'diff' && <DiffViewer diff={diff} />}
        {activeTab === 'logs' && (
          <LogViewer
            services={stack.services}
            runtime={stack.runtime}
            selectedContainerId={selectedLogContainer}
          />
        )}
        {activeTab === 'history' && (
          <div className="p-5 overflow-y-auto h-full">
            {tasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-sandstorm-muted">
                <p className="text-sm">No tasks dispatched yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className="bg-sandstorm-surface border border-sandstorm-border rounded-lg p-3 animate-fade-in"
                  >
                    <div className="flex items-center gap-2 text-xs">
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          task.status === 'completed'
                            ? 'bg-emerald-400'
                            : task.status === 'failed'
                              ? 'bg-red-400'
                              : 'bg-blue-400 animate-pulse'
                        }`}
                      />
                      <span className={
                        task.status === 'completed'
                          ? 'text-emerald-400'
                          : task.status === 'failed'
                            ? 'text-red-400'
                            : 'text-blue-400'
                      }>
                        {task.status === 'completed'
                          ? `Completed (exit ${task.exit_code})`
                          : task.status === 'failed'
                            ? `Failed (exit ${task.exit_code})`
                            : 'Running...'}
                      </span>
                      {task.model && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-sandstorm-bg border border-sandstorm-border text-sandstorm-muted">
                          {task.model}
                        </span>
                      )}
                      {task.status !== 'running' && (task.review_iterations > 0 || task.verify_retries > 0) && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-sandstorm-bg border border-sandstorm-border text-sandstorm-muted tabular-nums" title="Review iterations / Verify retries">
                          {task.review_iterations} review{task.review_iterations !== 1 ? 's' : ''}, {task.verify_retries} retr{task.verify_retries !== 1 ? 'ies' : 'y'}
                        </span>
                      )}
                      <span className="text-sandstorm-muted text-[10px] ml-auto tabular-nums">
                        {new Date(task.started_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs text-sandstorm-text-secondary leading-relaxed">
                      {task.prompt}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* New task input + action buttons */}
      <div className="border-t border-sandstorm-border px-5 py-3 shrink-0 bg-sandstorm-surface/50 backdrop-blur-sm">
        <div className="flex gap-2 items-end">
          <textarea
            value={taskPrompt}
            onChange={(e) => setTaskPrompt(e.target.value)}
            placeholder="Describe a task for inner Claude..."
            className="flex-1 bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-sm text-sandstorm-text placeholder-sandstorm-muted/50 resize-none focus:outline-none focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20 transition-all"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                handleDispatch();
              }
            }}
          />
          <div className="flex flex-col gap-1.5 shrink-0">
            <div className="flex gap-1">
              {(['auto', 'sonnet', 'opus'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setTaskModel(m)}
                  className={`px-2.5 py-1 text-[10px] font-medium rounded-md border transition-all ${
                    taskModel === m
                      ? 'border-sandstorm-accent bg-sandstorm-accent/10 text-sandstorm-accent'
                      : 'border-sandstorm-border bg-sandstorm-bg text-sandstorm-muted hover:border-sandstorm-border-light'
                  }`}
                  data-testid={`dispatch-model-${m}`}
                >
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
            <button
              onClick={handleDispatch}
              disabled={!taskPrompt.trim() || dispatching}
              className="px-4 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-sm font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-glow"
            >
              {dispatching ? 'Sending...' : 'Dispatch'}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5 mt-2">
          <span className="text-[10px] text-sandstorm-muted mr-1">
            <kbd className="px-1 py-0.5 rounded bg-sandstorm-bg border border-sandstorm-border text-[9px]">Ctrl</kbd>
            +
            <kbd className="px-1 py-0.5 rounded bg-sandstorm-bg border border-sandstorm-border text-[9px]">Enter</kbd>
          </span>
          <div className="w-px h-3 bg-sandstorm-border mx-1" />
          <FooterButton onClick={() => { loadDiff(); setActiveTab('diff'); }}>
            View Diff
          </FooterButton>
          <FooterButton onClick={handlePush}>
            Push
          </FooterButton>
          <FooterButton onClick={handleTeardown} danger>
            Tear Down
          </FooterButton>
        </div>
      </div>
    </div>
  );
}

function MetricBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5 bg-sandstorm-bg px-2 py-1 rounded-md border border-sandstorm-border">
      <span className="text-sandstorm-muted">{label}</span>
      <span className="text-sandstorm-text font-medium tabular-nums">{value}</span>
    </div>
  );
}

function FooterButton({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-[11px] font-medium px-2.5 py-1 rounded-md transition-all ${
        danger
          ? 'text-red-400 hover:bg-red-500/10'
          : 'text-sandstorm-muted hover:bg-sandstorm-bg hover:text-sandstorm-text-secondary'
      }`}
    >
      {children}
    </button>
  );
}
