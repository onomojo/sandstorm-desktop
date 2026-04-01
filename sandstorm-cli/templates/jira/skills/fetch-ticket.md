# Fetch Ticket

Fetch a Jira ticket's full context using the Atlassian MCP tools.

## Usage

Run the project's fetch-ticket script:

```bash
.sandstorm/scripts/fetch-ticket.sh <ticket-id>
```

For Jira, this requires the Atlassian MCP Python server. If the script fails with a prerequisites error, either:
1. Install and configure the Atlassian MCP server
2. Replace the script with a curl-based Jira REST API call

## Examples

```bash
.sandstorm/scripts/fetch-ticket.sh PROJ-123
```
