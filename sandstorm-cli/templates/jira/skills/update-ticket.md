# Update Ticket

Update a Jira ticket's description (used by the spec-refine workflow).

## Prerequisites

Export these in your shell environment before launching the app:

- `JIRA_URL` — site root, e.g. `https://yourorg.atlassian.net`
- `JIRA_USERNAME` — your Atlassian account email
- `JIRA_API_TOKEN` — from https://id.atlassian.com/manage-profile/security/api-tokens

## Usage

```bash
.sandstorm/scripts/update-ticket.sh <ticket-id> <body>
```
