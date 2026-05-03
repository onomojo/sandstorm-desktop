import React, { useEffect, useState } from 'react';
import { BuiltInAction, ScheduleAction } from '../store';
import { cronToHuman, validateCronExpression as validateCron } from '../../shared/cron-utils';
import { RunScriptConfig } from './scheduler/RunScriptConfig';

// Dropdown option value encoding:
//   "builtin:<kind>"   → a built-in action
//   "script:<name>"    → a custom script from .sandstorm/scripts/scheduled/
const PLACEHOLDER = '';

function encodeBuiltin(kind: string): string {
  return `builtin:${kind}`;
}

function encodeScript(name: string): string {
  return `script:${name}`;
}

function decodeEntry(value: string): { type: 'builtin'; kind: string } | { type: 'script'; scriptName: string } | null {
  if (value.startsWith('builtin:')) return { type: 'builtin', kind: value.slice('builtin:'.length) };
  if (value.startsWith('script:')) return { type: 'script', scriptName: value.slice('script:'.length) };
  return null;
}

function buildAction(
  entry: ReturnType<typeof decodeEntry>,
  builtIns: BuiltInAction[],
): ScheduleAction | { error: string } {
  if (!entry) return { error: 'Select an action' };
  if (entry.type === 'script') {
    if (!entry.scriptName) return { error: 'Select a script' };
    return { kind: 'run-script', scriptName: entry.scriptName };
  }
  const builtin = builtIns.find((b) => b.kind === entry.kind);
  if (!builtin) return { error: `Unknown built-in action: ${entry.kind}` };
  return builtin.defaultAction;
}

interface NewScheduleModalProps {
  projectDir: string;
  onClose: () => void;
  onCreated: () => void;
}

