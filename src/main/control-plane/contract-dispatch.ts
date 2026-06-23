/**
 * Pure helper for embedding the execution contract into the dispatch prompt
 * handed to the inner execution agent. Kept electron-free and isolated so it
 * can be unit-tested without the stack-manager's heavy dependencies.
 */

/**
 * Append a clearly-labeled `## Execution Contract` section carrying the
 * contract JSON. Returns the prompt unchanged when there is no contract, so
 * the re-dispatch path (which already carries the contract in the stored
 * prompt) and non-GitHub providers degrade gracefully.
 */
export function appendContractSection(prompt: string, contractJson: string | null | undefined): string {
  if (!contractJson || !contractJson.trim()) return prompt;
  return (
    `${prompt}\n\n---\n\n## Execution Contract\n\n` +
    'The following machine-generated contract is authoritative for this task. ' +
    'Satisfy every requirement, acceptance criterion, and required test; do not modify anything listed under forbidden_changes.\n\n' +
    '```json\n' +
    `${contractJson.trim()}\n` +
    '```'
  );
}
