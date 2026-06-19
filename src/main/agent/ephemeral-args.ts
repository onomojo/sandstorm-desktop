/**
 * Pure argv builder for the one-shot ephemeral Claude print-mode spawn.
 *
 * The prompt is intentionally NOT part of the returned argv. It is written to
 * the child's stdin instead. Passing a large prompt as a single CLI argument
 * overflows Linux's per-argument limit (MAX_ARG_STRLEN = 128 KB) and makes
 * `child_process.spawn` throw `E2BIG` synchronously — before any error handler
 * is attached, so the failure surfaces as a bare "spawn E2BIG".
 *
 * Spec-check / refine prompts embed the quality gate, the ticket body, and up
 * to ~1 MB of resolved external references (see ticket-references.ts), so they
 * routinely exceed the 128 KB ceiling. stdin has no such limit.
 *
 * Regression: ticket 647 refine failed with "spawn E2BIG" because its check
 * prompt crossed 128 KB once references were inlined into the `-p` argument.
 */
export function buildEphemeralAgentArgs(model?: string): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    ...(model && model !== 'auto' ? ['--model', model] : []),
  ];
}
