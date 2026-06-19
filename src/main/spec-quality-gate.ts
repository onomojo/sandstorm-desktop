/**
 * Built-in spec quality gate criteria — the single source of truth for what
 * "ready" means before a ticket enters the execution pipeline.
 *
 * No per-project file is read or required. A missing or legacy
 * `.sandstorm/spec-quality-gate.md` on disk is simply ignored.
 */

/**
 * Returns the canonical built-in spec quality gate criteria.
 * Sourced exclusively from this function — no file I/O.
 */
export function getDefaultSpecQualityGate(): string {
  return `# Spec Quality Gate

Criteria for determining whether a ticket is ready for agent dispatch.
Each criterion is **pass/fail**. If any fails, the specific gap must be
resolved before the ticket enters the execution pipeline.

## Verification Policy

Automated testing is **mandatory and assumed** in this project (see CLAUDE.md "Mandatory tests").
The evaluator MUST NOT ask "what verification level is required", "does this need a test",
or "how should this be verified" — tests are always required. Specify the concrete checks:

- Vitest unit/component tests for every new/changed behavior
- A regression test for every bug fix (one that would have caught the bug)
- \`npm run typecheck\` — TypeScript must compile clean
- \`npm run build\` / \`npm run package\` — build must succeed
- All of the above run by \`.sandstorm/verify.sh\`

e2e / Playwright / visual browser verification is **not required** (not yet available
in the stack container). Do NOT fail the gate because e2e tests are absent.

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
- **Idempotency**: What happens if the operation runs twice? Address the scenario even if the answer is "second run is a no-op by design."

### Ambiguity Check
Are there decision points where the agent would have to guess?
- Every ambiguity is a coin flip. Resolve them before dispatch.

### Testability
Is it clear how to verify the work is correct?
- Define what "done" looks like in concrete, automated, testable terms.
- Automated tests are mandatory — specify which: unit tests, regression tests, typecheck, build.
- Do NOT ask the user about verification level; specify the required tests yourself.
- Tests live in \`tests/\` mirroring the source structure; run via \`npm test\`.

### Files/Areas Affected
Are the impacted areas of the codebase identified?
- Point the agent at the right part of the codebase.

### Assumptions — Zero Unresolved
List every assumption the agent would make if it started now.
- **Assumptions are ambiguity. Ambiguity means the spec is incomplete.**
- If an assumption can be validated by reading code, checking APIs, or running commands — the evaluator MUST validate it and replace it with a verified fact or flag it as incorrect.
- If an assumption requires human input (business logic, domain knowledge, product direction, edge case decisions) — it MUST be surfaced as an explicit question that blocks the gate.
- The gate MUST NOT pass with unresolved assumptions. Every assumption must become either a verified fact or an answered question.

### Dependency Contracts
When the ticket references another ticket, module, or external system's output:
- The data contract must be explicit — what format, what interface, when available.
- Read/write timing must be compatible — if the source writes at end-of-process and the consumer reads mid-process, that's a conflict.
- How contract compatibility is verified must be specified.
- If the data source doesn't exist yet, the ticket must include creating it or explicitly depend on a ticket that does.
- The contract must resolve to an enforced artifact — a committed type/interface, a schema, or a contract test — not prose. A contract that exists only in an epic description, a code comment, or an unmerged sibling ticket's text is NOT a contract; FAIL the ticket until the owning ticket lands the artifact (or this ticket creates it). (Consuming existing committed code/types is fine — that IS an enforced artifact.) This rule applies to CODE contracts only — design/reference material (mockups, specs, docs) may remain external; their content is resolved and supplied in the "## Resolved References" section and must be evaluated there.
- Name the single owner of each shared surface the ticket touches; a consumer or extender must reference that owner and must not redefine the shape.

### Contribution to the Whole
If the ticket is part of a larger epic or multi-ticket effort:
- It must name which epic-level acceptance behavior(s) it advances, so coverage is traceable and no envisioned element is orphaned.
- If it cannot point to an acceptance behavior it serves, either the epic's acceptance definition is incomplete or the ticket is scope creep — resolve before dispatch.
- This is the per-ticket coverage check only. It does NOT require end-to-end or visual verification, and it does NOT replace a whole-epic acceptance review (a green ticket is progress, not proof the whole behavior works assembled).
- Skip this criterion for standalone tickets with no parent epic.

### Intent Congruence
Does the proposed approach actually achieve the ticket's stated goal?
- A ticket can be complete and unambiguous but still describe an approach that undercuts its intent. Evaluate alignment between the *what* (proposed solution) and the *why* (stated goal).
- If the ticket has no explicit stated goal, derive intent from the problem statement. If intent is ambiguous, it's an Ambiguity Check fail, not an Intent Congruence fail.
- A proposed solution that resolves the stated problem in a way that undercuts the underlying intent is a fail (e.g., a performance fix that achieves its metric by disabling the feature; a security patch that resolves the finding by removing the protected functionality).

### All Verification Must Be Automatable
Every verification item must be executable autonomously with no human involvement:
- No "manually verify", "visually confirm", "deploy and check".
- No optional verification checkboxes that can be skipped.
- If a verification step can't be expressed as an automated command, test, or assertion, it's not valid.
- The fix isn't "make sure humans check the boxes" — it's "eliminate manual steps entirely".

### Verify Before Asking — No Code-Derivable Questions to the User
The evaluator has full code-reading access (Read, Glob, Grep, Bash) and MUST use it before surfacing any question to the user.

Before adding any question to the gap list, the evaluator MUST:
1. Attempt to answer it by reading the working tree (Read, Glob, Grep are sufficient; do not run destructive commands).
2. If verified, state the verified fact and cite \`file:line\` in the report — do NOT ask the user.
3. Only escalate questions whose answers cannot be found in the codebase (business logic, product direction, domain knowledge, decisions not encoded in code).

Questions that MUST be answered from code, not the user:
- File existence ("does X file exist?") — use Glob/Read.
- Function signatures, parameters, return types — use Read/Grep.
- "Where is X defined?" / "What does Y do?" / "What arguments does Z accept?" — use Grep/Read.
- Control flow, feature flags, timeout values, constants — use Read.
- What a script accepts, what a module exports — use Read.

If a question is partially code-derivable:
- State the verified fact with a \`file:line\` citation.
- Ask only the residual judgment question (the part not in the code).

Verification limit: static reading only. If answering requires executing code, treat as "not feasible to verify statically" and escalate to the user. Exception: external links cited in the ticket body (gists, mockups, design docs) are resolved by the host before evaluation — their content is supplied in the "## Resolved References" section below the ticket. Treat that resolved content as part of the spec. A broken or unreachable referenced link (shown as an error in the Resolved References section) is itself a FAIL — surface the error rather than ignoring it.

Hallucination guard: every claimed verification MUST include a \`file:line\` citation. A verification without a citation is not a verification.
`;
}
