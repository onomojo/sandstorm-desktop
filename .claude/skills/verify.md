---
name: verify
description: Run the full build verification loop. Sandstorm-aware — runs commands in the app service container when inside a stack.
trigger: when the user asks to verify, build, package, test, or run the verification loop
user_invocable: true
---

# Full Build Verification Loop

Run all verification steps in order. If ANY step fails, fix the issue and restart from Step 1. Do not report success without completing all steps.

## Environment Detection

First, detect whether you are inside a Sandstorm stack:

```bash
echo "${SANDSTORM_STACK_ID:-not-set}"
```

- **Inside a Sandstorm stack** (`SANDSTORM_STACK_ID` is set): Run ALL build/test commands via `docker exec` on the app service container. Edit code directly in `/app`, but execute commands in the container where node_modules and native tooling live.

  Command pattern:
  ```bash
  docker exec ${SANDSTORM_STACK_ID}-app-1 bash -c '<command>'
  ```

- **Outside a stack** (`SANDSTORM_STACK_ID` is `not-set`): Run commands directly in the current shell.

## Step 1: Tests

```bash
npm test
```

ALL tests must pass. If any fail, fix the code and rerun from Step 1.

## Step 2: TypeScript

```bash
npx tsc --noEmit
```

Zero type errors. If any exist, fix and rerun from Step 1.

## Step 3: Build

```bash
npm run build
```

Must complete without errors. If it fails, fix and restart from Step 1.

## Step 4: Package

```bash
npm run package
```

Must produce files in `release/`. No native module rebuild is needed — sql.js is WASM-based.

## Step 5: Run

```bash
./release/"Sandstorm Desktop-0.1.0.AppImage" --no-sandbox 2>&1 | head -30
```

The app MUST launch without crashing. If it crashes, read the error, fix, and go back to Step 1.

## Step 6: Visual verification

If you changed any UI code, use the Chrome DevTools MCP to take a screenshot of the running app and verify it looks correct. No black text on dark backgrounds. No broken layouts.