export function NewScheduleModal({ projectDir, onClose, onCreated }: NewScheduleModalProps) {
  const [builtIns, setBuiltIns] = useState<BuiltInAction[]>([]);
  const [scripts, setScripts] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedValue, setSelectedValue] = useState<string>(PLACEHOLDER);
  const [label, setLabel] = useState('');
  const [cronExpression, setCronExpression] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [actions, scriptList] = await Promise.all([
          window.sandstorm.schedules.listBuiltInActions(),
          window.sandstorm.schedules.listScripts(projectDir),
        ]);
        if (cancelled) return;
        setBuiltIns(actions);
        setScripts(scriptList);
        // Auto-select first available option
        if (actions.length > 0) {
          setSelectedValue(encodeBuiltin(actions[0].kind));
        } else if (scriptList.length > 0) {
          setSelectedValue(encodeScript(scriptList[0]));
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    }
    load();
    return () => { cancelled = true; };
  }, [projectDir]);

  const cronError = cronExpression ? validateCron(cronExpression) : null;
  const cronPreview = !cronError && cronExpression ? cronToHuman(cronExpression) : null;

  const decoded = decodeEntry(selectedValue);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cronExpression.trim()) { setError('Cron expression is required'); return; }
    if (cronError) { setError(cronError); return; }
    const action = buildAction(decoded, builtIns);
    if ('error' in action) { setError(action.error); return; }
    setError(null);
    setSubmitting(true);
    try {
      await window.sandstorm.schedules.create(projectDir, {
        label: label.trim() || undefined,
        cronExpression: cronExpression.trim(),
        action,
        enabled,
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const hasOptions = builtIns.length > 0 || scripts.length > 0;

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="new-schedule-modal"
    >
      <div className="bg-sandstorm-surface border border-sandstorm-border rounded-xl w-[480px] max-h-[90vh] overflow-y-auto shadow-dialog animate-slide-up">
        {/* Header */}
        <div className="px-6 py-4 border-b border-sandstorm-border flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-sandstorm-text">New Schedule</h2>
            <p className="text-[11px] text-sandstorm-muted mt-0.5">
              Automate a recurring task for this project
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-sandstorm-muted hover:text-sandstorm-text transition-colors p-1.5 rounded-md hover:bg-sandstorm-surface-hover"
            aria-label="Close"
            data-testid="new-schedule-modal-close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSave} data-testid="new-schedule-form">
          <div className="px-6 py-5 space-y-4">
            {loadError && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2" data-testid="new-schedule-load-error">
                Failed to load actions: {loadError}
              </div>
            )}

            {error && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2" data-testid="new-schedule-error">
                {error}
              </div>
            )}

            {/* Label */}
            <div>
              <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                Label <span className="text-sandstorm-muted font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g., Daily ticket sweep"
                className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-xs text-sandstorm-text placeholder:text-sandstorm-muted focus:outline-none focus:border-sandstorm-accent"
                data-testid="new-schedule-label"
              />
            </div>

            {/* Cron expression */}
            <div>
              <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                Cron Expression <span className="text-sandstorm-accent">*</span>
              </label>
              <input
                type="text"
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder="0 * * * *"
                className={`w-full bg-sandstorm-bg border rounded-lg px-3 py-2 text-xs font-mono text-sandstorm-text placeholder:text-sandstorm-muted focus:outline-none ${
                  cronError
                    ? 'border-red-500/50 focus:border-red-500'
                    : 'border-sandstorm-border focus:border-sandstorm-accent'
                }`}
                data-testid="new-schedule-cron"
              />
              {cronPreview && (
                <p className="mt-1 text-[10px] text-sandstorm-accent" data-testid="new-schedule-cron-preview">
                  {cronPreview}
                </p>
              )}
              {cronError && cronExpression && (
                <p className="mt-1 text-[10px] text-red-400">{cronError}</p>
              )}
            </div>

            {/* Action dropdown */}
            <div>
              <label className="block text-xs font-medium text-sandstorm-text-secondary mb-1.5">
                Action <span className="text-sandstorm-accent">*</span>
              </label>
              <select
                value={selectedValue}
                onChange={(e) => setSelectedValue(e.target.value)}
                className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-lg px-3 py-2 text-xs text-sandstorm-text focus:outline-none focus:border-sandstorm-accent"
                data-testid="new-schedule-action-select"
              >
                {!hasOptions && (
                  <option value={PLACEHOLDER} disabled>No actions available</option>
                )}
                {hasOptions && selectedValue === PLACEHOLDER && (
                  <option value={PLACEHOLDER} disabled>Select an action…</option>
                )}
                {builtIns.length > 0 && (
                  <optgroup label="Built-in">
                    {builtIns.map((b) => (
                      <option key={b.kind} value={encodeBuiltin(b.kind)}>
                        {b.label}
                      </option>
                    ))}
                  </optgroup>
                )}
                {scripts.length > 0 && (
                  <optgroup label="Custom scripts">
                    {scripts.map((s) => (
                      <option key={s} value={encodeScript(s)}>
                        {s}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>

              {/* Per-action description / config */}
              {decoded?.type === 'builtin' && (() => {
                const b = builtIns.find((x) => x.kind === decoded.kind);
                return b ? (
                  <p className="mt-1.5 text-[10px] text-sandstorm-muted" data-testid="builtin-description">
                    {b.description}
                  </p>
                ) : null;
              })()}

              {decoded?.type === 'script' && decoded.scriptName && (
                <div className="mt-1.5">
                  <RunScriptConfig scriptName={decoded.scriptName} />
                </div>
              )}
            </div>

            {/* Enabled */}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="new-schedule-enabled"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="rounded border-sandstorm-border text-sandstorm-accent focus:ring-sandstorm-accent"
                data-testid="new-schedule-enabled"
              />
              <label htmlFor="new-schedule-enabled" className="text-xs text-sandstorm-text-secondary">
                Enable immediately
              </label>
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-sandstorm-border flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-sandstorm-muted hover:text-sandstorm-text transition-colors rounded-lg hover:bg-sandstorm-surface-hover"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !hasOptions || selectedValue === PLACEHOLDER}
              className="px-5 py-2 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white text-xs font-medium rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-glow"
              data-testid="new-schedule-save-btn"
            >
              {submitting ? 'Saving…' : 'Save Schedule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
