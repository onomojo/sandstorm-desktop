# Sandstorm Desktop — Development Rules

This is an Electron desktop app (React + Tailwind + TypeScript). It packages into AppImage (Linux) and .exe (Windows).

## Mandatory dual-loop workflow

Every task MUST follow the dual-loop workflow described below. Do not report a task as complete unless the workflow completes successfully.

```
┌─────────────────────────── OUTER LOOP (max 5 iterations) ───────────────────────────┐
│                                                                                      │
│   ┌─────────────── INNER LOOP (max 5 iterations, resets each outer loop) ──────┐    │
│   │                                                                             │    │
│   │   ┌──────────────┐         ┌──────────────┐                                │    │
│   │   │  EXECUTION   │         │   REVIEW     │                                │    │
│   │   │   AGENT      │────────▶│   AGENT      │                                │    │
│   │   │              │         │ (fresh ctx)  │                                │    │
│   │   │ - Write code │         │ - Code review │                                │    │
│   │   │ - Make fixes │◀───NO───│ - Generate    │                                │    │
│   │   │              │  pass?  │   report      │                                │    │
│   │   └──────────────┘         └──────┬───────┘                                │    │
│   │                                   │ YES                                     │    │
│   └───────────────────────────────────┼─────────────────────────────────────────┘    │
│                                       ▼                                              │
│                              ┌──────────────┐                                        │
│                              │   VERIFY     │                                        │
│                              │   STEP       │                                        │
│                              │              │                                        │
│                              │ - Tests      │──── PASS ────▶ ✅ DONE                │
│                              │ - Types      │                                        │
│                              │ - Build      │                                        │
│                              │ - Package    │                                        │
│                              └──────┬───────┘                                        │
│                                     │ FAIL                                           │
│                                     │                                                │
│                    (back to inner loop — inner counter resets)                        │
└─────────────────────────────────────┘                                                │
                                                                                       │
If either loop exceeds max iterations ──▶ 🛑 STOP — needs human intervention          │
───────────────────────────────────────────────────────────────────────────────────────┘
```

### Three Agents

#### 1. Execution Agent
- Receives the original task (first iteration) or a review/verify failure report (subsequent iterations)
- Writes code, makes changes, runs tests locally
- Hands off to the Review Agent when done

#### 2. Review Agent (fresh context)
- Spins up with a **fresh context** — no carryover from the execution agent's session
- Receives: the original task description + the current diff/changes
- Performs a thorough code review covering:
  - **Architecture** — does it fit the existing patterns?
  - **Best practices** — idiomatic code, proper error handling
  - **Separation of concerns** — no god functions, proper layering
  - **DRY** — no unnecessary duplication
  - **Security** — no injection, XSS, leaked secrets, OWASP top 10
  - **Scalability** — will it hold up under load?
  - **Optimizations** — unnecessary allocations, N+1 queries, etc.
  - **Test coverage** — are the tests meaningful and sufficient?
- Generates a structured report:
  - If issues found → report goes back to Execution Agent
  - If no issues → passes control to Verify step

#### 3. Verify Step
- Runs **once** after the review loop passes (not on every review iteration)
- Runs the full `/verify` suite (tests, types, build, electron-rebuild, package, run)
- If pass → work is complete
- If fail → error output goes back to the Execution Agent (outer loop iterates, inner loop counter resets)

### Loop Constraints

| Loop | Max Iterations | Resets? |
|------|---------------|---------|
| **Inner** (execution ↔ review) | 5 | Yes — resets to 0 each time the outer loop starts a new iteration |
| **Outer** (inner loop → verify → repeat) | 5 | No — counts total verify failures |

If either loop exceeds its max, the workflow halts and reports that human intervention is needed. It should NOT silently continue or force-pass.

### Example Flow

1. Task arrives → **Execution Agent** writes code (inner iteration 1)
2. **Review Agent** finds 2 issues → report back to Execution Agent (inner iteration 2)
3. **Execution Agent** fixes issues
4. **Review Agent** approves → proceed to Verify
5. **Verify** fails (type error) → back to Execution Agent (outer iteration 2, inner counter resets to 0)
6. **Execution Agent** fixes type error (inner iteration 1 of outer iteration 2)
7. **Review Agent** approves
8. **Verify** passes → Done

### Implementation Notes

- The Review Agent must have a **fresh context** — this is the whole point. It catches things the execution agent is blind to after working in the weeds.
- The review report should be structured (not free-form) so the execution agent can act on it systematically.
- The loop counters and state transitions should be clearly logged so debugging is straightforward.

## Mandatory tests

Every code change — new features, bug fixes, refactors — MUST include tests. Work is NOT considered complete until tests are written and all tests pass. No exceptions.

- New components require unit tests covering rendering, user interactions, and edge cases
- Bug fixes require a regression test that would have caught the bug
- Tests live in `tests/` mirroring the source structure (e.g., `tests/unit/components/` for renderer components)
- Follow existing test patterns: Vitest + @testing-library/react for components, see `tests/unit/components/` for examples
- Run `npm test` to verify all tests pass before marking work complete

## Product vision

Sandstorm Desktop is a cross-platform control plane for managing isolated agent stacks. Think Docker Desktop but oriented towards AI agent orchestration.

**Multi-project:** The app has project tabs. User opens a project directory, it reads `.sandstorm/config`. An "All" tab shows stacks across all projects. New Stack dialog inherits the project context — no typing project directories.

**Self-contained:** The sandstorm CLI scripts are bundled into the Electron app. User installs Sandstorm Desktop, opens it, points at a project. If not initialized, they click "Initialize Sandstorm" and it runs init. No separate CLI install.

