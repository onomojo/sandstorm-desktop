/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SchedulerPanel } from '../../../src/renderer/components/SchedulerPanel';
import { useAppStore, ScheduleEntry } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

const SAMPLE_SCHEDULE: ScheduleEntry = {
  id: 'sch_abc123',
  label: 'Triage issues',
  cronExpression: '0 * * * *',
  action: { kind: 'run-script', scriptName: 'triage.sh' },
  enabled: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('SchedulerPanel', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    useAppStore.setState({ schedules: [], schedulesLoading: false, cronHealthy: true });
    api = mockSandstormApi();
  });

  it('renders empty state when no schedules', async () => {
    api.schedules.list.mockResolvedValue([]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    await waitFor(() => {
      expect(screen.getByText('No schedules')).toBeTruthy();
    });
  });

  it('renders schedule list with action summary', async () => {
    api.schedules.list.mockResolvedValue([SAMPLE_SCHEDULE]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });

    useAppStore.setState({ schedules: [SAMPLE_SCHEDULE], cronHealthy: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    expect(screen.getByText('Triage issues')).toBeTruthy();
    expect(screen.getByText('0 * * * *')).toBeTruthy();
    expect(screen.getByText(/run-script · triage\.sh/)).toBeTruthy();
  });

  it('shows cron daemon warning when not running', () => {
    api.schedules.list.mockResolvedValue([]);
    api.schedules.cronHealth.mockResolvedValue({ running: false });
    useAppStore.setState({ cronHealthy: false });

    render(<SchedulerPanel projectDir="/test/project" />);

    expect(screen.getByTestId('cron-warning')).toBeTruthy();
    expect(screen.getByText(/cron daemon is not running/i)).toBeTruthy();
  });

  it('does not show cron warning when cron is healthy', () => {
    api.schedules.list.mockResolvedValue([]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });
    useAppStore.setState({ cronHealthy: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    expect(screen.queryByTestId('cron-warning')).toBeNull();
  });

  it('opens NewScheduleModal when + New button is clicked', async () => {
    api.schedules.list.mockResolvedValue([]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });
    api.schedules.listBuiltInActions.mockResolvedValue([]);
    api.schedules.listScripts.mockResolvedValue([]);

    render(<SchedulerPanel projectDir="/test/project" />);

    fireEvent.click(screen.getByTestId('new-schedule-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('new-schedule-modal')).toBeTruthy();
    });
  });

  it('closes the modal when the close button is clicked', async () => {
    api.schedules.list.mockResolvedValue([]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });
    api.schedules.listBuiltInActions.mockResolvedValue([]);
    api.schedules.listScripts.mockResolvedValue([]);

    render(<SchedulerPanel projectDir="/test/project" />);

    fireEvent.click(screen.getByTestId('new-schedule-btn'));
    await waitFor(() => screen.getByTestId('new-schedule-modal'));

    fireEvent.click(screen.getByTestId('new-schedule-modal-close'));

    await waitFor(() => {
      expect(screen.queryByTestId('new-schedule-modal')).toBeNull();
    });
  });

  it('requires double-click to delete (click to arm, click to confirm)', async () => {
    api.schedules.list.mockResolvedValue([SAMPLE_SCHEDULE]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });
    api.schedules.delete.mockResolvedValue(undefined);

    useAppStore.setState({ schedules: [SAMPLE_SCHEDULE], cronHealthy: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    const deleteBtn = screen.getByTestId('schedule-delete-btn');

    fireEvent.click(deleteBtn);
    expect(api.schedules.delete).not.toHaveBeenCalled();

    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(api.schedules.delete).toHaveBeenCalledWith('/test/project', 'sch_abc123');
    });
  });

  it('toggles schedule enabled/disabled', async () => {
    api.schedules.list.mockResolvedValue([SAMPLE_SCHEDULE]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });
    api.schedules.update.mockResolvedValue({ ...SAMPLE_SCHEDULE, enabled: false });

    useAppStore.setState({ schedules: [SAMPLE_SCHEDULE], cronHealthy: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    fireEvent.click(screen.getByTestId('schedule-toggle'));

    await waitFor(() => {
      expect(api.schedules.update).toHaveBeenCalledWith(
        '/test/project',
        'sch_abc123',
        { enabled: false },
      );
    });
  });

  it('opens edit form pre-populated with the current action + script name', async () => {
    api.schedules.list.mockResolvedValue([SAMPLE_SCHEDULE]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });

    useAppStore.setState({ schedules: [SAMPLE_SCHEDULE], cronHealthy: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    fireEvent.click(screen.getByTestId('schedule-edit-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('schedule-form')).toBeTruthy();
      expect((screen.getByTestId('schedule-cron-input') as HTMLInputElement).value).toBe('0 * * * *');
      expect((screen.getByTestId('schedule-script-name') as HTMLInputElement).value).toBe('triage.sh');
    });
  });

  it('submits edit form with updated action', async () => {
    api.schedules.list.mockResolvedValue([SAMPLE_SCHEDULE]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });
    api.schedules.update.mockResolvedValue({
      ...SAMPLE_SCHEDULE,
      cronExpression: '*/15 * * * *',
      action: { kind: 'run-script', scriptName: 'new-triage.sh' },
    });

    useAppStore.setState({ schedules: [SAMPLE_SCHEDULE], cronHealthy: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    fireEvent.click(screen.getByTestId('schedule-edit-btn'));
    await waitFor(() => screen.getByTestId('schedule-form'));

    fireEvent.change(screen.getByTestId('schedule-cron-input'), {
      target: { value: '*/15 * * * *' },
    });
    fireEvent.change(screen.getByTestId('schedule-script-name'), {
      target: { value: 'new-triage.sh' },
    });

    fireEvent.click(screen.getByTestId('schedule-submit-btn'));

    await waitFor(() => {
      expect(api.schedules.update).toHaveBeenCalledWith(
        '/test/project',
        'sch_abc123',
        expect.objectContaining({
          cronExpression: '*/15 * * * *',
          action: { kind: 'run-script', scriptName: 'new-triage.sh' },
        }),
      );
    });
  });

  it('shows schedules count badge', () => {
    useAppStore.setState({
      schedules: [SAMPLE_SCHEDULE, { ...SAMPLE_SCHEDULE, id: 'sch_def456' }],
      cronHealthy: true,
    });

    render(<SchedulerPanel projectDir="/test/project" />);

    expect(screen.getByText('2')).toBeTruthy();
  });

  it('shows error banner when toggle fails', async () => {
    api.schedules.list.mockResolvedValue([SAMPLE_SCHEDULE]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });
    api.schedules.update.mockRejectedValue(new Error('Network error'));

    useAppStore.setState({ schedules: [SAMPLE_SCHEDULE], cronHealthy: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-toggle'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('schedule-error')).toBeTruthy();
      expect(screen.getByText('Network error')).toBeTruthy();
    });
  });

  it('shows error banner when delete fails', async () => {
    api.schedules.list.mockResolvedValue([SAMPLE_SCHEDULE]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });
    api.schedules.delete.mockRejectedValue(new Error('Delete failed'));

    useAppStore.setState({ schedules: [SAMPLE_SCHEDULE], cronHealthy: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    fireEvent.click(screen.getByTestId('schedule-delete-btn'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-delete-btn'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('schedule-error')).toBeTruthy();
      expect(screen.getByText('Delete failed')).toBeTruthy();
    });
  });
});
