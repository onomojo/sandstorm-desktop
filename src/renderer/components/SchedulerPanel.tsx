import React, { useEffect, useState, useCallback } from 'react';
import { useAppStore, ScheduleEntry, ScheduleAction } from '../store';
import { cronToHuman, validateCronExpression as validateCron } from '../../shared/cron-utils';
import { NewScheduleModal } from './NewScheduleModal';

interface ScheduleFormData {
  label: string;
  cronExpression: string;
  actionKind: ScheduleAction['kind'];
  // run-script fields
  scriptName: string;
  enabled: boolean;
}

function buildAction(form: ScheduleFormData): ScheduleAction | { error: string } {
  switch (form.actionKind) {
    case 'run-script':
      if (!form.scriptName.trim()) return { error: 'Script name is required' };
      return { kind: 'run-script', scriptName: form.scriptName.trim() };
    default:
      return { error: `Unsupported action kind: ${String(form.actionKind)}` };
  }
}

function actionSummary(action: ScheduleAction): string {
  switch (action.kind) {
    case 'run-script':
      return `run-script · ${action.scriptName}`;
    default:
      return `unknown action`;
  }
}

function ScheduleForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  initial: ScheduleFormData;
  onSubmit: (data: ScheduleFormData) => void;
  onCancel: () => void;
  submitLabel: string;
}) {
  const [form, setForm] = useState<ScheduleFormData>(initial);
  const [error, setError] = useState<string | null>(null);

  const cronError = form.cronExpression ? validateCron(form.cronExpression) : null;
  const cronPreview = !cronError && form.cronExpression ? cronToHuman(form.cronExpression) : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.cronExpression.trim()) { setError('Cron expression is required'); return; }
    if (cronError) { setError(cronError); return; }
    const action = buildAction(form);
    if ('error' in action) { setError(action.error); return; }
    setError(null);
    onSubmit(form);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3" data-testid="schedule-form">
      <div>
        <label className="block text-[11px] font-medium text-sandstorm-text-secondary mb-1">Label (optional)</label>
        <input
          type="text"
          value={form.label}
          onChange={(e) => setForm({ ...form, label: e.target.value })}
          className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-md px-2.5 py-1.5 text-xs text-sandstorm-text placeholder:text-sandstorm-muted focus:outline-none focus:border-sandstorm-accent"
          placeholder="e.g., Daily ticket sweep"
          data-testid="schedule-label-input"
        />
      </div>

      <div>
        <label className="block text-[11px] font-medium text-sandstorm-text-secondary mb-1">Cron Expression</label>
        <input
          type="text"
          value={form.cronExpression}
          onChange={(e) => setForm({ ...form, cronExpression: e.target.value })}
          className={`w-full bg-sandstorm-bg border rounded-md px-2.5 py-1.5 text-xs font-mono text-sandstorm-text placeholder:text-sandstorm-muted focus:outline-none ${
            cronError ? 'border-red-500/50 focus:border-red-500' : 'border-sandstorm-border focus:border-sandstorm-accent'
          }`}
          placeholder="0 * * * *"
          data-testid="schedule-cron-input"
        />
        {cronPreview && (
          <p className="mt-1 text-[10px] text-sandstorm-accent" data-testid="cron-preview">{cronPreview}</p>
        )}
        {cronError && form.cronExpression && (
          <p className="mt-1 text-[10px] text-red-400">{cronError}</p>
        )}
      </div>

      <div>
        <label className="block text-[11px] font-medium text-sandstorm-text-secondary mb-1">Script name</label>
        <input
          type="text"
          value={form.scriptName}
          onChange={(e) => setForm({ ...form, scriptName: e.target.value })}
          className="w-full bg-sandstorm-bg border border-sandstorm-border rounded-md px-2.5 py-1.5 text-xs font-mono text-sandstorm-text placeholder:text-sandstorm-muted focus:outline-none focus:border-sandstorm-accent"
          placeholder="triage-open-issues.sh"
          data-testid="schedule-script-name"
        />
        <p className="mt-1 text-[10px] text-sandstorm-muted">
          Path is resolved under <span className="font-mono">.sandstorm/scripts/scheduled/</span>. Must be executable.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          id="schedule-enabled"
          className="rounded border-sandstorm-border text-sandstorm-accent focus:ring-sandstorm-accent"
          data-testid="schedule-enabled-checkbox"
        />
        <label htmlFor="schedule-enabled" className="text-[11px] text-sandstorm-text-secondary">Enabled</label>
      </div>

      {error && (
        <p className="text-[11px] text-red-400" data-testid="schedule-form-error">{error}</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          className="px-3 py-1.5 bg-sandstorm-accent hover:bg-sandstorm-accent-hover text-white rounded-md text-xs font-medium transition-colors"
          data-testid="schedule-submit-btn"
        >
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 bg-sandstorm-surface-hover hover:bg-sandstorm-border text-sandstorm-text-secondary rounded-md text-xs font-medium transition-colors"
          data-testid="schedule-cancel-btn"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ScheduleRow({
  schedule,
  projectDir,
  onEdit,
  onRefresh,
  onError,
}: {
  schedule: ScheduleEntry;
  projectDir: string;
  onEdit: (s: ScheduleEntry) => void;
  onRefresh: () => void;
  onError: (msg: string) => void;
}) {
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleToggle = async () => {
    setToggling(true);
    try {
      await window.sandstorm.schedules.update(projectDir, schedule.id, { enabled: !schedule.enabled });
      onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setToggling(false);
    }
  };

  const handleDeleteClick = () => {
    if (confirmDelete) {
      handleDeleteConfirm();
    } else {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
    }
  };

  const handleDeleteConfirm = async () => {
    if (deleting) return;
    setDeleting(true);
    setConfirmDelete(false);
    try {
      await window.sandstorm.schedules.delete(projectDir, schedule.id);
      onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className={`flex items-start gap-2 px-3 py-2 rounded-lg border transition-colors ${
        schedule.enabled
          ? 'border-sandstorm-border bg-sandstorm-surface hover:bg-sandstorm-surface-hover'
          : 'border-sandstorm-border/50 bg-sandstorm-bg opacity-60'
      }`}
      data-testid="schedule-row"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-sandstorm-text truncate">
            {schedule.label || schedule.id}
          </span>
          <span className="text-[10px] font-mono text-sandstorm-muted bg-sandstorm-bg px-1.5 py-0.5 rounded border border-sandstorm-border shrink-0">
            {schedule.cronExpression}
          </span>
        </div>
        <p className="text-[10px] font-mono text-sandstorm-muted mt-0.5 truncate" title={actionSummary(schedule.action)}>
          {actionSummary(schedule.action)}
        </p>
        <p className="text-[10px] text-sandstorm-muted/70 mt-0.5">
          {cronToHuman(schedule.cronExpression)}
        </p>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {/* Enable/disable toggle */}
        <button
          onClick={handleToggle}
          disabled={toggling}
          className={`w-8 h-4 rounded-full transition-colors relative ${
            schedule.enabled ? 'bg-sandstorm-accent' : 'bg-sandstorm-border'
          }`}
          title={schedule.enabled ? 'Disable schedule' : 'Enable schedule'}
          data-testid="schedule-toggle"
        >
          <span
            className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
              schedule.enabled ? 'left-4' : 'left-0.5'
            }`}
          />
        </button>

        {/* Edit button */}
        <button
          onClick={() => onEdit(schedule)}
          className="p-1 text-sandstorm-muted hover:text-sandstorm-text transition-colors"
          title="Edit"
          data-testid="schedule-edit-btn"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
        </button>

        {/* Delete button (click once to arm, click again to confirm) */}
        <button
          onClick={handleDeleteClick}
          disabled={deleting}
          className={`p-1 transition-colors ${
            confirmDelete ? 'text-red-400 animate-pulse' : 'text-sandstorm-muted hover:text-red-400'
          }`}
          title={confirmDelete ? 'Click again to confirm delete' : 'Delete'}
          data-testid="schedule-delete-btn"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function scheduleToFormData(schedule: ScheduleEntry): ScheduleFormData {
  const base: ScheduleFormData = {
    label: schedule.label || '',
    cronExpression: schedule.cronExpression,
    actionKind: schedule.action.kind,
    scriptName: '',
    enabled: schedule.enabled,
  };
  if (schedule.action.kind === 'run-script') {
    base.scriptName = schedule.action.scriptName;
  }
  return base;
}

export function SchedulerPanel({ projectDir }: { projectDir: string }) {
  const { schedules, schedulesLoading, cronHealthy, refreshSchedules, refreshCronHealth } = useAppStore();
  const [showModal, setShowModal] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<ScheduleEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    refreshSchedules(projectDir);
  }, [projectDir, refreshSchedules]);

  useEffect(() => {
    setError(null);
    setShowModal(false);
    setEditingSchedule(null);
    refresh();
    refreshCronHealth();
  }, [projectDir, refresh, refreshCronHealth]);

  const handleUpdate = async (data: ScheduleFormData) => {
    if (!editingSchedule) return;
    const action = buildAction(data);
    if ('error' in action) { setError(action.error); return; }
    try {
      setError(null);
      await window.sandstorm.schedules.update(projectDir, editingSchedule.id, {
        label: data.label || undefined,
        cronExpression: data.cronExpression,
        action,
        enabled: data.enabled,
      });
      setEditingSchedule(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleEdit = (schedule: ScheduleEntry) => {
    setEditingSchedule(schedule);
    setShowModal(false);
  };

  return (
    <div className="flex flex-col h-full" data-testid="scheduler-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-sandstorm-border shrink-0">
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-sandstorm-muted">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span className="text-xs font-medium text-sandstorm-text">Schedules</span>
          {schedules.length > 0 && (
            <span className="text-[10px] bg-sandstorm-surface text-sandstorm-muted px-1.5 py-0.5 rounded-full border border-sandstorm-border">
              {schedules.length}
            </span>
          )}
        </div>
        {!editingSchedule && (
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-sandstorm-accent hover:text-sandstorm-accent-hover transition-colors"
            data-testid="new-schedule-btn"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New
          </button>
        )}
      </div>

      {/* Cron daemon warning */}
      {cronHealthy === false && (
        <div className="mx-3 mt-2 flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 rounded-md px-2.5 py-1.5" data-testid="cron-warning">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400 shrink-0">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-[10px] text-amber-400">
            System cron daemon is not running; scheduled tasks will not fire.
          </span>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-2">
        {error && (
          <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-2.5 py-1.5" data-testid="schedule-error">
            {error}
          </div>
        )}

        {/* Edit schedule form (inline, for editing existing schedules) */}
        {editingSchedule && (
          <div className="border border-sandstorm-accent/30 rounded-lg p-3 bg-sandstorm-bg">
            <ScheduleForm
              key={editingSchedule.id}
              initial={scheduleToFormData(editingSchedule)}
              onSubmit={handleUpdate}
              onCancel={() => { setEditingSchedule(null); setError(null); }}
              submitLabel="Update Schedule"
            />
          </div>
        )}

        {/* Schedule list */}
        {schedulesLoading && schedules.length === 0 && (
          <p className="text-[11px] text-sandstorm-muted text-center py-4">Loading...</p>
        )}

        {!schedulesLoading && schedules.length === 0 && !editingSchedule && (
          <div className="flex flex-col items-center justify-center py-6 text-sandstorm-muted">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-2 opacity-50">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <p className="text-[11px] font-medium text-sandstorm-text-secondary mb-0.5">No schedules</p>
            <p className="text-[10px]">Create a schedule to automate recurring tasks</p>
          </div>
        )}

        {schedules.map((schedule) => (
          <ScheduleRow
            key={schedule.id}
            schedule={schedule}
            projectDir={projectDir}
            onEdit={handleEdit}
            onRefresh={refresh}
            onError={setError}
          />
        ))}
      </div>

      {/* New schedule modal */}
      {showModal && (
        <NewScheduleModal
          projectDir={projectDir}
          onClose={() => setShowModal(false)}
          onCreated={refresh}
        />
      )}
    </div>
  );
}
