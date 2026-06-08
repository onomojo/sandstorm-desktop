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

    describe('Backlog filter controls (#548)', () => {
      beforeEach(async () => {
        render(<ModelSettingsModal />);
        fireEvent.click(screen.getByTestId('model-settings-tab-ticketing'));
        await waitFor(() => {
          expect(screen.getByTestId('ticket-filter-mode-assisted')).toBeDefined();
        });
      });

      it('renders assisted and advanced mode toggle buttons', () => {
        expect(screen.getByTestId('ticket-filter-mode-assisted')).toBeDefined();
        expect(screen.getByTestId('ticket-filter-mode-advanced')).toBeDefined();
      });

      it('shows ownership dropdown and open-only toggle in assisted mode by default', () => {
        expect(screen.getByTestId('ticket-filter-ownership')).toBeDefined();
        expect(screen.getByTestId('ticket-filter-open-only')).toBeDefined();
        expect(screen.queryByTestId('ticket-filter-query')).toBeNull();
      });

      it('shows advanced textarea and hides assisted controls when advanced is selected', () => {
        fireEvent.click(screen.getByTestId('ticket-filter-mode-advanced'));
        expect(screen.getByTestId('ticket-filter-query')).toBeDefined();
        expect(screen.queryByTestId('ticket-filter-ownership')).toBeNull();
        expect(screen.queryByTestId('ticket-filter-open-only')).toBeNull();
      });

      it('saves filter config via setProjectTicketConfig', async () => {
        const select = screen.getByTestId('ticket-filter-ownership') as HTMLSelectElement;
        fireEvent.change(select, { target: { value: 'assigned' } });
        const checkbox = screen.getByTestId('ticket-filter-open-only') as HTMLInputElement;
        fireEvent.click(checkbox);
        fireEvent.click(screen.getByTestId('model-settings-save'));
        await waitFor(() => {
          expect(api.projectTicketConfig.set).toHaveBeenCalledWith(
            '/myapp',
            expect.objectContaining({
              filter_mode: 'assisted',
              filter_ownership: 'assigned',
              filter_open_only: false,
            }),
          );
        });
      });

      it('saves advanced query when in advanced mode', async () => {
        fireEvent.click(screen.getByTestId('ticket-filter-mode-advanced'));
        fireEvent.change(screen.getByTestId('ticket-filter-query'), { target: { value: 'priority = High' } });
        fireEvent.click(screen.getByTestId('model-settings-save'));
        await waitFor(() => {
          expect(api.projectTicketConfig.set).toHaveBeenCalledWith(
            '/myapp',
            expect.objectContaining({
              filter_mode: 'advanced',
              filter_query: 'priority = High',
            }),
          );
        });
      });

      it('loads filter config from getProjectTicketConfig on mount', async () => {
        api.projectTicketConfig.get.mockResolvedValue({
          provider: 'github',
          jira_url: null,
          jira_username: null,
          jira_api_token: null,
          jira_project_key: null,
          jira_issue_type: null,
          ticket_prefix: null,
          filter_mode: 'advanced',
          filter_ownership: 'assigned',
          filter_open_only: false,
          filter_query: 'is:open assignee:@me',
        });
        // Re-render to trigger load
        const { unmount } = render(<ModelSettingsModal />);
        fireEvent.click(screen.getAllByTestId('model-settings-tab-ticketing')[1]);
        await waitFor(() => {
          const queryTextarea = screen.getAllByTestId('ticket-filter-query');
          expect((queryTextarea[queryTextarea.length - 1] as HTMLTextAreaElement).value).toBe('is:open assignee:@me');
        });
        unmount();
      });

      it('clears filter_query and resets filter_mode to assisted when switching provider', async () => {
        fireEvent.click(screen.getByTestId('ticket-filter-mode-advanced'));
        fireEvent.change(screen.getByTestId('ticket-filter-query'), { target: { value: 'some query' } });
        // Switch to Jira and back to GitHub — both should reset
        fireEvent.click(screen.getByTestId('ticket-provider-jira'));
        expect(screen.queryByTestId('ticket-filter-query')).toBeNull();
        expect(screen.getByTestId('ticket-filter-mode-assisted')).toBeDefined();
        expect(screen.getByTestId('ticket-filter-ownership')).toBeDefined();
        // Switch back to advanced and confirm the query was actually cleared
        fireEvent.click(screen.getByTestId('ticket-filter-mode-advanced'));
        const queryTextarea = screen.getByTestId('ticket-filter-query') as HTMLTextAreaElement;
        expect(queryTextarea.value).toBe('');
      });

      it('resets filterOwnership and filterOpenOnly to defaults when switching provider', async () => {
        const ownershipSelect = screen.getByTestId('ticket-filter-ownership') as HTMLSelectElement;
        fireEvent.change(ownershipSelect, { target: { value: 'assigned' } });
        const checkbox = screen.getByTestId('ticket-filter-open-only') as HTMLInputElement;
        fireEvent.click(checkbox);
        expect(ownershipSelect.value).toBe('assigned');
        expect(checkbox.checked).toBe(false);
        fireEvent.click(screen.getByTestId('ticket-provider-jira'));
        const ownershipAfter = screen.getByTestId('ticket-filter-ownership') as HTMLSelectElement;
        expect(ownershipAfter.value).toBe('created');
        const checkboxAfter = screen.getByTestId('ticket-filter-open-only') as HTMLInputElement;
        expect(checkboxAfter.checked).toBe(true);
      });

      it('renders open-only checkbox as unchecked when loaded from config with filter_open_only: false', async () => {
        api.projectTicketConfig.get.mockResolvedValue({
          provider: 'github',
          jira_url: null,
          jira_username: null,
          jira_api_token: null,
          jira_project_key: null,
          jira_issue_type: null,
          ticket_prefix: null,
          filter_mode: 'assisted',
          filter_ownership: 'created',
          filter_open_only: false,
          filter_query: null,
        });
        const { unmount } = render(<ModelSettingsModal />);
        fireEvent.click(screen.getAllByTestId('model-settings-tab-ticketing')[1]);
        await waitFor(() => {
          const checkboxes = screen.getAllByTestId('ticket-filter-open-only');
          const cb = checkboxes[checkboxes.length - 1] as HTMLInputElement;
          expect(cb.checked).toBe(false);
        });
        unmount();
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
        resolve!({ auth: { ok: true, displayName: 'X' }, jql: { ok: true, count: 1, hasMore: false } });
      });

      it('button is disabled when required creds are empty', () => {
        fireEvent.change(screen.getByTestId('jira-url'), { target: { value: '' } });
        const btn = screen.getByTestId('jira-test-connection') as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
      });

      it('shows success-with-count state after successful connection', async () => {
        api.tickets.testJiraConnection.mockResolvedValueOnce({
          auth: { ok: true, displayName: 'Alice Smith' },
          jql: { ok: true, count: 5, hasMore: false },
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
          jql: { ok: true, count: 0, hasMore: false },
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

      it('shows "100+" when hasMore is true', async () => {
        api.tickets.testJiraConnection.mockResolvedValueOnce({
          auth: { ok: true, displayName: 'Dave' },
          jql: { ok: true, count: 100, hasMore: true },
        });
        fireEvent.click(screen.getByTestId('jira-test-connection'));
        await waitFor(() => {
          expect(screen.getByTestId('jira-test-jql-ok')).toBeDefined();
        });
        expect(screen.getByTestId('jira-test-jql-ok').textContent).toContain('100+');
      });
    });
  });
});
