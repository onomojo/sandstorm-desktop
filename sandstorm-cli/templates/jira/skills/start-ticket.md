# Start Ticket

Transition a Jira ticket to "In Progress" and assign it to the authenticated user.

## Prerequisites

Export these in your shell environment before launching the app:

- `JIRA_URL` — site root, e.g. `https://yourorg.atlassian.net`
- `JIRA_USERNAME` — your Atlassian account email
- `JIRA_API_TOKEN` — from https://id.atlassian.com/manage-profile/security/api-tokens

## Usage

```bash
.sandstorm/scripts/start-ticket.sh <ticket-id>
```

## Examples

```bash
.sandstorm/scripts/start-ticket.sh PROJ-123
```
