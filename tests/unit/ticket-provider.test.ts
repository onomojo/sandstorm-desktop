import { describe, it, expect } from 'vitest';
import type { TicketProvider, ProjectTicketConfig } from '../../src/main/control-plane/ticket-provider';

describe('TicketProvider type', () => {
  it('accepts github and jira as valid providers', () => {
    const github: TicketProvider = 'github';
    const jira: TicketProvider = 'jira';
    expect(github).toBe('github');
    expect(jira).toBe('jira');
  });
});

describe('ProjectTicketConfig type', () => {
  it('allows a minimal GitHub config', () => {
    const config: ProjectTicketConfig = { provider: 'github' };
    expect(config.provider).toBe('github');
    expect(config.jira_url).toBeUndefined();
  });

  it('allows a full Jira config', () => {
    const config: ProjectTicketConfig = {
      provider: 'jira',
      jira_url: 'https://acme.atlassian.net',
      jira_username: 'dev@acme.com',
      jira_api_token: 'token',
      jira_project_key: 'ACME',
      jira_issue_type: 'Story',
      ticket_prefix: 'ACME-',
    };
    expect(config.jira_url).toBe('https://acme.atlassian.net');
    expect(config.jira_project_key).toBe('ACME');
  });
});
