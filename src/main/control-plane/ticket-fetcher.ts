export { fetchTicketWithConfig } from './ticket-config';

/**
 * Detect whether a task prompt references a ticket.
 * Matches GitHub patterns (#123, owner/repo#123, GitHub URLs),
 * Jira patterns (PROJ-123), and Linear patterns (LIN-123).
 */
export function referencesTicket(prompt: string): boolean {
  // #123 (standalone issue number)
  if (/(?:^|\s)#\d+/.test(prompt)) return true;
  // owner/repo#123
  if (/[\w.-]+\/[\w.-]+#\d+/.test(prompt)) return true;
  // GitHub issue URL
  if (/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/.test(prompt)) return true;
  // Jira-style: PROJ-123 (2+ uppercase letters, dash, digits)
  if (/(?:^|\s)[A-Z]{2,}-\d+/.test(prompt)) return true;
  // Linear-style URLs
  if (/linear\.app\/[\w.-]+\/issue\/[\w-]+/.test(prompt)) return true;
  return false;
}
