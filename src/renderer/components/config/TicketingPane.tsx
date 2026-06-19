import React, { useState, useEffect, useRef } from 'react';
import { ConfigPane, ConfigPaneContext, ProjectTicketConfig, TicketProvider } from './types';

interface TicketingPaneBodyProps {
  ctx: ConfigPaneContext;
}

const EMPTY_CONFIG: ProjectTicketConfig = {
  provider: 'github',
  jira_url: null,
  jira_username: null,
  jira_api_token: null,
  jira_project_key: null,
  jira_issue_type: null,
  ticket_prefix: null,
};

function jiraFieldsMissing(config: ProjectTicketConfig): boolean {
  if (config.provider !== 'jira') return false;
  return !config.jira_url || !config.jira_username || !config.jira_api_token || !config.jira_project_key;
}

function TicketingPaneBody({ ctx }: TicketingPaneBodyProps) {
  const { projectDir, ticketing, onDirtyChange, registerSave } = ctx;

  const [baseline, setBaseline] = useState<ProjectTicketConfig>(EMPTY_CONFIG);
  const [buffered, setBuffered] = useState<ProjectTicketConfig>(EMPTY_CONFIG);
  const [saveError, setSaveError] = useState<string | null>(null);

  const bufferedRef = useRef(buffered);
  bufferedRef.current = buffered;

  useEffect(() => {
    let cancelled = false;
    ticketing.get(projectDir).then((cfg) => {
      if (cancelled) return;
      const config = cfg ?? EMPTY_CONFIG;
      setBaseline(config);
      setBuffered(config);
    });
    return () => { cancelled = true; };
  }, [projectDir]);

  useEffect(() => {
    const isDirty = JSON.stringify(buffered) !== JSON.stringify(baseline);
    onDirtyChange(isDirty);
  }, [buffered, baseline]);

  useEffect(() => {
    registerSave(async () => {
      const current = bufferedRef.current;
      if (jiraFieldsMissing(current)) {
        setSaveError('Jira requires URL, username, API token, and project key.');
        return;
      }
      setSaveError(null);
      await ticketing.set(projectDir, current);
      setBaseline(current);
      onDirtyChange(false);
    });
  }, [projectDir]);

  const setProvider = (provider: TicketProvider) => {
    setSaveError(null);
    setBuffered((b) => ({ ...b, provider }));
  };

  const setField = (field: keyof ProjectTicketConfig, value: string) => {
    setBuffered((b) => ({ ...b, [field]: value || null }));
  };

  return (
    <div data-testid="ticketing-pane" className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-sandstorm-fg mb-3">Provider</h3>
        <div className="flex gap-3">
          {(['github', 'jira'] as TicketProvider[]).map((p) => (
            <button
              key={p}
              data-testid={`provider-tile-${p}`}
              className={`flex-1 py-3 px-4 rounded border text-sm font-medium transition-colors ${
                buffered.provider === p
                  ? 'border-sandstorm-accent bg-sandstorm-accent/10 text-sandstorm-accent'
                  : 'border-sandstorm-border bg-sandstorm-surface text-sandstorm-muted hover:border-sandstorm-muted'
              }`}
              onClick={() => setProvider(p)}
            >
              {p === 'github' ? 'GitHub' : 'Jira'}
            </button>
          ))}
        </div>
      </div>

      {buffered.provider === 'jira' && (
        <div className="space-y-3" data-testid="jira-fields">
          <div>
            <label className="block text-xs font-medium text-sandstorm-muted mb-1">
              Jira URL <span className="text-red-400">*</span>
            </label>
            <input
              data-testid="jira-url"
              type="url"
              className="w-full px-2 py-1.5 text-sm rounded border border-sandstorm-border bg-sandstorm-surface text-sandstorm-fg"
              value={buffered.jira_url ?? ''}
              onChange={(e) => setField('jira_url', e.target.value)}
              placeholder="https://yourteam.atlassian.net"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-sandstorm-muted mb-1">
              Username (email) <span className="text-red-400">*</span>
            </label>
            <input
              data-testid="jira-username"
              type="email"
              className="w-full px-2 py-1.5 text-sm rounded border border-sandstorm-border bg-sandstorm-surface text-sandstorm-fg"
              value={buffered.jira_username ?? ''}
              onChange={(e) => setField('jira_username', e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-sandstorm-muted mb-1">
              API Token <span className="text-red-400">*</span>
            </label>
            <input
              data-testid="jira-api-token"
              type="password"
              className="w-full px-2 py-1.5 text-sm rounded border border-sandstorm-border bg-sandstorm-surface text-sandstorm-fg"
              value={buffered.jira_api_token ?? ''}
              onChange={(e) => setField('jira_api_token', e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-sandstorm-muted mb-1">
              Project Key <span className="text-red-400">*</span>
            </label>
            <input
              data-testid="jira-project-key"
              type="text"
              className="w-full px-2 py-1.5 text-sm rounded border border-sandstorm-border bg-sandstorm-surface text-sandstorm-fg"
              value={buffered.jira_project_key ?? ''}
              onChange={(e) => setField('jira_project_key', e.target.value)}
              placeholder="PROJ"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-sandstorm-muted mb-1">
              Issue Type
            </label>
            <input
              data-testid="jira-issue-type"
              type="text"
              className="w-full px-2 py-1.5 text-sm rounded border border-sandstorm-border bg-sandstorm-surface text-sandstorm-fg"
              value={buffered.jira_issue_type ?? ''}
              onChange={(e) => setField('jira_issue_type', e.target.value)}
              placeholder="Story"
            />
          </div>
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-sandstorm-muted mb-1">
          Ticket Prefix
        </label>
        <input
          data-testid="ticket-prefix"
          type="text"
          className="w-full px-2 py-1.5 text-sm rounded border border-sandstorm-border bg-sandstorm-surface text-sandstorm-fg"
          value={buffered.ticket_prefix ?? ''}
          onChange={(e) => setField('ticket_prefix', e.target.value)}
          placeholder="e.g. PROJ"
        />
      </div>

      {saveError && (
        <p data-testid="ticketing-save-error" className="text-xs text-red-400">
          {saveError}
        </p>
      )}
    </div>
  );
}

export function buildTicketingPane(ctx: ConfigPaneContext): ConfigPane {
  return {
    id: 'ticketing',
    label: 'Ticketing',
    icon: <span className="text-sm">🎫</span>,
    render: () => <TicketingPaneBody ctx={ctx} />,
  };
}
