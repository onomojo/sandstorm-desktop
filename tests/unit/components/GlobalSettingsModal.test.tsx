/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GlobalSettingsModal } from '../../../src/renderer/components/GlobalSettingsModal';
import { mockSandstormApi } from './setup';

describe('GlobalSettingsModal', () => {
  let api: ReturnType<typeof mockSandstormApi>;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    api = mockSandstormApi();
    onClose = vi.fn();
  });

  // ── Rendering ─────────────────────────────────────────────────────────────

  it('renders the settings modal', async () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeDefined();
    });
  });

  it('renders model-settings-close button', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    expect(screen.getByTestId('model-settings-close')).toBeDefined();
  });

  it('renders model-settings-tab-global tab', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    expect(screen.getByTestId('model-settings-tab-global')).toBeDefined();
  });

  it('renders model-settings-tab-project tab (disabled)', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    const projectTab = screen.getByTestId('model-settings-tab-project') as HTMLButtonElement;
    expect(projectTab).toBeDefined();
    expect(projectTab.disabled).toBe(true);
  });

  it('renders model-settings-tab-ticketing tab (disabled)', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    const ticketingTab = screen.getByTestId('model-settings-tab-ticketing') as HTMLButtonElement;
    expect(ticketingTab).toBeDefined();
    expect(ticketingTab.disabled).toBe(true);
  });

  it('renders inner backend buttons', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    expect(screen.getByTestId('global-inner-backend-claude')).toBeDefined();
    expect(screen.getByTestId('global-inner-backend-opencode')).toBeDefined();
  });

  it('renders outer backend buttons', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    expect(screen.getByTestId('global-outer-backend-claude')).toBeDefined();
    expect(screen.getByTestId('global-outer-backend-opencode')).toBeDefined();
  });

  // ── Close behavior ────────────────────────────────────────────────────────

  it('calls onClose when close button is clicked', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByTestId('model-settings-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const { container } = render(<GlobalSettingsModal onClose={onClose} />);
    const backdrop = container.firstChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Backend switching ─────────────────────────────────────────────────────

  it('inner opencode-fields are hidden when inner backend is claude', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    expect(screen.queryByTestId('global-inner-backend-opencode-fields')).toBeNull();
  });

  it('inner opencode-fields appear when inner backend is switched to opencode', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByTestId('global-inner-backend-opencode'));
    expect(screen.getByTestId('global-inner-backend-opencode-fields')).toBeDefined();
  });

  it('inner opencode-fields disappear when switching back to claude', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByTestId('global-inner-backend-opencode'));
    expect(screen.getByTestId('global-inner-backend-opencode-fields')).toBeDefined();
    fireEvent.click(screen.getByTestId('global-inner-backend-claude'));
    expect(screen.queryByTestId('global-inner-backend-opencode-fields')).toBeNull();
  });

  it('inner provider select is visible when opencode is selected', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByTestId('global-inner-backend-opencode'));
    expect(screen.getByTestId('global-inner-backend-provider')).toBeDefined();
  });

  it('inner model input is visible when opencode is selected', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByTestId('global-inner-backend-opencode'));
    expect(screen.getByTestId('global-inner-backend-model')).toBeDefined();
  });

  it('inner cred-fields are visible when opencode is selected', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByTestId('global-inner-backend-opencode'));
    expect(screen.getByTestId('global-inner-backend-cred-fields')).toBeDefined();
  });

  it('outer opencode-fields appear when outer backend is switched to opencode', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByTestId('global-outer-backend-opencode'));
    expect(screen.getByTestId('global-outer-backend-opencode-fields')).toBeDefined();
  });

  // ── Provider options ──────────────────────────────────────────────────────

  it('provider select includes anthropic option', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByTestId('global-inner-backend-opencode'));
    const select = screen.getByTestId('global-inner-backend-provider');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options.join(' ')).toMatch(/anthropic/i);
  });

  it('provider select includes amazon-bedrock option', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByTestId('global-inner-backend-opencode'));
    const select = screen.getByTestId('global-inner-backend-provider');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options.join(' ')).toMatch(/amazon.?bedrock/i);
  });

  it('provider select includes ollama option', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByTestId('global-inner-backend-opencode'));
    const select = screen.getByTestId('global-inner-backend-provider');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options.join(' ')).toMatch(/ollama/i);
  });

  // ── Data loading ──────────────────────────────────────────────────────────

  it('loads settings from backendSettings.getGlobal on mount', async () => {
    api.backendSettings.getGlobal.mockResolvedValue({
      inner_backend: 'opencode',
      outer_backend: 'claude',
      inner_provider: 'anthropic',
      inner_model: 'claude-3',
      outer_provider: null,
      outer_model: null,
    });
    render(<GlobalSettingsModal onClose={onClose} />);
    await waitFor(() => {
      expect(api.backendSettings.getGlobal).toHaveBeenCalled();
    });
  });

  it('calls secretStatus for both inner and outer on mount', async () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    await waitFor(() => {
      expect(api.backendSettings.secretStatus).toHaveBeenCalledWith('global', 'inner');
      expect(api.backendSettings.secretStatus).toHaveBeenCalledWith('global', 'outer');
    });
  });

  // ── Save behavior ─────────────────────────────────────────────────────────

  it('save button is disabled when not dirty', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    const saveBtn = screen.getByTestId('model-settings-save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('save button becomes enabled after making a change', () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByTestId('global-inner-backend-opencode'));
    const saveBtn = screen.getByTestId('model-settings-save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
  });

  it('clicking save calls backendSettings.setGlobal', async () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByTestId('global-inner-backend-opencode'));
    fireEvent.click(screen.getByTestId('model-settings-save'));
    await waitFor(() => {
      expect(api.backendSettings.setGlobal).toHaveBeenCalled();
    });
  });

  it('successful save calls onClose', async () => {
    render(<GlobalSettingsModal onClose={onClose} />);
    fireEvent.click(screen.getByTestId('global-inner-backend-opencode'));
    fireEvent.click(screen.getByTestId('model-settings-save'));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});
