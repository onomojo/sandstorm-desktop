/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';

afterEach(cleanup);

import { buildProvidersPane } from '../../../src/renderer/components/config/ProvidersPane';
import type { ConfigPaneContext, ProviderSecretsApi } from '../../../src/renderer/components/config/types';

const MOCK_CATALOG = {
  all: [
    { id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'], models: {} },
    { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'], models: {} },
    { id: 'ollama', name: 'Ollama', env: [], models: {} },
  ],
  default: {},
  connected: [],
};

function setupWindowSandstorm(opts: {
  configuredIds?: string[];
  catalog?: typeof MOCK_CATALOG | null;
} = {}) {
  const configuredIds = opts.configuredIds ?? [];
  const catalog = opts.catalog !== undefined ? opts.catalog : MOCK_CATALOG;
  (window as unknown as Record<string, unknown>).sandstorm = {
    providers: {
      configured: vi.fn().mockResolvedValue(configuredIds),
      catalog: vi.fn().mockResolvedValue(catalog),
    },
  };
}

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
  beforeEach(() => {
    setupWindowSandstorm();
  });

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

  it('shows empty-state prompt when no providers are configured', async () => {
    setupWindowSandstorm({ configuredIds: [] });
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      expect(screen.getByTestId('providers-empty-prompt')).toBeDefined();
    });
  });

  it('does not show empty-state prompt when at least one provider is configured', async () => {
    setupWindowSandstorm({ configuredIds: ['anthropic'] });
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      expect(screen.queryByTestId('providers-empty-prompt')).toBeNull();
    });
  });

  it('renders a card for each configured provider', async () => {
    setupWindowSandstorm({ configuredIds: ['anthropic', 'openai'] });
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      expect(screen.getByTestId('provider-card-anthropic')).toBeDefined();
      expect(screen.getByTestId('provider-card-openai')).toBeDefined();
    });
  });

  it('shows "Configured" status badge for each configured provider', async () => {
    setupWindowSandstorm({ configuredIds: ['anthropic'] });
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      expect(screen.getByTestId('provider-status-anthropic').textContent).toBe('Configured');
    });
  });

  it('shows green status dot for configured providers', async () => {
    setupWindowSandstorm({ configuredIds: ['anthropic'] });
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      const dot = screen.getByTestId('provider-status-dot-anthropic');
      expect(dot.className).toContain('bg-green-500');
    });
  });

  it('shows Add provider button', async () => {
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      expect(screen.getByTestId('add-provider-button')).toBeDefined();
    });
  });

  it('clicking Add provider opens catalog picker', async () => {
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('add-provider-button'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-provider-button'));
    });
    expect(screen.getByTestId('catalog-picker')).toBeDefined();
    expect(screen.getByTestId('catalog-search')).toBeDefined();
  });

  it('catalog picker lists providers from catalog not yet configured', async () => {
    setupWindowSandstorm({ configuredIds: ['anthropic'] });
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('add-provider-button'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-provider-button'));
    });
    await waitFor(() => {
      // anthropic is configured, so it should NOT appear in catalog picker
      expect(screen.queryByTestId('catalog-provider-anthropic')).toBeNull();
      // openai is not configured, so it SHOULD appear
      expect(screen.getByTestId('catalog-provider-openai')).toBeDefined();
    });
  });

  it('catalog picker search filters providers by name/id', async () => {
    setupWindowSandstorm({ configuredIds: [] });
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('add-provider-button'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-provider-button'));
    });
    await waitFor(() => screen.getByTestId('catalog-search'));
    await act(async () => {
      fireEvent.change(screen.getByTestId('catalog-search'), {
        target: { value: 'openai' },
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('catalog-provider-openai')).toBeDefined();
      expect(screen.queryByTestId('catalog-provider-anthropic')).toBeNull();
    });
  });

  it('selecting catalog provider closes picker and opens form', async () => {
    setupWindowSandstorm({ configuredIds: [] });
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('add-provider-button'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-provider-button'));
    });
    await waitFor(() => screen.getByTestId('catalog-provider-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-provider-anthropic'));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('catalog-picker')).toBeNull();
      expect(screen.getByTestId('provider-form-anthropic')).toBeDefined();
    });
  });

  it('clicking expand button on configured provider shows Edit form', async () => {
    setupWindowSandstorm({ configuredIds: ['anthropic'] });
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
    setupWindowSandstorm({ configuredIds: ['anthropic'] });
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

  it('Edit form shows field inputs for the provider', async () => {
    setupWindowSandstorm({ configuredIds: ['anthropic'] });
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-expand-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-expand-anthropic'));
    });
    expect(screen.getByTestId('provider-field-anthropic-apiKey')).toBeDefined();
  });

  it('password-type fields use type="password"', async () => {
    setupWindowSandstorm({ configuredIds: ['anthropic'] });
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

  it('save calls setBundle with scope and provider id and bundle', async () => {
    setupWindowSandstorm({ configuredIds: ['anthropic'] });
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

  it('save for a new catalog provider stores credentials and shows card', async () => {
    setupWindowSandstorm({ configuredIds: [] });
    const setBundle = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ setBundle });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    // Open catalog picker
    await waitFor(() => screen.getByTestId('add-provider-button'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-provider-button'));
    });
    // Select anthropic from catalog
    await waitFor(() => screen.getByTestId('catalog-provider-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-provider-anthropic'));
    });
    // Fill the form
    await waitFor(() => screen.getByTestId('provider-form-anthropic'));
    await act(async () => {
      fireEvent.change(screen.getByTestId('provider-field-anthropic-apiKey'), {
        target: { value: 'sk-ant-new' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-save-anthropic'));
    });
    await waitFor(() => {
      expect(setBundle).toHaveBeenCalledWith('/test/project', 'anthropic', { apiKey: 'sk-ant-new' });
      // Card should now be visible as configured
      expect(screen.getByTestId('provider-card-anthropic')).toBeDefined();
    });
  });

  it('Remove button is shown for configured providers', async () => {
    setupWindowSandstorm({ configuredIds: ['anthropic'] });
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      expect(screen.getByTestId('provider-remove-anthropic')).toBeDefined();
    });
  });

  it('remove calls providerSecrets.remove with scope and provider id', async () => {
    setupWindowSandstorm({ configuredIds: ['anthropic'] });
    const remove = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ remove });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-remove-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-remove-anthropic'));
    });
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith('/test/project', 'anthropic');
    });
  });

  it('remove hides the provider card', async () => {
    setupWindowSandstorm({ configuredIds: ['anthropic'] });
    const remove = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ remove });
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-card-anthropic'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-remove-anthropic'));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('provider-card-anthropic')).toBeNull();
    });
  });

  it('raw secret values are never rendered in the DOM', async () => {
    setupWindowSandstorm({ configuredIds: ['anthropic'] });
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('providers-pane'));
    expect(screen.queryByText('sk-ant-secret-value')).toBeNull();
    expect(screen.queryByText('AKIAIOSFODNN7EXAMPLE')).toBeNull();
  });

  it('project switch re-fetches configured providers with new scope', async () => {
    const configuredFn = vi.fn().mockResolvedValue([]);
    (window as unknown as Record<string, unknown>).sandstorm = {
      providers: {
        configured: configuredFn,
        catalog: vi.fn().mockResolvedValue(MOCK_CATALOG),
      },
    };
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    const { rerender } = render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('providers-pane'));

    const callCountAfterFirst = configuredFn.mock.calls.length;

    const ctx2 = { ...ctx, projectDir: '/other/project' };
    const pane2 = buildProvidersPane(ctx2);
    rerender(<>{pane2.render()}</>);

    await waitFor(() => {
      expect(configuredFn.mock.calls.length).toBeGreaterThan(callCountAfterFirst);
      const newCalls = configuredFn.mock.calls.slice(callCountAfterFirst);
      expect(newCalls.some((call) => call[0] === '/other/project')).toBe(true);
    });
  });

  it('shows routing warning when removed provider is routed to touchpoints', async () => {
    setupWindowSandstorm({ configuredIds: ['anthropic'] });
    const remove = vi.fn().mockResolvedValue(undefined);
    const getEffective = vi.fn().mockResolvedValue({
      outer: { backend: 'claude', provider: 'anthropic', model: 'opus' },
      execution: { backend: 'claude', provider: 'anthropic', model: 'sonnet' },
    });
    const ctx = makeCtx({ remove });
    ctx.routing.getEffective = getEffective;
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
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

  it('no cross-project bleed: configured IDs are project-specific', async () => {
    const configuredFn = vi.fn()
      .mockImplementation((scope: string) => {
        if (scope === '/test/project') return Promise.resolve([]);
        if (scope === '/other/project') return Promise.resolve(['anthropic']);
        return Promise.resolve([]);
      });
    (window as unknown as Record<string, unknown>).sandstorm = {
      providers: {
        configured: configuredFn,
        catalog: vi.fn().mockResolvedValue(MOCK_CATALOG),
      },
    };
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('providers-pane'));

    // No cards for project1 (none configured)
    expect(screen.queryByTestId('provider-card-anthropic')).toBeNull();

    // Switch to project2
    const ctx2 = { ...ctx, projectDir: '/other/project' };
    const pane2 = buildProvidersPane(ctx2);
    const { rerender } = render(<>{pane2.render()}</>);
    rerender(<>{pane2.render()}</>);

    await waitFor(() => {
      expect(screen.getByTestId('provider-card-anthropic')).toBeDefined();
      expect(screen.getByTestId('provider-status-anthropic').textContent).toBe('Configured');
    });
  });

  it('derives fields from catalog env[] for non-well-known providers', async () => {
    const catalogWithCustom = {
      ...MOCK_CATALOG,
      all: [
        ...MOCK_CATALOG.all,
        { id: 'custom-llm', name: 'Custom LLM', env: ['CUSTOM_LLM_API_KEY', 'CUSTOM_LLM_BASE_URL'], models: {} },
      ],
    };
    setupWindowSandstorm({ configuredIds: [], catalog: catalogWithCustom });
    const ctx = makeCtx();
    const pane = buildProvidersPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('add-provider-button'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-provider-button'));
    });
    await waitFor(() => screen.getByTestId('catalog-provider-custom-llm'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-provider-custom-llm'));
    });
    // Fields should be derived: apiKey (password) and baseUrl (url)
    await waitFor(() => {
      expect(screen.getByTestId('provider-form-custom-llm')).toBeDefined();
    });
  });
});
