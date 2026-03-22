![Sandstorm Desktop](resources/logo.png)

# Sandstorm Desktop

**Deploy a fleet of AI agents. Ship 10x faster.**

Sandstorm Desktop is a local orchestration platform that spins up isolated AI coding agents in parallel. Each agent gets its own Docker environment with a full repo clone, running services, and a dedicated Claude Code instance. You dispatch work, review diffs, and push code — all from one interface.

No cloud. No waiting. No seat limits. Just you and as many agents as your machine can run.

---

## Why Sandstorm?

You have 5 tickets to close before Friday. With a single agent, you work them one at a time. With Sandstorm, you work them all at once.

**Parallel by default.** Each stack is a fully isolated Docker environment. Spin up 5 stacks, dispatch 5 tasks, ship 5 PRs. Agents never step on each other.

**Orchestrate with natural language.** The built-in outer Claude session acts as your command center. Say *"grab tickets EXP-340 through EXP-345 and start them"* and watch stacks spin up.

**Zero infrastructure.** Sandstorm runs entirely on your machine. Docker Compose handles the environments. No servers, no deployment, no API keys beyond your Claude subscription.

**Full visibility.** Live agent output, git diffs, service logs, and task history — all in one window. Review before you push.

---

## How it works

```
You  --->  Outer Claude (orchestrator)
                |
                |--- Stack 1: fix-auth-bug      [Claude agent + services]
                |--- Stack 2: add-search         [Claude agent + services]
                |--- Stack 3: refactor-payments   [Claude agent + services]
```

1. **Open a project** — point Sandstorm at any directory with a `docker-compose.yml`
2. **Create stacks** — each stack clones the repo, boots your services, and starts a Claude Code agent
3. **Dispatch tasks** — describe what you want in plain English
4. **Review and push** — inspect diffs, approve changes, push to remote

---

## Install

### Linux

Download the `.AppImage` from the [latest release](https://github.com/onomojo/sandstorm-desktop/releases/latest).

```bash
chmod +x "Sandstorm Desktop-0.1.0.AppImage"
./"Sandstorm Desktop-0.1.0.AppImage"
```

### macOS

Download the `.dmg` from the [latest release](https://github.com/onomojo/sandstorm-desktop/releases/latest). Open it and drag Sandstorm Desktop to Applications.

---

## Prerequisites

| Dependency | Why |
|---|---|
| **Docker** | Sandstorm runs every stack in containers |
| **Claude Code CLI** | The AI agent inside each stack ([install](https://claude.ai)) |
| **Git** | Cloning repos into isolated workspaces |
| **GitHub CLI** (`gh`) | Pushing changes from stacks |

---

## Quick start

1. Launch Sandstorm Desktop
2. **Open Project** — select a directory with a `docker-compose.yml`
3. **Initialize** — if the project hasn't been set up, click "Initialize Sandstorm"
4. **New Stack** — create an isolated workspace
5. **Dispatch** — type a task and hit send. The inner Claude gets to work.
6. **Orchestrate** — use the outer Claude session at the bottom to manage multiple stacks at once

---

## Features

- **Multi-project tabs** — switch between projects, each with its own stacks and orchestrator session
- **Live agent output** — stream Claude's work in real time
- **Built-in diff viewer** — see exactly what changed before you push
- **Service monitoring** — container status, ports, and logs at a glance
- **Message queuing** — fire off multiple commands without waiting. They execute in order.
- **Persistent sessions** — switch tabs freely. Your conversations and state are preserved.

---

## Development

```bash
npm install          # install dependencies
npm run dev          # run in dev mode
npm test             # run tests
npx tsc --noEmit     # type check
```

### Build & package

```bash
npm run build
npx electron-rebuild
npm run package -- --config.npmRebuild=false
```

### Building for macOS

macOS builds require macOS (for code signing):

```bash
git clone git@github.com:onomojo/sandstorm-desktop.git
cd sandstorm-desktop
npm install
npm run build
npx electron-rebuild
npm run package -- --config.npmRebuild=false
```

Produces a `.dmg` in `release/`.

---

## Architecture

| Layer | Tech |
|---|---|
| Desktop shell | Electron + electron-vite |
| UI | React 18 + Tailwind CSS + Zustand |
| Control plane | sql.js (SQLite) |
| Container runtime | dockerode (Docker API) |
| Agent | Claude Code CLI |
| Packaging | electron-builder |

---

## License

MIT
