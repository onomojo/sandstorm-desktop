import React, { useState, useEffect } from 'react';
import { useAppStore } from '../store';

export function NewStackDialog() {
  const { setShowNewStackDialog, refreshStacks } = useAppStore();
  const [name, setName] = useState('');
  const [ticket, setTicket] = useState('');
  const [branch, setBranch] = useState('');
  const [projectDir, setProjectDir] = useState('');
  const [runtime, setRuntime] = useState<'docker' | 'podman'>('docker');
  const [task, setTask] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runtimes, setRuntimes] = useState({ docker: false, podman: false });

  useEffect(() => {
    window.sandstorm.runtime.available().then(setRuntimes);
  }, []);

  const handleCreate = async () => {
    if (!name.trim() || !projectDir.trim()) {
      setError('Name and project directory are required');
      return;
    }

    setCreating(true);
    setError(null);

    try {
      await window.sandstorm.stacks.create({
        name: name.trim(),
        projectDir: projectDir.trim(),
        ticket: ticket.trim() || undefined,
        branch: branch.trim() || undefined,
        description: task.trim() || undefined,
        runtime,
        task: task.trim() || undefined,
      });
      await refreshStacks();
      setShowNewStackDialog(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[500px] max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="px-6 py-4 border-b border-sandstorm-border">
          <h2 className="text-lg font-semibold">New Stack</h2>
        </div>

        <div className="px-6 py-4 space-y-4">
          {error && (
            <div className="text-sm text-red-400 bg-red-900/20 border border-red-800 rounded px-3 py-2">
              {error}
            </div>
          )}

          <Field label="Name" required>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="auth-refactor"
              className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-sm text-sandstorm-text placeholder-sandstorm-muted/50 focus:outline-none focus:border-sandstorm-accent"
              data-testid="stack-name"
              autoFocus
            />
          </Field>

          <Field label="Project Directory" required>
            <input
              type="text"
              value={projectDir}
              onChange={(e) => setProjectDir(e.target.value)}
              placeholder="/home/user/Work/myproject"
              className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-sm text-sandstorm-text placeholder-sandstorm-muted/50 focus:outline-none focus:border-sandstorm-accent"
            />
          </Field>

          <Field label="Ticket">
            <input
              type="text"
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              placeholder="EXP-342"
              className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-sm text-sandstorm-text placeholder-sandstorm-muted/50 focus:outline-none focus:border-sandstorm-accent"
              data-testid="stack-ticket"
            />
          </Field>

          <Field label="Branch">
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="feature/auth-middleware"
              className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-sm text-sandstorm-text placeholder-sandstorm-muted/50 focus:outline-none focus:border-sandstorm-accent"
            />
          </Field>

          <Field label="Runtime">
            <select
              value={runtime}
              onChange={(e) => setRuntime(e.target.value as 'docker' | 'podman')}
              className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-sm text-sandstorm-text focus:outline-none focus:border-sandstorm-accent"
            >
              <option value="docker" disabled={!runtimes.docker}>
                Docker{!runtimes.docker ? ' (not available)' : ''}
              </option>
              <option value="podman" disabled={!runtimes.podman}>
                Podman{!runtimes.podman ? ' (not available)' : ''}
              </option>
            </select>
          </Field>

          <Field label="Task (optional)">
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Describe what inner Claude should work on..."
              className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-sm text-sandstorm-text placeholder-sandstorm-muted/50 focus:outline-none focus:border-sandstorm-accent resize-none"
              rows={3}
            />
            <p className="text-xs text-sandstorm-muted mt-1">
              If provided, the task will be dispatched immediately after the stack launches.
            </p>
          </Field>
        </div>

        <div className="px-6 py-4 border-t border-sandstorm-border flex justify-end gap-3">
          <button
            onClick={() => setShowNewStackDialog(false)}
            className="px-4 py-2 text-sm text-sandstorm-muted hover:text-sandstorm-text transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !name.trim() || !projectDir.trim()}
            className="px-6 py-2 bg-sandstorm-accent text-white text-sm rounded-lg hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            data-testid="launch-btn"
          >
            {creating ? 'Launching...' : 'Launch'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-sandstorm-text mb-1">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}
