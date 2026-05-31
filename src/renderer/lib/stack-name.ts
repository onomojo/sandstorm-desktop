export function suggestStackName(ticketId: string): string {
  const id = ticketId.replace(/^#/, '').replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
  return id ? `ticket-${id}` : '';
}
