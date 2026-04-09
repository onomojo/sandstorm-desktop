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

### Assumptions — Zero Unresolved
List every assumption the agent would make if it started now.
- **Assumptions are ambiguity. Ambiguity means the spec is incomplete.**
- If an assumption can be validated by reading code, checking APIs, or running commands — the evaluator MUST validate it and replace it with a verified fact or flag it as incorrect.
- If an assumption requires human input (business logic, domain knowledge, product direction, edge case decisions) — it MUST be surfaced as an explicit question that blocks the gate.
- The gate MUST NOT pass with unresolved assumptions. Every assumption must become either a verified fact or an answered question.

### End-to-End Data Flow Verification
When a feature spans multiple system boundaries (API → DB → frontend, CLI → config → runtime, etc.):
- Testability MUST include at least one item that traces data through the entire pipeline without mocks.
- Every integration boundary the data crosses must be explicitly identified.
- A verification step must prove data arrives at the final destination under realistic conditions.
- Flag any ticket where the testability section consists entirely of mocked tests for features that span multiple layers.

### Dependency Contracts
When the ticket references another ticket, module, or external system's output:
- The data contract must be explicit — what format, what interface, when available.
- Read/write timing must be compatible — if the source writes at end-of-process and the consumer reads mid-process, that's a conflict.
- How contract compatibility is verified must be specified.
- If the data source doesn't exist yet, the ticket must include creating it or explicitly depend on a ticket that does.

### Automated Visual Verification (UI Tickets)
When the ticket describes visual changes (components, panels, layouts, modals, pages):
- An automated visual verification step against the real running application is required — not mocked component renders.
- Visual verification must exercise the same code path the user sees (real IPC, real backend, real data flow).
- If the project provides headless browser infrastructure, the verification step must use it.
- Skip this criterion if the ticket has no UI/visual changes.

### All Verification Must Be Automatable
Every verification item must be executable autonomously with no human involvement:
- No "manually verify", "visually confirm", "deploy and check".
- No optional verification checkboxes that can be skipped.
- If a verification step can't be expressed as an automated command, test, or assertion, it's not valid.
- The fix isn't "make sure humans check the boxes" — it's "eliminate manual steps entirely".
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
