# Fetch Ticket

Fetch a ticket's full context (title, body, comments, labels, state, author).

## Usage

Run the project's fetch-ticket script:

```bash
.sandstorm/scripts/fetch-ticket.sh <ticket-id>
```

**This script needs to be configured.** Edit `.sandstorm/scripts/fetch-ticket.sh` and replace the placeholder with your ticket system's API call. See the script comments for the expected output format.
