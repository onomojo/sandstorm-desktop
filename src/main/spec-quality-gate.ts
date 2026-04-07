import fs from 'fs';
import path from 'path';

const QUALITY_GATE_FILE = 'spec-quality-gate.md';

/**
 * Returns the default content for .sandstorm/spec-quality-gate.md.
 * This defines what a "ready" ticket looks like before dispatch.
 */
export function getDefaultSpecQualityGate(): string {
  return `# Spec Quality Gate

Criteria for determining whether a ticket is ready for agent dispatch.
Each criterion is **pass/fail**. If any fails, the specific gap must be
resolved before the ticket enters the execution pipeline.

Customize this file to match your project's needs. This is the single
source of truth for what "ready" means in this project.

---

## Criteria

### Problem Statement
Is the "why" clearly stated? What's broken or missing?
- The ticket must explain the motivation, not just the desired change.

### Current vs Desired Behavior
Can someone understand what changes?
- Describe what happens today and what should happen after the work is done.

### Scope Boundaries
What's explicitly in scope? What's out?
- Unbounded tickets lead to scope creep. Define the edges.

### Migration Path
If it changes existing behavior, how do existing users/projects transition?
- Skip if the change is purely additive with no breaking impact.

### Edge Cases
Are known edge cases called out?
- List scenarios that could break or behave unexpectedly.

### Ambiguity Check
Are there decision points where the agent would have to guess?
- Every ambiguity is a coin flip. Resolve them before dispatch.

### Testability
Is it clear how to verify the work is correct?
- Define what "done" looks like in concrete, testable terms.

### Files/Areas Affected
Are the impacted areas of the codebase identified?
- Point the agent at the right part of the codebase.

### Assumptions
List every assumption the agent would make if it started now.
- Surface them so incorrect assumptions can be flagged before work begins.
`;
}

/**
 * Read the quality gate file for a project.
 * Returns empty string if file doesn't exist.
 */
export function getSpecQualityGate(projectDir: string): string {
  const filePath = path.join(projectDir, '.sandstorm', QUALITY_GATE_FILE);
  console.log(`[sandstorm] getSpecQualityGate: checking "${filePath}"`);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Save the quality gate file for a project.
 */
export function saveSpecQualityGate(projectDir: string, content: string): void {
  const sandstormDir = path.join(projectDir, '.sandstorm');
  if (!fs.existsSync(sandstormDir)) {
    fs.mkdirSync(sandstormDir, { recursive: true });
  }
  fs.writeFileSync(path.join(sandstormDir, QUALITY_GATE_FILE), content, 'utf-8');
}

/**
 * Check if an initialized project is missing the quality gate file.
 */
export function isSpecQualityGateMissing(projectDir: string): boolean {
  const sandstormDir = path.join(projectDir, '.sandstorm');
  if (!fs.existsSync(path.join(sandstormDir, 'config'))) return false;
  return !fs.existsSync(path.join(sandstormDir, QUALITY_GATE_FILE));
}

/**
 * Auto-create the quality gate file if missing.
 * Returns true if the file was created.
 */
export function ensureSpecQualityGate(projectDir: string): boolean {
  if (!isSpecQualityGateMissing(projectDir)) return false;
  saveSpecQualityGate(projectDir, getDefaultSpecQualityGate());
  return true;
}
