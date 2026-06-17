/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelSettingsModal } from '../../../src/renderer/components/ModelSettings';
import { useAppStore } from '../../../src/renderer/store';
import { mockSandstormApi } from './setup';

describe('BackendSelector — per-provider credential fields', () => {
  const OPENCODE_GLOBAL_SETTINGS = {
    inner_backend: 'opencode',
    outer_backend: 'claude',
    inner_provider: 'anthropic',
    inner_model: null,
    outer_provider: null,
    outer_model: null,
  };

  beforeEach(() => {
    const api = mockSandstormApi();
    // Override default mock so component doesn't overwrite store with 'claude'
    (api.backendSettings.getGlobal as ReturnType<typeof vi.fn>).mockResolvedValue(OPENCODE_GLOBAL_SETTINGS);
    useAppStore.setState({
      projects: [],
      activeProjectId: null,
      showModelSettings: true,
      globalModelSettings: { inner_model: 'sonnet', outer_model: 'opus' },
      globalBackendSettings: OPENCODE_GLOBAL_SETTINGS,
    });
  });

  it('shows opencode fields when OpenCode backend is selected', async () => {
    render(<ModelSettingsModal />);
    await waitFor(() => {
      expect(screen.getByTestId('global-inner-backend-opencode')).toBeDefined();
    });
    const openCodeFields = screen.getByTestId('global-inner-backend-opencode-fields');
    expect(openCodeFields).toBeDefined();
  });

  it('renders provider selector from PROVIDER_METADATA (anthropic, amazon-bedrock, ollama)', async () => {
    render(<ModelSettingsModal />);
    await waitFor(() => {
      expect(screen.getByTestId('global-inner-backend-provider')).toBeDefined();
    });
    const select = screen.getByTestId('global-inner-backend-provider') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain('anthropic');
    expect(options).toContain('amazon-bedrock');
    expect(options).toContain('ollama');
  });

  it('renders apiKey field for anthropic provider', async () => {
    render(<ModelSettingsModal />);
    await waitFor(() => {
      // anthropic has one field: apiKey
      expect(screen.getByTestId('global-inner-backend-cred-apiKey')).toBeDefined();
    });
    const input = screen.getByTestId('global-inner-backend-cred-apiKey') as HTMLInputElement;
    expect(input.type).toBe('password');
  });

  it('switching to amazon-bedrock shows region and credential fields', async () => {
    render(<ModelSettingsModal />);
    await waitFor(() => {
      expect(screen.getByTestId('global-inner-backend-provider')).toBeDefined();
    });
    // Switch provider to amazon-bedrock
    fireEvent.change(screen.getByTestId('global-inner-backend-provider'), {
      target: { value: 'amazon-bedrock' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('global-inner-backend-cred-region')).toBeDefined();
    });
    expect(screen.getByTestId('global-inner-backend-cred-accessKeyId')).toBeDefined();
    expect(screen.getByTestId('global-inner-backend-cred-secretAccessKey')).toBeDefined();
    expect(screen.getByTestId('global-inner-backend-cred-bearerToken')).toBeDefined();
    expect(screen.getByTestId('global-inner-backend-cred-profile')).toBeDefined();
  });

  it('switching to ollama shows baseUrl field', async () => {
    render(<ModelSettingsModal />);
    await waitFor(() => {
      expect(screen.getByTestId('global-inner-backend-provider')).toBeDefined();
    });
    fireEvent.change(screen.getByTestId('global-inner-backend-provider'), {
      target: { value: 'ollama' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('global-inner-backend-cred-baseUrl')).toBeDefined();
    });
    const input = screen.getByTestId('global-inner-backend-cred-baseUrl') as HTMLInputElement;
    expect(input.type).toBe('text');
  });

  it('switching provider clears the credential bundle', async () => {
    render(<ModelSettingsModal />);
    await waitFor(() => {
      expect(screen.getByTestId('global-inner-backend-cred-apiKey')).toBeDefined();
    });
    // Type an API key
    fireEvent.change(screen.getByTestId('global-inner-backend-cred-apiKey'), {
      target: { value: 'sk-test' },
    });
    // Switch provider
    fireEvent.change(screen.getByTestId('global-inner-backend-provider'), {
      target: { value: 'ollama' },
    });
    await waitFor(() => {
      const baseUrl = screen.getByTestId('global-inner-backend-cred-baseUrl') as HTMLInputElement;
      // Bundle was cleared on provider switch — baseUrl starts empty
      expect(baseUrl.value).toBe('');
    });
  });

  it('hides credential fields when Claude Code backend is selected', async () => {
    // Reset mock to default (claude) to override beforeEach's opencode mock
    mockSandstormApi();
    useAppStore.setState({
      globalBackendSettings: {
        inner_backend: 'claude',
        outer_backend: 'claude',
        inner_provider: null,
        inner_model: null,
        outer_provider: null,
        outer_model: null,
      },
    });
    render(<ModelSettingsModal />);
    await waitFor(() => {
      expect(screen.getByTestId('global-inner-backend-claude')).toBeDefined();
    });
    // OpenCode fields not rendered
    expect(screen.queryByTestId('global-inner-backend-opencode-fields')).toBeNull();
  });

  it('shows (Set) cred status when credSet is true', async () => {
    // Mock secretStatus to return set: true, keep getGlobal returning opencode settings
    const api = mockSandstormApi();
    (api.backendSettings.getGlobal as ReturnType<typeof vi.fn>).mockResolvedValue(OPENCODE_GLOBAL_SETTINGS);
    (api.backendSettings.secretStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ set: true });
    render(<ModelSettingsModal />);
    await waitFor(() => {
      const status = screen.getByTestId('global-inner-backend-cred-status');
      expect(status.textContent).toContain('(Set)');
    });
  });
});
