# Create Ticket

File a new GitHub issue using the `gh` CLI. Used by the Create Ticket
dialog and any workflow that needs to open a new ticket programmatically.

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`).

## Usage

```bash
.sandstorm/scripts/create-ticket.sh <title> <body>
```

## Example

```bash
.sandstorm/scripts/create-ticket.sh "Auth token expiry" "Tokens expire silently after 24h; surface a user-facing error."
```

On success, the script prints the URL of the created issue on stdout
(e.g. `https://github.com/owner/repo/issues/123`). Errors go to stderr
and the script exits non-zero.
