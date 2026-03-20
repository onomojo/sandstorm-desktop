# Sandstorm Desktop — Development Rules

This is an Electron desktop app (React + Tailwind + TypeScript). It packages into AppImage (Linux) and .exe (Windows).

## Mandatory verification loop

Every task MUST end with a successful verification loop. Do not report a task as complete unless ALL steps pass:

### Step 1: Tests
```bash
npm test
```
ALL tests must pass. If any fail, fix the code and rerun.

### Step 2: TypeScript
```bash
npx tsc --noEmit
```
Zero type errors. If any exist, fix and rerun.

### Step 3: Build
```bash
npm run build
```
Must complete without errors. If it fails, fix and rebuild.

### Step 4: Rebuild native modules for Electron
```bash
npx electron-rebuild
```
This recompiles native addons (better-sqlite3) against Electron's Node ABI. If `cpu-features` fails to build (g++ too old for `-std=gnu++20`), that's OK — it's optional. But better-sqlite3 MUST succeed.

**WHY THIS MATTERS:** The container runs Node 22 (NODE_MODULE_VERSION 127). Electron uses its own Node (MODULE_VERSION 130). If you skip this step or let `npm run package` do it wrong, the packaged app will crash with `NODE_MODULE_VERSION` mismatch on the user's machine.

### Step 5: Package
```bash
npm run package -- --config.npmRebuild=false
```
We pass `--config.npmRebuild=false` here because we already rebuilt in Step 4. If electron-builder tries to rebuild again, it may undo our work or fail on optional deps.

Must produce files in `release/`.

### Step 6: Run
```bash
./release/"Sandstorm Desktop-0.1.0.AppImage" --no-sandbox 2>&1 | head -30
```
The app MUST launch without crashing. If it crashes with NODE_MODULE_VERSION errors, go back to Step 4 — the native module rebuild failed or was skipped. If it crashes for other reasons, read the error, fix, and go back to Step 3.

### Step 7: Visual verification
If you changed any UI code, use the Chrome DevTools MCP to take a screenshot of the running app and verify it looks correct. No black text on dark backgrounds. No broken layouts.

## The loop

If ANY step fails, fix the issue and restart from Step 1. Do not skip steps. Do not report success without completing all 6 steps.

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
