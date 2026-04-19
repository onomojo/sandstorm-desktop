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
 *
 * `Skill` is on the list so the orchestrator can invoke project-local skills
 * enumerated at spawn time (#266). Skill descriptions ride in the system
 * prompt; skill bodies load lazily when the tool is called.
 */
export const DEFAULT_OUTER_CLAUDE_TOOLS: readonly string[] = Object.freeze([
  'Bash',
  'Read',
  'Grep',
  'Glob',
  'Skill',
]);

/**
 * Resolve the effective tool allowlist for the outer orchestrator.
 * A project can override via `.sandstorm/context/settings.json`:
 *   { "outerClaudeTools": ["Bash", "Read", "Edit"] }
 * The override must be a non-empty array of non-empty strings; anything
 * else (malformed JSON, missing file, missing key, wrong type, empty array,
 * non-string entries) falls back to the default.
 */
export function resolveOuterClaudeTools(projectDir?: string): string[] {
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
