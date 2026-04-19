/**
 * Outer Claude tools allowlist (#256).
 *
 * Pure, electron-free module. The logic here is exercised via unit tests
 * against a real temp filesystem — do not import electron from this file.
 */

import fs from 'fs';
import path from 'path';

/**
 * Default allowlist of Claude Code built-in tools that the outer orchestrator
 * is allowed to invoke. Everything else (Edit, Write, Agent, Task*, WebFetch,
 * WebSearch, LSP, NotebookEdit, MultiEdit, etc.) is denied by omission — the
 * outer Claude's job is to delegate to stacks via MCP, not to edit code or
 * fetch the web itself. Denying them strips their schemas from the context
 * re-sent on every outer turn.
 */
export const DEFAULT_OUTER_CLAUDE_TOOLS: readonly string[] = Object.freeze([
  'Bash',
  'Read',
  'Grep',
  'Glob',
]);

/**
 * Expanded allowlist used by investigation Experiment 2 (tests hypothesis H-A:
 * does re-enabling in-process sub-agent delegation collapse the tool-use chain
 * down to one or two sub-calls?). Adds Agent + all Task* tools so the model
 * can offload analytical work to a fresh-context sub-process instead of doing
 * it inline.
 */
export const EXPERIMENT_EXPANDED_TOOLS: readonly string[] = Object.freeze([
  'Bash',
  'Read',
  'Grep',
  'Glob',
  'Agent',
  'Task',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskStop',
  'TaskOutput',
]);

/**
 * Resolve the effective tool allowlist for the outer orchestrator.
 * A project can override via `.sandstorm/context/settings.json`:
 *   { "outerClaudeTools": ["Bash", "Read", "Edit"] }
 * The override must be a non-empty array of non-empty strings; anything
 * else (malformed JSON, missing file, missing key, wrong type, empty array,
 * non-string entries) falls back to the default.
 */
export function resolveOuterClaudeTools(
  projectDir?: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  // Investigation override: SANDSTORM_EXP_ENABLE_AGENT=1 forces the expanded
  // allowlist (adds Agent + Task*). Takes precedence over project settings so
  // the investigation branch can compare tool-surface variants deterministically.
  if (env.SANDSTORM_EXP_ENABLE_AGENT === '1') {
    return [...EXPERIMENT_EXPANDED_TOOLS];
  }

  if (projectDir) {
    const settingsPath = path.join(projectDir, '.sandstorm', 'context', 'settings.json');
    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      const parsed = JSON.parse(raw) as { outerClaudeTools?: unknown };
      const override = parsed?.outerClaudeTools;
      if (
        Array.isArray(override) &&
        override.length > 0 &&
        override.every((t): t is string => typeof t === 'string' && t.length > 0)
      ) {
        return [...override];
      }
    } catch {
      // File missing / malformed / non-parseable → fall through to defaults
    }
  }
  return [...DEFAULT_OUTER_CLAUDE_TOOLS];
}
