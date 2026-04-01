# Start Ticket

Mark a ticket as started (assign to current user, set in-progress status).

## Usage

Run the project's start-ticket script:

```bash
.sandstorm/scripts/start-ticket.sh <ticket-id>
```

For GitHub, this adds the "in-progress" label and assigns the issue to the current user.

## Examples

```bash
.sandstorm/scripts/start-ticket.sh 162
```
