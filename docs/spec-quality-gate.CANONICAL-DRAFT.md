<!--
  DRAFT — canonical content for the future ONE universal in-app spec gate.
  Not wired yet. Review only; the wiring (app-level storage, evaluator reads
  this instead of the per-project file, deprecate per-project copies + init.sh
  seeding) is a separate ticket that goes through a stack.

  Design boundary (per user, this conversation):
    • The GATE decides ticket READINESS — is the spec complete, unambiguous,
      intent-congruent? Universal across all projects.
    • HOW a project verifies (which test commands run; whether E2E data-flow
      traces or headless-browser visual checks are required; infra like xvfb)
      is PROJECT-SPECIFIC EXECUTION POLICY → it lives in PROMPT INSTRUCTIONS,
      not here. That is exactly the content removed from the old app-default
      gate (see "Relocated to prompt instructions" at the bottom).

  Source = union of the three drifted copies, deduped + reconciled to the
  boundary above, plus the new "Intent Congruence" criterion:
    1. .sandstorm/spec-quality-gate.md            (live; read by claude/tools.ts)
    2. src/main/spec-quality-gate.ts getDefault() (app seed; richest criteria)
    3. sandstorm-cli/lib/init.sh heredoc          (barest seed)
-->

# Spec Quality Gate

Criteria for determining whether a ticket is **ready for agent dispatch** —
i.e. whether the *spec* is complete, unambiguous, and faithful to its own
intent. Each criterion is **pass/fail**; if any fails, the specific gap must be
resolved before the ticket enters the execution pipeline.

This is the single source of truth — one universal gate for all projects,
configured in the app.

**Out of scope for this gate:** *how* the work is verified for a given project
(test commands, E2E/visual requirements, CI infra). That is project-specific
execution policy and lives in the project's **prompt instructions**, not here.
The gate only asks whether the spec is *ready* — not how a project runs tests.

---

## Verify before asking — no code-derivable questions to the user

The evaluator has full code-reading access (Read, Glob, Grep, Bash) and MUST use
it before surfacing any question. Before adding a question to the gap list:

1. Try to answer it from the working tree (Read, Glob, Grep).
2. If verified, state the fact and cite `file:line` in the report — do NOT ask.
3. Only escalate questions whose answers are **not** in the codebase — business
   logic, product direction, domain knowledge, decisions not encoded in code.

Answer from code, never the user: file existence, function signatures, where
something is defined, what a module exports, control flow, constants, feature
flags, what a script accepts. If a question is partly code-derivable, state the
verified part with a citation and ask only the residual judgment.

**Do not ask about verification level.** Whether/how the work is tested is fixed
by the project's prompt instructions, not a gate question. The only
verification-related gap that may block the gate is when the *desired behavior
itself* is ambiguous — you cannot say what a test should assert because the
correct outcome is genuinely undefined. Frame that as a **product/behavior**
question ("when X happens, should the result be A or B?").

**Hallucination guard:** every claimed verification MUST include a `file:line`
citation. A verification without a citation is not a verification.

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

### Intent Congruence
Does every resolved decision still serve the ticket's stated intent (the "why")?

The Problem Statement captures *why* this work exists — often a goal like "make X
hands-off," "remove a manual step," "reduce friction." Edge cases, failure modes,
and ambiguities get resolved one at a time, and the defensible-looking *local*
answer — "on failure, abort and surface an error" — can quietly **undercut that
intent**: an abort that drops the user back into the exact manual work the feature
was built to eliminate.

For each resolved edge case, failure-mode, ambiguity, and scope decision, re-read it
against the intent:

- Does this resolution **advance** the intent, or does it reintroduce the friction,
  manual step, confirmation, or configuration the intent set out to remove?
- For "the action can't proceed" cases, separate **"the goal is already satisfied by
  another path"** (→ treat as success and continue; aborting here fights a
  streamlining/hands-off intent) from **"the goal is genuinely blocked and needs a
  human or CI"** (→ aborting may be right — but say so, and prefer graceful recovery
  over a hard stop).
- If a decision trades against the stated intent, that trade-off must be **named and
  justified in the spec** — never buried as "just an edge case."

Completeness asks "is every case handled?"; congruence asks "is every case handled
*in the direction of the goal?*" Flag any resolution where the answer is no.

### Migration Path
If it changes existing behavior, how do existing users/projects transition?
- Skip if the change is purely additive with no breaking impact.

### Edge Cases
Are known edge cases called out?
- List scenarios that could break or behave unexpectedly.
- For each external/mutating operation (shell, git, API, docker), state behavior
  when the target state **already holds** (idempotency) and on **retry after partial
  success**. (This is the lens that catches "PR already merged," "stack already gone,"
  "PR already exists," etc. — and feeds the Intent Congruence check.)

### Ambiguity Check
Are there decision points where the agent would have to guess?
- Every ambiguity is a coin flip. Resolve them before dispatch.

### Assumptions — Zero Unresolved
List every assumption the agent would make if it started now.
- **Assumptions are ambiguity. Ambiguity means the spec is incomplete.**
- If an assumption can be validated by reading code / checking APIs / running
  commands — the evaluator MUST validate it and replace it with a verified fact (with
  citation) or flag it as incorrect.
- If an assumption requires human input (business logic, domain knowledge, product
  direction) — it MUST be surfaced as an explicit question that blocks the gate.
- The gate MUST NOT pass with unresolved assumptions.

### Testability (behavior clarity, not verification method)
Is the *desired behavior* concrete enough that someone could write an assertion
against it?
- This is about whether expected outcomes are **well-defined** — NOT about which
  tests, what level, or what infra (that's prompt-instruction territory).
- If behavior is concrete, this criterion passes. Only flag a gap when an outcome is
  genuinely undefined, and frame it as a behavior question.

### Dependency Contracts
When the ticket references another ticket, module, or external system's output:
- The data contract must be explicit — what format, what interface, when available.
- Read/write timing must be compatible (a consumer reading mid-process from a source
  that writes end-of-process is a conflict).
- If the data source doesn't exist yet, the ticket must include creating it or
  explicitly depend on a ticket that does.

### Files/Areas Affected
Are the impacted areas of the codebase identified?
- Point the agent at the right part of the codebase.

---

## Relocated to prompt instructions (NOT gate criteria)

These were in the old app-default gate but are **project-specific execution /
verification policy**, not ticket-readiness. They move to the project's prompt
instructions (e.g. project `CLAUDE.md` / agent context), where they can differ
per project:

- **Mandatory automated tests + the concrete checks that run** (e.g. this project's
  `verify.sh`: `typecheck` / `test` / `build` / `package`).
- **End-to-End Data Flow Verification** — require a no-mocks trace across layers.
- **Automated Visual Verification (UI tickets)** — headless-browser checks; the
  "no xvfb/Playwright yet" caveat is a per-project fact.
- **All Verification Must Be Automatable** — no manual "deploy and check" steps.

The gate stays silent on all of the above and simply doesn't let the evaluator
turn them into questions for the user.
