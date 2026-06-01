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

  it('renders the modal with Project Configuration title', () => {
    render(<ModelSettingsModal />);
    expect(screen.getByText('Project Configuration')).toBeDefined();
  });

  it('shows global, project, and ticketing tabs', () => {
    render(<ModelSettingsModal />);
    expect(screen.getByTestId('model-settings-tab-global')).toBeDefined();
    expect(screen.getByTestId('model-settings-tab-project')).toBeDefined();
    expect(screen.getByTestId('model-settings-tab-ticketing')).toBeDefined();
  });

  it('defaults to global tab when no project is active', () => {
    render(<ModelSettingsModal />);
    expect(screen.getByTestId('global-inner-auto')).toBeDefined();
    expect(screen.getByTestId('global-inner-sonnet')).toBeDefined();
    expect(screen.getByTestId('global-inner-opus')).toBeDefined();
  });

  it('disables project and ticketing tabs when no project is active', () => {
    render(<ModelSettingsModal />);
    expect(screen.getByTestId('model-settings-tab-project').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('model-settings-tab-ticketing').hasAttribute('disabled')).toBe(true);
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

  describe('with active project', () => {
    beforeEach(() => {
      useAppStore.setState({
        projects: [{ id: 1, name: 'myapp', directory: '/myapp', added_at: '' }],
        activeProjectId: 1,
      });
    });

    it('shows project model override tab when project is active', async () => {
      render(<ModelSettingsModal />);
      await waitFor(() => {
        expect(screen.getByTestId('project-inner-global')).toBeDefined();
      });
    });

    it('shows ticketing tab and can switch to it', async () => {
      render(<ModelSettingsModal />);
      fireEvent.click(screen.getByTestId('model-settings-tab-ticketing'));
      await waitFor(() => {
        expect(screen.getByTestId('ticket-provider-github')).toBeDefined();
        expect(screen.getByTestId('ticket-provider-jira')).toBeDefined();
      });
    });

    it('hides Jira fields when GitHub is selected', async () => {
      render(<ModelSettingsModal />);
      fireEvent.click(screen.getByTestId('model-settings-tab-ticketing'));
      await waitFor(() => {
        expect(screen.queryByTestId('jira-fields')).toBeNull();
      });
    });

    it('shows Jira fields when Jira provider is selected', async () => {
      render(<ModelSettingsModal />);
      fireEvent.click(screen.getByTestId('model-settings-tab-ticketing'));
      await waitFor(() => {
        expect(screen.getByTestId('ticket-provider-jira')).toBeDefined();
      });
      fireEvent.click(screen.getByTestId('ticket-provider-jira'));
      expect(screen.getByTestId('jira-fields')).toBeDefined();
      expect(screen.getByTestId('jira-url')).toBeDefined();
      expect(screen.getByTestId('jira-username')).toBeDefined();
      expect(screen.getByTestId('jira-api-token')).toBeDefined();
      expect(screen.getByTestId('jira-project-key')).toBeDefined();
    });

    it('saves GitHub ticket config correctly', async () => {
      render(<ModelSettingsModal />);
      fireEvent.click(screen.getByTestId('model-settings-tab-ticketing'));
      await waitFor(() => {
        expect(screen.getByTestId('ticket-provider-github')).toBeDefined();
      });
      // GitHub is default — saving should call set with github config
      fireEvent.click(screen.getByTestId('ticket-provider-jira'));
      fireEvent.click(screen.getByTestId('ticket-provider-github')); // switch back
      fireEvent.click(screen.getByTestId('model-settings-save'));
      await waitFor(() => {
        expect(api.projectTicketConfig.set).toHaveBeenCalledWith(
          '/myapp',
          expect.objectContaining({ provider: 'github' }),
        );
      });
    });

    it('persists Jira fields and calls set with jira config', async () => {
      render(<ModelSettingsModal />);
      fireEvent.click(screen.getByTestId('model-settings-tab-ticketing'));
      await waitFor(() => {
        fireEvent.click(screen.getByTestId('ticket-provider-jira'));
      });
      fireEvent.change(screen.getByTestId('jira-url'), { target: { value: 'https://acme.atlassian.net' } });
      fireEvent.change(screen.getByTestId('jira-username'), { target: { value: 'dev@acme.com' } });
      fireEvent.change(screen.getByTestId('jira-api-token'), { target: { value: 'secret' } });
      fireEvent.change(screen.getByTestId('jira-project-key'), { target: { value: 'acme' } });
      fireEvent.click(screen.getByTestId('model-settings-save'));
      await waitFor(() => {
        expect(api.projectTicketConfig.set).toHaveBeenCalledWith(
          '/myapp',
          expect.objectContaining({
            provider: 'jira',
            jira_url: 'https://acme.atlassian.net',
            jira_username: 'dev@acme.com',
            jira_api_token: 'secret',
          }),
        );
      });
    });

    it('loads existing ticket config on mount', async () => {
      api.projectTicketConfig.get.mockResolvedValue({
        provider: 'jira',
        jira_url: 'https://existing.atlassian.net',
        jira_username: 'user@x.com',
        jira_api_token: 'tok',
        jira_project_key: 'EXISTING',
        jira_issue_type: null,
        ticket_prefix: null,
      });
      render(<ModelSettingsModal />);
      fireEvent.click(screen.getByTestId('model-settings-tab-ticketing'));
      await waitFor(() => {
        expect(screen.getByTestId('jira-url')).toBeDefined();
        const urlInput = screen.getByTestId('jira-url') as HTMLInputElement;
        expect(urlInput.value).toBe('https://existing.atlassian.net');
      });
    });

    describe('Test Connection button (#435)', () => {
      beforeEach(async () => {
        render(<ModelSettingsModal />);
        fireEvent.click(screen.getByTestId('model-settings-tab-ticketing'));
        await waitFor(() => {
          expect(screen.getByTestId('ticket-provider-jira')).toBeDefined();
        });
        fireEvent.click(screen.getByTestId('ticket-provider-jira'));
        // Fill in creds so button is enabled
        fireEvent.change(screen.getByTestId('jira-url'), { target: { value: 'https://acme.atlassian.net' } });
        fireEvent.change(screen.getByTestId('jira-username'), { target: { value: 'user@acme.com' } });
        fireEvent.change(screen.getByTestId('jira-api-token'), { target: { value: 'secret' } });
      });

      it('shows Test Connection button in the Jira section', () => {
        expect(screen.getByTestId('jira-test-connection')).toBeDefined();
      });

      it('shows Testing… and disables button while in-flight', async () => {
        let resolve: (val: unknown) => void;
        const pending = new Promise((r) => { resolve = r; });
        api.tickets.testJiraConnection.mockReturnValueOnce(pending);

        fireEvent.click(screen.getByTestId('jira-test-connection'));

        await waitFor(() => {
          const btn = screen.getByTestId('jira-test-connection') as HTMLButtonElement;
          expect(btn.textContent).toBe('Testing…');
          expect(btn.disabled).toBe(true);
        });

        // Resolve to avoid dangling promise
        resolve!({ auth: { ok: true, displayName: 'X' }, jql: { ok: true, count: 1 } });
      });

      it('button is disabled when required creds are empty', () => {
        fireEvent.change(screen.getByTestId('jira-url'), { target: { value: '' } });
        const btn = screen.getByTestId('jira-test-connection') as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
      });

      it('shows success-with-count state after successful connection', async () => {
        api.tickets.testJiraConnection.mockResolvedValueOnce({
          auth: { ok: true, displayName: 'Alice Smith' },
          jql: { ok: true, count: 5 },
        });
        fireEvent.click(screen.getByTestId('jira-test-connection'));
        await waitFor(() => {
          expect(screen.getByTestId('jira-test-auth-ok')).toBeDefined();
          expect(screen.getByTestId('jira-test-auth-ok').textContent).toContain('Alice Smith');
        });
        expect(screen.getByTestId('jira-test-jql-ok').textContent).toContain('5 tickets');
      });

      it('shows auth-fail state when auth fails', async () => {
        api.tickets.testJiraConnection.mockResolvedValueOnce({
          auth: { ok: false, status: 401, message: 'Unauthorized' },
          jql: null,
        });
        fireEvent.click(screen.getByTestId('jira-test-connection'));
        await waitFor(() => {
          expect(screen.getByTestId('jira-test-auth-fail')).toBeDefined();
          expect(screen.getByTestId('jira-test-auth-fail').textContent).toContain('401');
        });
        expect(screen.queryByTestId('jira-test-jql-ok')).toBeNull();
        expect(screen.queryByTestId('jira-test-jql-fail')).toBeNull();
      });

      it('shows jql-empty hint when auth passes but JQL returns 0', async () => {
        api.tickets.testJiraConnection.mockResolvedValueOnce({
          auth: { ok: true, displayName: 'Bob' },
          jql: { ok: true, count: 0 },
        });
        fireEvent.click(screen.getByTestId('jira-test-connection'));
        await waitFor(() => {
          expect(screen.getByTestId('jira-test-auth-ok')).toBeDefined();
        });
        expect(screen.getByTestId('jira-test-jql-ok').textContent).toContain('filter may be excluding everything');
      });

      it('auth and jql results are visually separate elements', async () => {
        api.tickets.testJiraConnection.mockResolvedValueOnce({
          auth: { ok: true, displayName: 'Carol' },
          jql: { ok: false, status: 400, message: 'Bad JQL' },
        });
        fireEvent.click(screen.getByTestId('jira-test-connection'));
        await waitFor(() => {
          expect(screen.getByTestId('jira-test-auth-ok')).toBeDefined();
          expect(screen.getByTestId('jira-test-jql-fail')).toBeDefined();
        });
      });
    });
  });
});
