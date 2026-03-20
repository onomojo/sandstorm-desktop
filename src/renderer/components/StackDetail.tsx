import React, { useState, useEffect, useCallback } from 'react';
import { useAppStore, Stack, Task } from '../store';
import { ServiceList } from './ServiceList';
import { TaskOutput } from './TaskOutput';
import { DiffViewer } from './DiffViewer';
import { LogViewer } from './LogViewer';

type Tab = 'output' | 'diff' | 'logs' | 'history';

export function StackDetail({
  stackId,
  onBack,
}: {
  stackId: string;
  onBack: () => void;
}) {
  const { stacks, refreshStacks } = useAppStore();
  const stack = stacks.find((s) => s.id === stackId);

  const [activeTab, setActiveTab] = useState<Tab>('output');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [diff, setDiff] = useState('');
  const [selectedLogContainer, setSelectedLogContainer] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);

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

  // Refresh tasks when tab changes
  useEffect(() => {
    if (activeTab === 'history') loadTasks();
    if (activeTab === 'diff') loadDiff();
  }, [activeTab, loadTasks, loadDiff]);

  if (!stack) {
    return (
      <div className="p-6">
        <button onClick={onBack} className="text-sandstorm-muted hover:text-sandstorm-text">
          &larr; Back
        </button>
        <p className="mt-4 text-sandstorm-muted">Stack not found</p>
      </div>
    );
  }

  const handleDispatch = async () => {
    if (!taskPrompt.trim()) return;
    setDispatching(true);
    try {
      await window.sandstorm.tasks.dispatch(stackId, taskPrompt);
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
      await window.sandstorm.stacks.teardown(stackId);
      await refreshStacks();
      onBack();
    } catch (err) {
      alert(`Teardown failed: ${err}`);
    }
  };

  const statusLabel =
    stack.status === 'completed'
      ? 'NEEDS REVIEW'
      : stack.status.toUpperCase();

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-sandstorm-border">
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="text-sandstorm-muted hover:text-sandstorm-text text-lg"
          >
            &larr;
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold">{stack.id}</h1>
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded ${
                  stack.status === 'completed'
                    ? 'bg-green-900/40 text-green-400'
                    : stack.status === 'failed'
                      ? 'bg-red-900/40 text-red-400'
                      : stack.status === 'running'
                        ? 'bg-blue-900/40 text-blue-400'
                        : 'bg-gray-800 text-gray-400'
                }`}
              >
                {statusLabel}
              </span>
            </div>
            <div className="text-sm text-sandstorm-muted mt-0.5">
              {stack.ticket && <span>{stack.ticket} &middot; </span>}
              {stack.branch && <span>{stack.branch} &middot; </span>}
              <span>created {new Date(stack.created_at).toLocaleString()}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Services panel */}
      <ServiceList
        services={stack.services}
        runtime={stack.runtime}
        onViewLogs={(containerId) => {
          setSelectedLogContainer(containerId);
          setActiveTab('logs');
        }}
      />

      {/* Tabs */}
      <div className="border-b border-sandstorm-border px-6">
        <div className="flex gap-1">
          {(['output', 'diff', 'logs', 'history'] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-sandstorm-accent text-sandstorm-text'
                  : 'border-transparent text-sandstorm-muted hover:text-sandstorm-text'
              }`}
            >
              {tab === 'output'
                ? 'Claude Output'
                : tab === 'diff'
                  ? 'Diff'
                  : tab === 'logs'
                    ? 'Logs'
                    : 'Task History'}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'output' && (
          <TaskOutput stackId={stackId} runtime={stack.runtime} services={stack.services} />
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
          <div className="p-4 overflow-y-auto h-full">
            {tasks.length === 0 ? (
              <p className="text-sandstorm-muted text-sm">No tasks dispatched yet</p>
            ) : (
              <div className="space-y-3">
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className="bg-sandstorm-bg border border-sandstorm-border rounded p-3"
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          task.status === 'completed'
                            ? 'bg-green-500'
                            : task.status === 'failed'
                              ? 'bg-red-500'
                              : 'bg-blue-500 animate-pulse'
                        }`}
                      />
                      <span className="text-sandstorm-muted">
                        {task.status === 'completed'
                          ? `Completed (exit ${task.exit_code})`
                          : task.status === 'failed'
                            ? `Failed (exit ${task.exit_code})`
                            : 'Running...'}
                      </span>
                      <span className="text-sandstorm-muted text-xs">
                        {new Date(task.started_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-sandstorm-text/80">
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
      <div className="border-t border-sandstorm-border px-6 py-3">
        <div className="flex gap-2 items-end">
          <textarea
            value={taskPrompt}
            onChange={(e) => setTaskPrompt(e.target.value)}
            placeholder="Describe a task for inner Claude..."
            className="flex-1 bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-sm text-sandstorm-text placeholder-sandstorm-muted/50 resize-none focus:outline-none focus:border-sandstorm-accent"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                handleDispatch();
              }
            }}
          />
          <div className="flex flex-col gap-1">
            <button
              onClick={handleDispatch}
              disabled={!taskPrompt.trim() || dispatching}
              className="px-4 py-2 bg-sandstorm-accent text-white text-sm rounded-lg hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {dispatching ? 'Dispatching...' : 'Dispatch'}
            </button>
          </div>
        </div>
        <div className="flex gap-2 mt-2">
          <button
            onClick={() => {
              loadDiff();
              setActiveTab('diff');
            }}
            className="text-xs px-3 py-1 rounded border border-sandstorm-border text-sandstorm-muted hover:text-sandstorm-text hover:bg-sandstorm-border/50 transition-colors"
          >
            View Full Diff
          </button>
          <button
            onClick={handlePush}
            className="text-xs px-3 py-1 rounded border border-sandstorm-border text-sandstorm-muted hover:text-sandstorm-text hover:bg-sandstorm-border/50 transition-colors"
          >
            Push to Remote
          </button>
          <button
            onClick={handleTeardown}
            className="text-xs px-3 py-1 rounded border border-red-800 text-red-400 hover:bg-red-900/30 transition-colors"
          >
            Tear Down
          </button>
        </div>
      </div>
    </div>
  );
}
