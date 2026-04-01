# Fetch Ticket

Fetch a ticket's full context (title, body, comments, labels, state, author).

## Usage

Run the project's fetch-ticket script:

```bash
.sandstorm/scripts/fetch-ticket.sh <ticket-id>
```

The script outputs standardized markdown to stdout. Pass the output into whatever workflow needs the ticket content (spec quality gate, task dispatch, etc.).

## Examples

```bash
# Fetch GitHub issue #162
.sandstorm/scripts/fetch-ticket.sh 162

# Fetch with # prefix (stripped automatically)
.sandstorm/scripts/fetch-ticket.sh "#162"
```
