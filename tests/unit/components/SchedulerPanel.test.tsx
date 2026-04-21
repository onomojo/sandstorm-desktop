/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SchedulerPanel } from '../../../src/renderer/components/SchedulerPanel';
import { useAppStore, ScheduleEntry } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

const SAMPLE_SCHEDULE: ScheduleEntry = {
  id: 'sch_abc123',
  label: 'Triage issues',
  cronExpression: '0 * * * *',
  prompt: 'Scan open issues labeled spec-ready',
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

  it('renders schedule list', async () => {
    api.schedules.list.mockResolvedValue([SAMPLE_SCHEDULE]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });

    // Pre-populate store so the component renders immediately
    useAppStore.setState({ schedules: [SAMPLE_SCHEDULE], cronHealthy: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    expect(screen.getByText('Triage issues')).toBeTruthy();
    expect(screen.getByText('0 * * * *')).toBeTruthy();
  });

  it('shows cron daemon warning when not running', async () => {
    api.schedules.list.mockResolvedValue([]);
    api.schedules.cronHealth.mockResolvedValue({ running: false });

    useAppStore.setState({ cronHealthy: false });

    render(<SchedulerPanel projectDir="/test/project" />);

    expect(screen.getByTestId('cron-warning')).toBeTruthy();
    expect(screen.getByText(/cron daemon is not running/i)).toBeTruthy();
  });

  it('does not show cron warning when cron is healthy', async () => {
    api.schedules.list.mockResolvedValue([]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });

    useAppStore.setState({ cronHealthy: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    expect(screen.queryByTestId('cron-warning')).toBeNull();
  });

  it('opens create form when New button is clicked', async () => {
    api.schedules.list.mockResolvedValue([]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    const newBtn = screen.getByTestId('new-schedule-btn');
    fireEvent.click(newBtn);

    await waitFor(() => {
      expect(screen.getByTestId('schedule-form')).toBeTruthy();
      expect(screen.getByTestId('schedule-cron-input')).toBeTruthy();
      expect(screen.getByTestId('schedule-prompt-input')).toBeTruthy();
    });
  });

  it('creates a schedule via the form', async () => {
    api.schedules.list.mockResolvedValue([]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });
    api.schedules.create.mockResolvedValue(SAMPLE_SCHEDULE);

    render(<SchedulerPanel projectDir="/test/project" />);

    // Open form
    fireEvent.click(screen.getByTestId('new-schedule-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('schedule-form')).toBeTruthy();
    });

    // Fill form
    fireEvent.change(screen.getByTestId('schedule-label-input'), {
      target: { value: 'Test Label' },
    });
    fireEvent.change(screen.getByTestId('schedule-cron-input'), {
      target: { value: '0 * * * *' },
    });
    fireEvent.change(screen.getByTestId('schedule-prompt-input'), {
      target: { value: 'Do stuff' },
    });

    // Submit
    fireEvent.click(screen.getByTestId('schedule-submit-btn'));

    await waitFor(() => {
      expect(api.schedules.create).toHaveBeenCalledWith('/test/project', {
        label: 'Test Label',
        cronExpression: '0 * * * *',
        prompt: 'Do stuff',
        enabled: true,
      });
    });
  });

  it('shows cron preview for valid expression', async () => {
    api.schedules.list.mockResolvedValue([]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    fireEvent.click(screen.getByTestId('new-schedule-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('schedule-cron-input')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('schedule-cron-input'), {
      target: { value: '*/5 * * * *' },
    });

    await waitFor(() => {
      expect(screen.getByTestId('cron-preview')).toBeTruthy();
      expect(screen.getByTestId('cron-preview').textContent).toContain('Every 5 minutes');
    });
  });

  it('requires double-click to delete (click to arm, click to confirm)', async () => {
    api.schedules.list.mockResolvedValue([SAMPLE_SCHEDULE]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });
    api.schedules.delete.mockResolvedValue(undefined);

    useAppStore.setState({ schedules: [SAMPLE_SCHEDULE], cronHealthy: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    const deleteBtn = screen.getByTestId('schedule-delete-btn');

    // First click arms the delete
    fireEvent.click(deleteBtn);
    expect(api.schedules.delete).not.toHaveBeenCalled();

    // Second click confirms and executes
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

    const toggleBtn = screen.getByTestId('schedule-toggle');
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(api.schedules.update).toHaveBeenCalledWith(
        '/test/project',
        'sch_abc123',
        { enabled: false }
      );
    });
  });

  it('opens edit form when edit button clicked', async () => {
    api.schedules.list.mockResolvedValue([SAMPLE_SCHEDULE]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });

    useAppStore.setState({ schedules: [SAMPLE_SCHEDULE], cronHealthy: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    const editBtn = screen.getByTestId('schedule-edit-btn');
    fireEvent.click(editBtn);

    await waitFor(() => {
      expect(screen.getByTestId('schedule-form')).toBeTruthy();
      // Form should be pre-filled with existing values
      expect((screen.getByTestId('schedule-cron-input') as HTMLInputElement).value).toBe('0 * * * *');
    });
  });

  it('submits edit form with updated values', async () => {
    api.schedules.list.mockResolvedValue([SAMPLE_SCHEDULE]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });
    api.schedules.update.mockResolvedValue({
      ...SAMPLE_SCHEDULE,
      cronExpression: '*/15 * * * *',
      label: 'Updated label',
    });

    useAppStore.setState({ schedules: [SAMPLE_SCHEDULE], cronHealthy: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    // Open edit form
    const editBtn = screen.getByTestId('schedule-edit-btn');
    fireEvent.click(editBtn);

    await waitFor(() => {
      expect(screen.getByTestId('schedule-form')).toBeTruthy();
    });

    // Modify fields
    fireEvent.change(screen.getByTestId('schedule-label-input'), {
      target: { value: 'Updated label' },
    });
    fireEvent.change(screen.getByTestId('schedule-cron-input'), {
      target: { value: '*/15 * * * *' },
    });

    // Submit
    fireEvent.click(screen.getByTestId('schedule-submit-btn'));

    await waitFor(() => {
      expect(api.schedules.update).toHaveBeenCalledWith(
        '/test/project',
        'sch_abc123',
        expect.objectContaining({
          cronExpression: '*/15 * * * *',
          label: 'Updated label',
        })
      );
    });
  });

  it('shows error when submitting with empty cron expression', async () => {
    api.schedules.list.mockResolvedValue([]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    fireEvent.click(screen.getByTestId('new-schedule-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('schedule-form')).toBeTruthy();
    });

    // Fill prompt but leave cron empty
    fireEvent.change(screen.getByTestId('schedule-prompt-input'), {
      target: { value: 'Do stuff' },
    });

    fireEvent.click(screen.getByTestId('schedule-submit-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('schedule-form-error')).toBeTruthy();
      expect(screen.getByText('Cron expression is required')).toBeTruthy();
    });

    // Should not call create
    expect(api.schedules.create).not.toHaveBeenCalled();
  });

  it('shows error when submitting with invalid cron expression', async () => {
    api.schedules.list.mockResolvedValue([]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    fireEvent.click(screen.getByTestId('new-schedule-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('schedule-form')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('schedule-cron-input'), {
      target: { value: 'not a valid cron' },
    });
    fireEvent.change(screen.getByTestId('schedule-prompt-input'), {
      target: { value: 'Do stuff' },
    });

    fireEvent.click(screen.getByTestId('schedule-submit-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('schedule-form-error')).toBeTruthy();
    });

    expect(api.schedules.create).not.toHaveBeenCalled();
  });

  it('shows error when submitting with empty prompt', async () => {
    api.schedules.list.mockResolvedValue([]);
    api.schedules.cronHealth.mockResolvedValue({ running: true });

    render(<SchedulerPanel projectDir="/test/project" />);

    fireEvent.click(screen.getByTestId('new-schedule-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('schedule-form')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('schedule-cron-input'), {
      target: { value: '0 * * * *' },
    });
    // Leave prompt empty

    fireEvent.click(screen.getByTestId('schedule-submit-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('schedule-form-error')).toBeTruthy();
      expect(screen.getByText('Prompt is required')).toBeTruthy();
    });

    expect(api.schedules.create).not.toHaveBeenCalled();
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

    const toggleBtn = screen.getByTestId('schedule-toggle');
    await act(async () => {
      fireEvent.click(toggleBtn);
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

    // First click arms the delete
    fireEvent.click(screen.getByTestId('schedule-delete-btn'));
    // Second click confirms and triggers the error
    await act(async () => {
      fireEvent.click(screen.getByTestId('schedule-delete-btn'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('schedule-error')).toBeTruthy();
      expect(screen.getByText('Delete failed')).toBeTruthy();
    });
  });
});
