import React, { useState, useEffect, useMemo } from 'react';
import { useAppStore } from '../store';

const VALID_STACK_NAME_RE = /^[a-z][a-z0-9_-]*$/;

function validateStackName(name: string): string | null {
  if (!name) return null; // don't show error on empty (handled by required check)
  if (name !== name.toLowerCase()) return 'Name must be lowercase';
  if (/\s/.test(name)) return 'Name cannot contain spaces (use hyphens instead)';
  if (!VALID_STACK_NAME_RE.test(name))
    return 'Name must start with a letter and contain only lowercase letters, numbers, hyphens, and underscores';
  return null;
}

export function NewStackDialog() {
  const { setShowNewStackDialog, refreshStacks, activeProject } = useAppStore();
  const project = activeProject();

  const [name, setName] = useState('');
  const [ticket, setTicket] = useState('');
  const [branch, setBranch] = useState('');
  const [projectDir, setProjectDir] = useState(project?.directory ?? '');
  const [runtime, setRuntime] = useState<'docker' | 'podman'>('docker');
  const [task, setTask] = useState('');
  const [model, setModel] = useState<string>('sonnet');
  const [error, setError] = useState<string | null>(null);
  const nameValidationError = useMemo(() => validateStackName(name.trim()), [name]);
  const [runtimes, setRuntimes] = useState({ docker: false, podman: false });

  useEffect(() => {
    window.sandstorm.runtime.available().then(setRuntimes);
  }, []);

  useEffect(() => {
    const dir = project?.directory;
    if (!dir) return;
    window.sandstorm.modelSettings.getEffective(dir).then((settings) => {
      setModel(settings.inner_model);
    }).catch(() => {
      setModel('sonnet');
    });
  }, [project?.directory]);

  const handleCreate = async () => {
    const dir = project?.directory ?? projectDir.trim();
    if (!name.trim() || !dir) {
      setError('Name and project directory are required');
      return;
    }
    if (nameValidationError) {
      setError(nameValidationError);
      return;
    }

    try {
      await window.sandstorm.stacks.create({
        name: name.trim(),
        projectDir: dir,
        ticket: ticket.trim() || undefined,
        branch: branch.trim() || undefined,
        description: task.trim() || undefined,
        runtime,
        task: task.trim() || undefined,
        model,
      });
      // Close dialog immediately — build happens in background
      await refreshStacks();
      setShowNewStackDialog(false);
    } catch (err) {
      setError(String(err));
    }
  };

  const dialogTitle = project ? `New Stack — ${project.name}` : 'New Stack';

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) setShowNewStackDialog(false); }}
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[480px] max-h-[90vh] overflow-y-auto shadow-dialog animate-slide-up">
        {/* Header */}
        <div className="px-6 py-4 border-b border-sandstorm-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-sandstorm-text">{dialogTitle}</h2>
            <p className="text-[11px] text-sandstorm-muted mt-0.5">Create a new isolated development environment</p>
          </div>
          <button
            onClick={() => setShowNewStackDialog(false)}
            className="text-sandstorm-muted hover:text-sandstorm-text transition-colors p-1.5 rounded-md hover:bg-sandstorm-surface-hover"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5 flex items-start gap-2 animate-fade-in">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>
              </svg>
              {error}
            </div>
          )}

          <Field label="Stack Name" required>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="auth-refactor"
              className={`w-full bg-sandstorm-bg border rounded-lg px-3 py-2 text-[13px] text-sandstorm-text placeholder-sandstorm-muted/50 outline-none transition-all focus:ring-1 ${
                nameValidationError
                  ? 'border-red-500/50 focus:border-red-500/50 focus:ring-red-500/20'
                  : 'border-sandstorm-border focus:border-sandstorm-accent/50 focus:ring-sandstorm-accent/20'
              }`}
              data-testid="stack-name"
              autoFocus
            />
            {nameValidationError && (
              <p className="text-[10px] text-red-400 mt-1" data-testid="name-error">{nameValidationError}</p>
            )}
          </Field>

          {/* Only show project directory field if no project is selected */}
          {!project && (
            <Field label="Project Directory" required>
              <input
                type="text"
                value={projectDir}
                onChange={(e) => setProjectDir(e.target.value)}
                placeholder="/home/user/projects/myapp"
                className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-[12px] font-mono text-sandstorm-text placeholder-sandstorm-muted/50 outline-none transition-all focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
              />
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Ticket">
              <input
                type="text"
                value={ticket}
                onChange={(e) => setTicket(e.target.value)}
                placeholder="EXP-342"
                className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-[12px] font-mono text-sandstorm-text placeholder-sandstorm-muted/50 outline-none transition-all focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
                data-testid="stack-ticket"
              />
            </Field>

            <Field label="Branch">
              <input
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="feature/auth"
                className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-[12px] font-mono text-sandstorm-text placeholder-sandstorm-muted/50 outline-none transition-all focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
              />
            </Field>
          </div>

          <Field label="Runtime">
            <div className="flex gap-2">
              {(['docker', 'podman'] as const).map((rt) => (
                <button
                  key={rt}
                  onClick={() => setRuntime(rt)}
                  disabled={!runtimes[rt]}
                  className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-all ${
                    runtime === rt
                      ? 'border-sandstorm-accent bg-sandstorm-accent/10 text-sandstorm-accent'
                      : 'border-sandstorm-border bg-sandstorm-bg text-sandstorm-muted hover:border-sandstorm-border-light disabled:opacity-40'
                  }`}
                >
                  {rt.charAt(0).toUpperCase() + rt.slice(1)}
                  {!runtimes[rt] && <span className="text-[10px] block text-sandstorm-muted mt-0.5">unavailable</span>}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Model" hint="Claude model for the inner agent">
            <div className="flex gap-2">
              {([
                { id: 'auto', label: 'Auto', desc: 'Intelligent triage' },
                { id: 'sonnet', label: 'Sonnet', desc: 'Fast & efficient' },
                { id: 'opus', label: 'Opus', desc: 'Most capable' },
              ] as const).map((m) => (
                <button
                  key={m.id}
                  onClick={() => setModel(m.id)}
                  className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-all ${
                    model === m.id
                      ? 'border-sandstorm-accent bg-sandstorm-accent/10 text-sandstorm-accent'
                      : 'border-sandstorm-border bg-sandstorm-bg text-sandstorm-muted hover:border-sandstorm-border-light'
                  }`}
                  data-testid={`model-${m.id}`}
                >
                  {m.label}
                  <span className="text-[10px] block text-sandstorm-muted mt-0.5">{m.desc}</span>
                </button>
              ))}
            </div>
          </Field>

          <Field label="Initial Task" hint="If provided, dispatched immediately after launch">
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Describe what inner Claude should work on..."
              className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-[13px] text-sandstorm-text placeholder-sandstorm-muted/50 resize-none outline-none transition-all focus:border-sandstorm-accent/50 focus:ring-1 focus:ring-sandstorm-accent/20"
              rows={3}
            />
          </Field>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-sandstorm-border flex justify-end gap-2">
          <button
            onClick={() => setShowNewStackDialog(false)}
            className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text transition-colors rounded-lg hover:bg-sandstorm-surface-hover"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || !!nameValidationError || (!project && !projectDir.trim())}
            className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-glow"
            data-testid="launch-btn"
          >
            Launch Stack
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
        {label}
        {required && <span className="text-sandstorm-accent ml-0.5">*</span>}
      </label>
      {children}
      {hint && (
        <p className="text-[10px] text-sandstorm-muted mt-1">{hint}</p>
      )}
    </div>
  );
}
