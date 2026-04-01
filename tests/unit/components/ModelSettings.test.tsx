/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelSettingsModal } from '../../../src/renderer/components/ModelSettings';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

describe('ModelSettingsModal', () => {
  let api: ReturnType<typeof mockSandstormApi>;

  beforeEach(() => {
    api = mockSandstormApi();
    useAppStore.setState({
      projects: [],
      activeProjectId: null,
      showModelSettings: true,
      globalModelSettings: { inner_model: 'sonnet', outer_model: 'opus' },
    });
  });

  it('renders the modal with title', () => {
    render(<ModelSettingsModal />);
    expect(screen.getByText('Model Settings')).toBeDefined();
  });

  it('shows global and project tabs', () => {
    render(<ModelSettingsModal />);
    expect(screen.getByTestId('model-settings-tab-global')).toBeDefined();
    expect(screen.getByTestId('model-settings-tab-project')).toBeDefined();
  });

  it('defaults to global tab when no project is active', () => {
    render(<ModelSettingsModal />);
    // Global inner model buttons should be visible
    expect(screen.getByTestId('global-inner-auto')).toBeDefined();
    expect(screen.getByTestId('global-inner-sonnet')).toBeDefined();
    expect(screen.getByTestId('global-inner-opus')).toBeDefined();
  });

  it('disables project tab when no project is active', () => {
    render(<ModelSettingsModal />);
    const projectTab = screen.getByTestId('model-settings-tab-project');
    expect(projectTab.hasAttribute('disabled')).toBe(true);
  });

  it('closes when close button is clicked', () => {
    render(<ModelSettingsModal />);
    fireEvent.click(screen.getByTestId('model-settings-close'));
    expect(useAppStore.getState().showModelSettings).toBe(false);
  });

  it('closes when backdrop is clicked', () => {
    const { container } = render(<ModelSettingsModal />);
    const backdrop = container.firstChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(useAppStore.getState().showModelSettings).toBe(false);
  });

  it('enables save button when global settings change', () => {
    render(<ModelSettingsModal />);
    const saveBtn = screen.getByTestId('model-settings-save');
    expect(saveBtn.hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByTestId('global-inner-opus'));
    expect(saveBtn.hasAttribute('disabled')).toBe(false);
  });

  it('calls setGlobal when saving global settings', async () => {
    render(<ModelSettingsModal />);

    fireEvent.click(screen.getByTestId('global-inner-opus'));
    fireEvent.click(screen.getByTestId('model-settings-save'));

    await waitFor(() => {
      expect(api.modelSettings.setGlobal).toHaveBeenCalledWith({
        inner_model: 'opus',
        outer_model: 'opus',
      });
    });
  });

  it('shows outer model options on global tab', () => {
    render(<ModelSettingsModal />);
    expect(screen.getByTestId('global-outer-sonnet')).toBeDefined();
    expect(screen.getByTestId('global-outer-opus')).toBeDefined();
  });

  describe('with active project', () => {
    beforeEach(() => {
      useAppStore.setState({
        projects: [{ id: 1, name: 'myapp', directory: '/myapp', added_at: '' }],
        activeProjectId: 1,
      });
    });

    it('defaults to project tab when project is active', async () => {
      render(<ModelSettingsModal />);
      // Wait for project settings to load
      await waitFor(() => {
        expect(screen.getByTestId('project-inner-global')).toBeDefined();
      });
    });

    it('shows effective model summary', async () => {
      render(<ModelSettingsModal />);

      await waitFor(() => {
        expect(screen.getByTestId('effective-inner')).toBeDefined();
        expect(screen.getByTestId('effective-outer')).toBeDefined();
      });
    });

    it('shows "Use Global Default" option for project overrides', async () => {
      render(<ModelSettingsModal />);
      await waitFor(() => {
        expect(screen.getByTestId('project-inner-global')).toBeDefined();
        expect(screen.getByTestId('project-outer-global')).toBeDefined();
      });
    });

    it('calls setProject when saving project settings', async () => {
      render(<ModelSettingsModal />);

      await waitFor(() => {
        expect(screen.getByTestId('project-inner-opus')).toBeDefined();
      });

      fireEvent.click(screen.getByTestId('project-inner-opus'));
      fireEvent.click(screen.getByTestId('model-settings-save'));

      await waitFor(() => {
        expect(api.modelSettings.setProject).toHaveBeenCalledWith(
          '/myapp',
          { inner_model: 'opus', outer_model: 'global' },
        );
      });
    });
  });
});
