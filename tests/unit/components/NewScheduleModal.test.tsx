/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { NewScheduleModal } from '../../../src/renderer/components/NewScheduleModal';
import { mockSandstormApi } from './setup';
import { BuiltInAction, ScheduleAction } from '../../../src/renderer/store';

const SAMPLE_BUILTIN: BuiltInAction = {
  kind: 'run-script' as ScheduleAction['kind'],
  label: 'Sample built-in',
  description: 'Does something useful on a schedule.',
  defaultAction: { kind: 'run-script', scriptName: '_builtin_sample.sh' },
};

describe('NewScheduleModal', () => {
  let api: ReturnType<typeof mockSandstormApi>;
  let onClose: ReturnType<typeof import('vitest').vi.fn>;
  let onCreated: ReturnType<typeof import('vitest').vi.fn>;

  beforeEach(async () => {
    const { vi } = await import('vitest');
    onClose = vi.fn();
    onCreated = vi.fn();
    api = mockSandstormApi();
  });

  it('renders the modal with label, cron, action, and save button', async () => {
    api.schedules.listBuiltInActions.mockResolvedValue([]);
    api.schedules.listScripts.mockResolvedValue(['triage.sh']);

    render(
      <NewScheduleModal
        projectDir="/test/project"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    expect(screen.getByTestId('new-schedule-modal')).toBeTruthy();
    expect(screen.getByTestId('new-schedule-label')).toBeTruthy();
    expect(screen.getByTestId('new-schedule-cron')).toBeTruthy();
    expect(screen.getByTestId('new-schedule-action-select')).toBeTruthy();
    expect(screen.getByTestId('new-schedule-save-btn')).toBeTruthy();
  });

  it('lists custom scripts in a "Custom scripts" optgroup', async () => {
    api.schedules.listBuiltInActions.mockResolvedValue([]);
    api.schedules.listScripts.mockResolvedValue(['example.sh', 'my-thing.sh']);

    render(
      <NewScheduleModal
        projectDir="/test/project"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    await waitFor(() => {
      const select = screen.getByTestId('new-schedule-action-select');
      expect(select.innerHTML).toContain('example.sh');
      expect(select.innerHTML).toContain('my-thing.sh');
    });
  });

  it('lists built-in actions in a "Built-in" optgroup', async () => {
    api.schedules.listBuiltInActions.mockResolvedValue([SAMPLE_BUILTIN]);
    api.schedules.listScripts.mockResolvedValue([]);

    render(
      <NewScheduleModal
        projectDir="/test/project"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    await waitFor(() => {
      const select = screen.getByTestId('new-schedule-action-select');
      expect(select.innerHTML).toContain('Sample built-in');
    });
  });

  it('shows RunScriptConfig description when a custom script is selected', async () => {
    api.schedules.listBuiltInActions.mockResolvedValue([]);
    api.schedules.listScripts.mockResolvedValue(['triage.sh']);

    render(
      <NewScheduleModal
        projectDir="/test/project"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    // triage.sh is auto-selected; RunScriptConfig should render
    await waitFor(() => {
      const config = screen.getByTestId('run-script-config');
      expect(config).toBeTruthy();
      expect(config.textContent).toContain('triage.sh');
    });
  });

  it('shows built-in description when a built-in action is selected', async () => {
    api.schedules.listBuiltInActions.mockResolvedValue([SAMPLE_BUILTIN]);
    api.schedules.listScripts.mockResolvedValue([]);

    render(
      <NewScheduleModal
        projectDir="/test/project"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('builtin-description')).toBeTruthy();
      expect(screen.getByText('Does something useful on a schedule.')).toBeTruthy();
    });
  });

  it('switching from built-in to custom script swaps the config area', async () => {
    api.schedules.listBuiltInActions.mockResolvedValue([SAMPLE_BUILTIN]);
    api.schedules.listScripts.mockResolvedValue(['triage.sh']);

    render(
      <NewScheduleModal
        projectDir="/test/project"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    // Wait for load; built-in auto-selected first
    await waitFor(() => screen.getByTestId('builtin-description'));

    // Switch to the custom script
    const select = screen.getByTestId('new-schedule-action-select');
    fireEvent.change(select, { target: { value: 'script:triage.sh' } });

    await waitFor(() => {
      expect(screen.queryByTestId('builtin-description')).toBeNull();
      expect(screen.getByTestId('run-script-config')).toBeTruthy();
    });
  });

  it('dispatches run-script action when a custom script is saved', async () => {
    api.schedules.listBuiltInActions.mockResolvedValue([]);
    api.schedules.listScripts.mockResolvedValue(['triage.sh']);
    api.schedules.create.mockResolvedValue({
      id: 'sch_new',
      cronExpression: '0 9 * * *',
      action: { kind: 'run-script', scriptName: 'triage.sh' },
      enabled: true,
      createdAt: '',
      updatedAt: '',
    });

    render(
      <NewScheduleModal
        projectDir="/test/project"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    // Wait for scripts to load and triage.sh to be auto-selected
    await waitFor(() => screen.getByTestId('run-script-config'));

    fireEvent.change(screen.getByTestId('new-schedule-cron'), {
      target: { value: '0 9 * * *' },
    });
    fireEvent.change(screen.getByTestId('new-schedule-label'), {
      target: { value: 'Morning triage' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('new-schedule-save-btn'));
    });

    await waitFor(() => {
      expect(api.schedules.create).toHaveBeenCalledWith('/test/project', {
        label: 'Morning triage',
        cronExpression: '0 9 * * *',
        action: { kind: 'run-script', scriptName: 'triage.sh' },
        enabled: true,
      });
      expect(onCreated).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('dispatches built-in defaultAction when a built-in is saved', async () => {
    api.schedules.listBuiltInActions.mockResolvedValue([SAMPLE_BUILTIN]);
    api.schedules.listScripts.mockResolvedValue([]);
    api.schedules.create.mockResolvedValue({
      id: 'sch_new',
      cronExpression: '0 * * * *',
      action: SAMPLE_BUILTIN.defaultAction,
      enabled: true,
      createdAt: '',
      updatedAt: '',
    });

    render(
      <NewScheduleModal
        projectDir="/test/project"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    await waitFor(() => screen.getByTestId('builtin-description'));

    fireEvent.change(screen.getByTestId('new-schedule-cron'), {
      target: { value: '0 * * * *' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('new-schedule-save-btn'));
    });

    await waitFor(() => {
      expect(api.schedules.create).toHaveBeenCalledWith('/test/project', {
        label: undefined,
        cronExpression: '0 * * * *',
        action: SAMPLE_BUILTIN.defaultAction,
        enabled: true,
      });
    });
  });

  it('shows validation error when cron is missing', async () => {
    api.schedules.listBuiltInActions.mockResolvedValue([]);
    api.schedules.listScripts.mockResolvedValue(['triage.sh']);

    render(
      <NewScheduleModal
        projectDir="/test/project"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    await waitFor(() => screen.getByTestId('run-script-config'));

    fireEvent.click(screen.getByTestId('new-schedule-save-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('new-schedule-error')).toBeTruthy();
      expect(screen.getByText('Cron expression is required')).toBeTruthy();
    });

    expect(api.schedules.create).not.toHaveBeenCalled();
  });

  it('shows validation error for invalid cron expression', async () => {
    api.schedules.listBuiltInActions.mockResolvedValue([]);
    api.schedules.listScripts.mockResolvedValue(['triage.sh']);

    render(
      <NewScheduleModal
        projectDir="/test/project"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    await waitFor(() => screen.getByTestId('run-script-config'));

    fireEvent.change(screen.getByTestId('new-schedule-cron'), {
      target: { value: 'not-valid-cron' },
    });
    fireEvent.click(screen.getByTestId('new-schedule-save-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('new-schedule-error')).toBeTruthy();
    });

    expect(api.schedules.create).not.toHaveBeenCalled();
  });

  it('shows cron preview for valid expression', async () => {
    api.schedules.listBuiltInActions.mockResolvedValue([]);
    api.schedules.listScripts.mockResolvedValue(['triage.sh']);

    render(
      <NewScheduleModal
        projectDir="/test/project"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    fireEvent.change(screen.getByTestId('new-schedule-cron'), {
      target: { value: '*/5 * * * *' },
    });

    await waitFor(() => {
      expect(screen.getByTestId('new-schedule-cron-preview')).toBeTruthy();
      expect(screen.getByTestId('new-schedule-cron-preview').textContent).toContain('Every 5 minutes');
    });
  });

  it('calls onClose when the close button is clicked', async () => {
    api.schedules.listBuiltInActions.mockResolvedValue([]);
    api.schedules.listScripts.mockResolvedValue([]);

    render(
      <NewScheduleModal
        projectDir="/test/project"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    fireEvent.click(screen.getByTestId('new-schedule-modal-close'));

    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when clicking the backdrop', async () => {
    api.schedules.listBuiltInActions.mockResolvedValue([]);
    api.schedules.listScripts.mockResolvedValue([]);

    render(
      <NewScheduleModal
        projectDir="/test/project"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    fireEvent.click(screen.getByTestId('new-schedule-modal'));

    expect(onClose).toHaveBeenCalled();
  });

  it('shows error when create API call fails', async () => {
    api.schedules.listBuiltInActions.mockResolvedValue([]);
    api.schedules.listScripts.mockResolvedValue(['triage.sh']);
    api.schedules.create.mockRejectedValue(new Error('Server error'));

    render(
      <NewScheduleModal
        projectDir="/test/project"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    await waitFor(() => screen.getByTestId('run-script-config'));

    fireEvent.change(screen.getByTestId('new-schedule-cron'), {
      target: { value: '0 * * * *' },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('new-schedule-save-btn'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('new-schedule-error')).toBeTruthy();
      expect(screen.getByText('Server error')).toBeTruthy();
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls listScripts with the correct projectDir', async () => {
    api.schedules.listBuiltInActions.mockResolvedValue([]);
    api.schedules.listScripts.mockResolvedValue([]);

    render(
      <NewScheduleModal
        projectDir="/my/custom/project"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    await waitFor(() => {
      expect(api.schedules.listScripts).toHaveBeenCalledWith('/my/custom/project');
    });
  });
});
