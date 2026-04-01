# Update Ticket

Update a ticket's body content (used by the spec-refine workflow).

## Usage

Run the project's update-ticket script:

```bash
.sandstorm/scripts/update-ticket.sh <ticket-id> <body>
```

The script replaces the ticket body with the provided content.

## Examples

```bash
.sandstorm/scripts/update-ticket.sh 162 "Updated issue body with clarifications..."
```
