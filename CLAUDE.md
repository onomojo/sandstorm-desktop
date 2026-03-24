# Sandstorm Desktop — Development Rules

This is an Electron desktop app (React + Tailwind + TypeScript). It packages into AppImage (Linux) and .exe (Windows).

## Mandatory verification loop

Every task MUST end with a successful /verify. This runs all build verification steps (tests, types, build, electron-rebuild, package, run). Do not report a task as complete unless /verify passes.

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

## Key files

- `package.json` — main entry is `out/main/index.js`
- `electron-builder.yml` — files section includes `out/**/*`
- `electron-vite.config.ts` — build config
- `src/main/` — Electron main process
- `src/renderer/` — React UI
- `src/preload/` — IPC bridge
- `tailwind.config.js` — theme colors under `sandstorm.*`
