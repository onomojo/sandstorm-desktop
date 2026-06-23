import Database from 'better-sqlite3';
import path from 'path';
import type { ProjectTicketConfig, TicketProvider } from '../registry';

export class TicketConfigModule {
  constructor(private db: Database.Database) {}

  getProjectTicketConfig(projectDir: string): ProjectTicketConfig | null {
    const key = `project:${path.resolve(projectDir)}`;
    const row = this.db.prepare(
      'SELECT provider, jira_url, jira_username, jira_api_token, jira_project_key, jira_issue_type, ticket_prefix, filter_mode, filter_ownership, filter_open_only, filter_query FROM project_ticket_config WHERE key = ?'
    ).get(key) as (Omit<ProjectTicketConfig, 'provider' | 'filter_open_only'> & { provider: string; filter_open_only: number | null }) | undefined;
    if (!row) return null;
    return {
      provider: row.provider as TicketProvider,
      jira_url: row.jira_url,
      jira_username: row.jira_username,
      jira_api_token: row.jira_api_token,
      jira_project_key: row.jira_project_key,
      jira_issue_type: row.jira_issue_type,
      ticket_prefix: row.ticket_prefix,
      filter_mode: (row.filter_mode as 'assisted' | 'advanced' | null) ?? null,
      filter_ownership: (row.filter_ownership as 'created' | 'assigned' | null) ?? null,
      filter_open_only: row.filter_open_only != null ? row.filter_open_only !== 0 : null,
      filter_query: row.filter_query ?? null,
    };
  }

  setProjectTicketConfig(projectDir: string, config: ProjectTicketConfig): void {
    const key = `project:${path.resolve(projectDir)}`;
    this.db.prepare(
      `INSERT OR REPLACE INTO project_ticket_config
        (key, provider, jira_url, jira_username, jira_api_token, jira_project_key, jira_issue_type, ticket_prefix, filter_mode, filter_ownership, filter_open_only, filter_query)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      key,
      config.provider,
      config.jira_url ?? null,
      config.jira_username ?? null,
      config.jira_api_token ?? null,
      config.jira_project_key ?? null,
      config.jira_issue_type ?? null,
      config.ticket_prefix ?? null,
      config.filter_mode ?? null,
      config.filter_ownership ?? null,
      config.filter_open_only != null ? (config.filter_open_only ? 1 : 0) : null,
      config.filter_query ?? null,
    );
  }

  removeProjectTicketConfig(projectDir: string): void {
    const key = `project:${path.resolve(projectDir)}`;
    this.db.prepare('DELETE FROM project_ticket_config WHERE key = ?').run(key);
  }
}
