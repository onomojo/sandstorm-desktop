# Create Ticket

File a new Jira issue. Used by the Create Ticket dialog and any workflow
that needs to open a new ticket programmatically.

## Prerequisites

Export these in your shell environment before launching the app:

- `JIRA_URL` — site root, e.g. `https://yourorg.atlassian.net`
- `JIRA_USERNAME` — your Atlassian account email
- `JIRA_API_TOKEN` — from https://id.atlassian.com/manage-profile/security/api-tokens
- `JIRA_PROJECT_KEY` — project key the issue is filed under (e.g. `PROJ`)

Optional:

- `JIRA_ISSUE_TYPE` — issue type name (default: `Task`)

## Usage

```bash
.sandstorm/scripts/create-ticket.sh <title> <body>
```

## Example

```bash
.sandstorm/scripts/create-ticket.sh "Auth token expiry" "Tokens expire silently after 24h; surface a user-facing error."
```

On success, the script prints the URL of the created ticket on stdout
(e.g. `https://yourorg.atlassian.net/browse/PROJ-123`). Errors go to
stderr and the script exits non-zero.
