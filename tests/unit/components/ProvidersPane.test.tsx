/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';

afterEach(cleanup);

import { buildProvidersPane } from '../../../src/renderer/components/config/ProvidersPane';
import { PROVIDER_METADATA } from '../../../src/shared/opencode-providers';
import type { ConfigPaneContext, ProviderSecretsApi } from '../../../src/renderer/components/config/types';

function makeProviderSecrets(overrides: Partial<ProviderSecretsApi> = {}): ProviderSecretsApi {
  return {
    status: vi.fn().mockResolvedValue({ set: false }),
    setBundle: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeCtx(providerSecretsOverrides: Partial<ProviderSecretsApi> = {}): ConfigPaneContext {
  return {
    projectDir: '/test/project',
    routing: {
      getEffective: vi.fn().mockResolvedValue({}),
      getProject: vi.fn().mockResolvedValue(null),
      setProject: vi.fn().mockResolvedValue(undefined),
      removeProject: vi.fn().mockResolvedValue(undefined),
      getGlobal: vi.fn().mockResolvedValue({ assignments: {}, preset: null }),
      setGlobal: vi.fn().mockResolvedValue(undefined),
      applyPreset: vi.fn().mockResolvedValue(undefined),
      getAvailableModels: vi.fn().mockResolvedValue([]),
    },
    darkFactory: {
      getConfig: vi.fn().mockResolvedValue({ level: 'manual', merge_strategy: 'squash' }),
      setConfig: vi.fn().mockResolvedValue(undefined),
    },
    ticketing: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    providerSecrets: makeProviderSecrets(providerSecretsOverrides),
    onDirtyChange: vi.fn(),
    registerSave: vi.fn(),
  };
}

describe('ProvidersPane', () => {
  it('renders the providers-pane testid', async () => {
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => expect(screen.getByTestId('providers-pane')).toBeDefined());
  });

  it('pane has id providers and label Providers', () => {
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    expect(pane.id).toBe('providers');
    expect(pane.label).toBe('Providers');
  });

  it('renders a card for each provider in PROVIDER_METADATA', async () => {
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      for (const provider of PROVIDER_METADATA) {
        expect(screen.getByTestId(`provider-card-${provider.id}`)).toBeDefined();
      }
    });
  });

  it('shows "Not configured" status for all providers when none are set', async () => {
    const ctx = makeCtx({ status: vi.fn().mockResolvedValue({ set: false }) });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      for (const provider of PROVIDER_METADATA) {
        const statusEl = screen.getByTestId(`provider-status-${provider.id}`);
        expect(statusEl.textContent).toBe('Not configured');
      }
    });
  });

  it('shows "Configured" status for a provider that is set', async () => {
    const status = vi.fn().mockImplementation((_scope: string, provider: string) =>
      Promise.resolve({ set: provider === 'anthropic' })
    );
    const ctx = makeCtx({ status });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      expect(screen.getByTestId('provider-status-anthropic').textContent).toBe('Configured');
      expect(screen.getByTestId('provider-status-ollama').textContent).toBe('Not configured');
    });
  });

  it('calls status with projectDir and provider id', async () => {
    const status = vi.fn().mockResolvedValue({ set: false });
    const ctx = makeCtx({ status });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      for (const provider of PROVIDER_METADATA) {
        expect(status).toHaveBeenCalledWith('/test/project', provider.id);
      }
    });
  });

  it('shows empty-state prompt when all providers are not configured', async () => {
    const ctx = makeCtx({ status: vi.fn().mockResolvedValue({ set: false }) });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      expect(screen.getByTestId('providers-empty-prompt')).toBeDefined();
    });
  });

  it('does not show empty-state prompt when at least one provider is configured', async () => {
    const status = vi.fn().mockImplementation((_scope: string, provider: string) =>
      Promise.resolve({ set: provider === 'anthropic' })
    );
    const ctx = makeCtx({ status });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-status-anthropic'));
    await waitFor(() => {
      expect(screen.queryByTestId('providers-empty-prompt')).toBeNull();
    });
  });

  it('expand button shows "Configure" for unconfigured provider', async () => {
    const ctx = makeCtx({ status: vi.fn().mockResolvedValue({ set: false }) });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      const btn = screen.getByTestId('provider-expand-anthropic');
      expect(btn.textContent).toBe('Configure');
    });
  });

  it('expand button shows "Edit" for configured provider', async () => {
    const ctx = makeCtx({
      status: vi.fn().mockImplementation((_scope: string, provider: string) =>
        Promise.resolve({ set: provider === 'anthropic' })
      ),
    });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      expect(screen.getByTestId('provider-expand-anthropic').textContent).toBe('Edit');
    });
  });

  it('clicking expand button shows the provider form', async () => {
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-expand-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-expand-anthropic'));
    });
    expect(screen.getByTestId('provider-form-anthropic')).toBeDefined();
  });

  it('clicking expand again collapses the form', async () => {
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-expand-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-expand-anthropic'));
    });
    expect(screen.getByTestId('provider-form-anthropic')).toBeDefined();
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-expand-anthropic'));
    });
    expect(screen.queryByTestId('provider-form-anthropic')).toBeNull();
  });

  it('renders field inputs for the expanded provider', async () => {
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-expand-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-expand-anthropic'));
    });
    expect(screen.getByTestId('provider-field-anthropic-apiKey')).toBeDefined();
  });

  it('Ollama form shows Base URL field', async () => {
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-expand-ollama'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-expand-ollama'));
    });
    expect(screen.getByTestId('provider-field-ollama-baseUrl')).toBeDefined();
  });

  it('password-type fields use type="password" so values are never exposed', async () => {
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-expand-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-expand-anthropic'));
    });
    const input = screen.getByTestId('provider-field-anthropic-apiKey') as HTMLInputElement;
    expect(input.type).toBe('password');
  });

  it('required-field validation blocks save when Ollama Base URL is empty', async () => {
    const setBundle = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ setBundle });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-expand-ollama'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-expand-ollama'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-save-ollama'));
    });
    expect(setBundle).not.toHaveBeenCalled();
    expect(screen.getByTestId('provider-error-ollama')).toBeDefined();
    expect(screen.getByTestId('provider-error-ollama').textContent).toContain('Base URL');
  });

  it('save calls setBundle with scope and provider id and bundle', async () => {
    const setBundle = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ setBundle });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-expand-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-expand-anthropic'));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('provider-field-anthropic-apiKey'), {
        target: { value: 'sk-ant-test123' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-save-anthropic'));
    });
    await waitFor(() => {
      expect(setBundle).toHaveBeenCalledWith('/test/project', 'anthropic', {
        apiKey: 'sk-ant-test123',
      });
    });
  });

  it('save for Ollama with Base URL calls setBundle correctly', async () => {
    const setBundle = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ setBundle });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-expand-ollama'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-expand-ollama'));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('provider-field-ollama-baseUrl'), {
        target: { value: 'http://localhost:11434/v1' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-save-ollama'));
    });
    await waitFor(() => {
      expect(setBundle).toHaveBeenCalledWith('/test/project', 'ollama', {
        baseUrl: 'http://localhost:11434/v1',
      });
    });
  });

  it('successful save collapses the form and updates status to Configured', async () => {
    const setBundle = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ setBundle });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-expand-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-expand-anthropic'));
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('provider-field-anthropic-apiKey'), {
        target: { value: 'sk-ant-test123' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-save-anthropic'));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('provider-form-anthropic')).toBeNull();
      expect(screen.getByTestId('provider-status-anthropic').textContent).toBe('Configured');
    });
  });

  it('Remove button is not shown when provider is not configured', async () => {
    const ctx = makeCtx({ status: vi.fn().mockResolvedValue({ set: false }) });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-expand-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-expand-anthropic'));
    });
    expect(screen.queryByTestId('provider-remove-anthropic')).toBeNull();
  });

  it('Remove button is shown when provider is configured', async () => {
    const status = vi.fn().mockImplementation((_scope: string, provider: string) =>
      Promise.resolve({ set: provider === 'anthropic' })
    );
    const ctx = makeCtx({ status });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-status-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-expand-anthropic'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('provider-remove-anthropic')).toBeDefined();
    });
  });

  it('remove calls providerSecrets.remove with scope and provider id', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const status = vi.fn().mockImplementation((_scope: string, provider: string) =>
      Promise.resolve({ set: provider === 'anthropic' })
    );
    const ctx = makeCtx({ status, remove });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-status-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-expand-anthropic'));
    });
    await waitFor(() => screen.getByTestId('provider-remove-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-remove-anthropic'));
    });
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith('/test/project', 'anthropic');
    });
  });

  it('remove updates status to Not configured', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const status = vi.fn().mockImplementation((_scope: string, provider: string) =>
      Promise.resolve({ set: provider === 'anthropic' })
    );
    const ctx = makeCtx({ status, remove });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-status-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-expand-anthropic'));
    });
    await waitFor(() => screen.getByTestId('provider-remove-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-remove-anthropic'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('provider-status-anthropic').textContent).toBe('Not configured');
    });
  });

  it('raw secret values are never rendered in the DOM', async () => {
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('providers-pane'));
    expect(screen.queryByText('sk-ant-secret-value')).toBeNull();
    expect(screen.queryByText('AKIAIOSFODNN7EXAMPLE')).toBeNull();
  });

  it('project switch re-fetches statuses with new scope', async () => {
    const status = vi.fn().mockResolvedValue({ set: false });
    const ctx = makeCtx({ status });
    const pane = buildProvidersPane(ctx);
    const { rerender } = render(<>{pane.render()}</>);
    await waitFor(() => expect(status).toHaveBeenCalled());

    const callCountAfterFirst = status.mock.calls.length;

    const ctx2 = { ...ctx, projectDir: '/other/project', providerSecrets: { ...ctx.providerSecrets, status } };
    const pane2 = buildProvidersPane(ctx2);
    rerender(<>{pane2.render()}</>);

    await waitFor(() => {
      expect(status.mock.calls.length).toBeGreaterThan(callCountAfterFirst);
      const newCalls = status.mock.calls.slice(callCountAfterFirst);
      expect(newCalls.some((call) => call[0] === '/other/project')).toBe(true);
    });
  });

  it('shows routing warning when removed provider models are routed to touchpoints', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const status = vi.fn().mockImplementation((_scope: string, provider: string) =>
      Promise.resolve({ set: provider === 'anthropic' })
    );
    const getEffective = vi.fn().mockResolvedValue({
      outer: { backend: 'claude', provider: 'anthropic', model: 'opus' },
      execution: { backend: 'claude', provider: 'anthropic', model: 'sonnet' },
    });
    const ctx = makeCtx({ status, remove });
    ctx.routing.getEffective = getEffective;
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-status-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-expand-anthropic'));
    });
    await waitFor(() => screen.getByTestId('provider-remove-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-remove-anthropic'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('provider-remove-warning-anthropic')).toBeDefined();
      const warning = screen.getByTestId('provider-remove-warning-anthropic');
      expect(warning.textContent).toContain('outer');
      expect(warning.textContent).toContain('execution');
    });
  });

  it('no cross-project bleed: second project uses its own scope', async () => {
    const status = vi.fn()
      .mockResolvedValue({ set: false });
    const ctx = makeCtx({ status });
    const pane = buildProvidersPane(ctx);
    const { rerender } = render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('providers-pane'));

    const ctx2 = {
      ...ctx,
      projectDir: '/other/project',
      providerSecrets: makeProviderSecrets({
        status: vi.fn().mockResolvedValue({ set: true }),
      }),
    };
    const pane2 = buildProvidersPane(ctx2);
    rerender(<>{pane2.render()}</>);

    await waitFor(() => {
      for (const provider of PROVIDER_METADATA) {
        expect(screen.getByTestId(`provider-status-${provider.id}`).textContent).toBe('Configured');
      }
    });
  });
});
