// Dedicated module for the ticket-listing concern, separate from comment operations.
// Listing is a built-in provider operation (keyed off the project's ticket config),
// mirroring fetch/create/update — no per-project shell script required.
export { listTicketsWithConfig } from './ticket-config';
export type { TicketListEntry } from './ticket-config';
