# Create Ticket

File a new ticket in your project's ticket system. Used by the Create
Ticket dialog and any workflow that needs to open a new ticket
programmatically.

The skeleton template ships a stub script that exits non-zero with a
message. Replace `.sandstorm/scripts/create-ticket.sh` with a real
implementation for your ticket provider.

## Contract

Input:  `<title> <body>` as two positional arguments.

Output: the URL of the created ticket on stdout (last non-empty line).
Sandstorm parses this line to record the new ticket in the UI.

Exit:   0 on success, non-zero on failure (error to stderr).

## Usage

```bash
.sandstorm/scripts/create-ticket.sh <title> <body>
```