**Pluggable agent backend:** Currently uses Claude Code as the inner agent. The agent layer should be behind an interface so it can be swapped for other LLMs/tools in the future (Codex, Gemini, raw API, etc.). Don't over-engineer this now, but don't scatter Claude-specific assumptions throughout the codebase either.

## Tech stack

- Electron + electron-vite (builds to `out/`)
- React 18 + Tailwind CSS + Zustand
- better-sqlite3 (native module — must be rebuilt for Electron)
- dockerode for Docker API
- Vitest for unit/integration tests
- electron-builder for packaging

## Outer Claude vs Inner Claude — Orchestration Boundary

**CRITICAL ARCHITECTURAL RULE**

- **Outer Claude = Orchestrator** — manages stacks, dispatches tasks, reads results. NEVER edits source code directly.
- **Inner Claude = Worker** — runs inside an isolated Docker container. All code changes happen here.

**Files Outer Claude may modify:**
- `CLAUDE.md`
- `.claude/` (settings, memory)
- `.sandstorm/` (project config)
- Memory files

**Paths that must go through a stack:**
- `src/**`
- `tests/**`
- `package.json`

If a change touches application code, it goes through a stack. No exceptions.

## Deterministic workflow philosophy

Routine workflows — refine, start, make-PR, push, schedule fires — MUST
NOT route through the outer-Claude chat session. The outer chat is
reserved for novel / exploratory work where the user is actively engaged.
Every recurring or automatable workflow goes through one of:

1. **A shell script** at `.sandstorm/scripts/<name>.sh`, installed from the
   provider template set (`github` / `jira` / `skeleton`). Provider-neutral.
   Mirrors the existing `fetch-ticket.sh` / `update-ticket.sh` / `create-pr.sh`
   pattern — one contract, one script per provider, one TS wrapper.
2. **An IPC handler** in `src/main/ipc.ts` that calls deterministic modules
   under `src/main/control-plane/`. May include a **bounded ephemeral
   LLM call** via `agentBackend.runEphemeralAgent` — single subprocess,
   explicit timeout, NEVER adds messages to the chat session, NEVER
   accumulates state across calls. Used e.g. for the Make-PR title/body
   draft and the spec quality gate evaluator.
3. **A scheduler action kind** (`src/main/scheduler/types.ts`) whose
   dispatch routes to (1) or (2). `run-script` is the escape hatch;
   built-in kinds wrap specific deterministic flows.

### Why

- Outer Claude chat sessions accumulate context across turns. Every fire
  of a recurring workflow costs tokens that keep growing — the session
  doesn't reset.
- Chat turns appear in the UI and the token counter. Automation that
  silently wakes up the chat is visually misleading and
  rate-limit-dangerous (scheduled work while the user is asleep can
  exhaust the limit).
- Interactive refinement doesn't compose with cron. If a workflow
  requires a conversation to finish, it's not a schedule-ready workflow;
  it belongs as a button.

### Hard rules

- Scheduled / automated work **MUST NOT** call `agentBackend.sendMessage`,
  `agentBackend.getHistory`, or any chat-session API. Automation paths
  are grepped for these as a gate.
- Freeform user prompts **MUST NOT** be stored on long-running schedules.
  If a schedule carries user text, it's already the wrong shape — route
  it through an action kind that maps to a deterministic primitive.
- Don't add a feature's "also works on a schedule" affordance by wiring
  the button's handler to `agentBackend.sendMessage`. Write the
  deterministic path first; the button and the scheduler both call that.

### When adding a new workflow

Start from `fetch-ticket.sh` as the template:

1. Write one provider-neutral shell script under
   `sandstorm-cli/templates/{github,jira,skeleton}/scripts/<name>.sh` with
   an explicit input/output contract documented at the top of the file.
2. Add a thin TS wrapper in `src/main/control-plane/` that shells the
   script and returns a structured result (mirrors
   `updateTicketBody` / `fetchTicketContext`).
3. Expose an IPC handler in `src/main/ipc.ts` that calls the wrapper and
   returns a renderer-friendly shape.
4. Wire a button in the renderer that calls the IPC handler.

Schedulability comes for free once those four exist — add a new
`ScheduleAction` kind that calls the same IPC handler/module.

## Stack teardown rule

NEVER tear down stacks unless the user explicitly says to tear down a stack. No exceptions.

- Do not infer that a stack should be torn down
- Do not tear down stacks to "make room" for new ones
- Do not tear down stacks that look stale or old
- Do not tear down stacks as a precursor to creating new ones
- Do not automatically clean up stacks after pushing

The ONLY valid trigger is the user directly and explicitly requesting teardown.

Violating this rule has caused loss of unpushed work. This is a hard rule.

## Key files

- `package.json` — main entry is `out/main/index.js`
- `electron-builder.yml` — files section includes `out/**/*`
- `electron-vite.config.ts` — build config
- `src/main/` — Electron main process
- `src/main/scheduler/` — cron-driven scheduled-action subsystem. Dispatch
  handler is in `src/main/index.ts`; NEVER routes to outer-Claude chat.
- `src/main/control-plane/` — deterministic workflow modules
  (ticket-spec, ticket-updater, ticket-creator, ticket-provider, pr-creator,
  stack-manager). These are the primitives that buttons and schedules
  both compose.
- `src/renderer/` — React UI
- `src/preload/` — IPC bridge
- `.sandstorm/scripts/` — per-project provider scripts (`fetch-ticket.sh`,
  `update-ticket.sh`, `create-pr.sh`, `start-ticket.sh`) plus
  `.sandstorm/scripts/scheduled/` for the `run-script` scheduler action.
- `tailwind.config.js` — theme colors under `sandstorm.*`
- `sandstorm-cli/templates/<provider>/scripts/` — the github / jira /
  skeleton script templates copied into a project by `sandstorm init`.
