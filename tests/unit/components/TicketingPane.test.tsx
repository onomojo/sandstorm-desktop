/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';

afterEach(cleanup);
import { buildTicketingPane } from '../../../src/renderer/components/config/TicketingPane';
import type { ConfigPaneContext, ProjectTicketConfig } from '../../../src/renderer/components/config/types';

function makeCtx(initialConfig: ProjectTicketConfig | null = null): ConfigPaneContext {
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
      get: vi.fn().mockResolvedValue(initialConfig),
      set: vi.fn().mockResolvedValue(undefined),
    },
    onDirtyChange: vi.fn(),
    registerSave: vi.fn(),
  };
}

describe('TicketingPane', () => {
  it('renders the ticketing-pane testid', async () => {
    const ctx = makeCtx();
    const pane = buildTicketingPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => expect(screen.getByTestId('ticketing-pane')).toBeDefined());
  });

  it('pane has id ticketing and label Ticketing', () => {
    const ctx = makeCtx();
    const pane = buildTicketingPane(ctx);
    expect(pane.id).toBe('ticketing');
    expect(pane.label).toBe('Ticketing');
  });

  it('renders both provider tiles', async () => {
    const ctx = makeCtx();
    const pane = buildTicketingPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      expect(screen.getByTestId('provider-tile-github')).toBeDefined();
      expect(screen.getByTestId('provider-tile-jira')).toBeDefined();
    });
  });

  it('defaults to github provider when no config exists', async () => {
    const ctx = makeCtx(null);
    const pane = buildTicketingPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      const githubTile = screen.getByTestId('provider-tile-github');
      expect(githubTile.className).toContain('border-sandstorm-accent');
    });
  });

  it('does not render jira fields when provider is github', async () => {
    const ctx = makeCtx(null);
    const pane = buildTicketingPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('ticketing-pane'));
    expect(screen.queryByTestId('jira-fields')).toBeNull();
  });

  it('shows jira fields when jira tile is selected', async () => {
    const ctx = makeCtx(null);
    const pane = buildTicketingPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-tile-jira'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-tile-jira'));
    });
    expect(screen.getByTestId('jira-fields')).toBeDefined();
    expect(screen.getByTestId('jira-url')).toBeDefined();
    expect(screen.getByTestId('jira-username')).toBeDefined();
    expect(screen.getByTestId('jira-api-token')).toBeDefined();
    expect(screen.getByTestId('jira-project-key')).toBeDefined();
  });

  it('loads jira provider from existing config and shows jira fields', async () => {
    const ctx = makeCtx({
      provider: 'jira',
      jira_url: 'https://test.atlassian.net',
      jira_username: 'user@test.com',
      jira_api_token: 'token123',
      jira_project_key: 'TEST',
    });
    const pane = buildTicketingPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      expect(screen.getByTestId('jira-fields')).toBeDefined();
      const urlInput = screen.getByTestId('jira-url') as HTMLInputElement;
      expect(urlInput.value).toBe('https://test.atlassian.net');
    });
  });

  it('blocks save with Jira provider when required fields are missing', async () => {
    const set = vi.fn();
    const registerSave = vi.fn();
    const ctx = makeCtx(null);
    ctx.ticketing.set = set;
    ctx.registerSave = registerSave;

    const pane = buildTicketingPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-tile-jira'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('provider-tile-jira'));
    });

    const savedFn = registerSave.mock.calls[registerSave.mock.calls.length - 1][0];
    await act(async () => { await savedFn(); });

    expect(set).not.toHaveBeenCalled();
    expect(screen.getByTestId('ticketing-save-error')).toBeDefined();
  });

  it('save calls ticketing.set with the correct shape for github', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const registerSave = vi.fn();
    const ctx = makeCtx(null);
    ctx.ticketing.set = set;
    ctx.registerSave = registerSave;

    const pane = buildTicketingPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('ticket-prefix'));

    await act(async () => {
      fireEvent.change(screen.getByTestId('ticket-prefix'), { target: { value: 'GH' } });
    });

    const savedFn = registerSave.mock.calls[registerSave.mock.calls.length - 1][0];
    await act(async () => { await savedFn(); });

    expect(set).toHaveBeenCalledWith(
      '/test/project',
      expect.objectContaining({ provider: 'github', ticket_prefix: 'GH' })
    );
  });

  it('save calls ticketing.set with jira config when all required fields are filled', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const registerSave = vi.fn();
    const ctx = makeCtx(null);
    ctx.ticketing.set = set;
    ctx.registerSave = registerSave;

    const pane = buildTicketingPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-tile-jira'));

    await act(async () => { fireEvent.click(screen.getByTestId('provider-tile-jira')); });
    await act(async () => { fireEvent.change(screen.getByTestId('jira-url'), { target: { value: 'https://team.atlassian.net' } }); });
    await act(async () => { fireEvent.change(screen.getByTestId('jira-username'), { target: { value: 'me@team.com' } }); });
    await act(async () => { fireEvent.change(screen.getByTestId('jira-api-token'), { target: { value: 'secret' } }); });
    await act(async () => { fireEvent.change(screen.getByTestId('jira-project-key'), { target: { value: 'TEAM' } }); });

    const savedFn = registerSave.mock.calls[registerSave.mock.calls.length - 1][0];
    await act(async () => { await savedFn(); });

    expect(set).toHaveBeenCalledWith(
      '/test/project',
      expect.objectContaining({
        provider: 'jira',
        jira_url: 'https://team.atlassian.net',
        jira_username: 'me@team.com',
        jira_api_token: 'secret',
        jira_project_key: 'TEAM',
      })
    );
  });

  it('switching provider clears the save error', async () => {
    const registerSave = vi.fn();
    const ctx = makeCtx(null);
    ctx.registerSave = registerSave;

    const pane = buildTicketingPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-tile-jira'));
    await act(async () => { fireEvent.click(screen.getByTestId('provider-tile-jira')); });

    const savedFn = registerSave.mock.calls[registerSave.mock.calls.length - 1][0];
    await act(async () => { await savedFn(); });
    expect(screen.getByTestId('ticketing-save-error')).toBeDefined();

    await act(async () => { fireEvent.click(screen.getByTestId('provider-tile-github')); });
    expect(screen.queryByTestId('ticketing-save-error')).toBeNull();
  });

  it('selecting a provider marks the form dirty', async () => {
    const ctx = makeCtx(null);
    const pane = buildTicketingPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => screen.getByTestId('provider-tile-jira'));
    await act(async () => { fireEvent.click(screen.getByTestId('provider-tile-jira')); });
    expect(ctx.onDirtyChange).toHaveBeenCalledWith(true);
  });

  it('renders ticket-prefix input', async () => {
    const ctx = makeCtx({ provider: 'github', ticket_prefix: 'PROJ' });
    const pane = buildTicketingPane(ctx);
    render(<>{pane.render()}</>);
    await waitFor(() => {
      const input = screen.getByTestId('ticket-prefix') as HTMLInputElement;
      expect(input.value).toBe('PROJ');
    });
  });
});
