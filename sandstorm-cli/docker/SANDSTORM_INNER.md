# Sandstorm Inner Claude

You are running inside a Sandstorm stack — an isolated Docker environment with its own database, services, and repo clone.

## Running commands on other services

You have Docker access. To run commands on other containers in this stack, use:

```bash
docker exec ${SANDSTORM_PROJECT}-<service>-1 <command>
```

For example:
- **Run Rails tests:** `docker exec ${SANDSTORM_PROJECT}-api-1 bash -c 'cd /rails && bin/rails test'`
- **Run a specific test:** `docker exec ${SANDSTORM_PROJECT}-api-1 bash -c 'cd /rails && bin/rails test test/controllers/api/v1/quest_progress_controller_test.rb'`
- **Rails console:** `docker exec -it ${SANDSTORM_PROJECT}-api-1 bash -c 'cd /rails && bin/rails console'`
- **Run frontend tests:** `docker exec ${SANDSTORM_PROJECT}-app-1 bash -c 'cd /app && npm test'`
- **Check API logs:** `docker logs ${SANDSTORM_PROJECT}-api-1`

The `SANDSTORM_PROJECT` environment variable contains the stack name (e.g., `sandstorm-examprep-1`).

## Code editing

Edit files directly in `/app` — this is a clone of the repo. Changes you make here are visible to the running services via bind mounts.

## Browser Automation (Chrome DevTools MCP)

You have a headless Chromium browser available via Chrome DevTools MCP tools. Use these to:
- Navigate to pages, click elements, fill forms, type text
- Take screenshots to visually verify UI
- Inspect console messages and network requests
- Run Lighthouse audits and performance traces

### Accessing stack services in the browser

Use Docker service hostnames to reach services in this stack:
- `http://app:3000` — frontend
- `http://api:3000` — API

### Common patterns

- **Verify UI:** `navigate_page` → `take_screenshot`
- **Debug JS errors:** `navigate_page` → `list_console_messages`
- **Fill a form:** `navigate_page` → `fill` / `click`
- **Check network:** `navigate_page` → `list_network_requests`

## Dual-Loop Workflow

Your work goes through an automated review and verification loop:

1. **You write code** (execution pass)
2. **A review agent** (with fresh context) reviews your diff against the original task
3. If the review finds issues, you'll receive a report — **fix all listed issues without argument**
4. Once review passes, **verification runs**: `npm test`, `tsc --noEmit`, `npm run build`
5. If verification fails, you'll receive the error output — **fix the failures**

This loop repeats until review + verification both pass (or max iterations are reached).

### What this means for you

- **Write tests** for every code change — missing tests will fail review
- **Don't skip error handling** — the review agent checks for it
- **When you receive review feedback**, fix exactly what's listed. Don't refactor unrelated code.
- **When you receive verify failures**, focus on the specific errors (test failures, type errors, build errors)
- The review agent has NO context from your session — it only sees the task description and your diff. Write clean, self-explanatory code.

## What you should NOT do

- Do not push to GitHub (you only have read-only access)
- Do not switch git branches — stay on whatever branch was checked out when the stack started. Your branch was set by the orchestrator; switching to another branch will cause your work to land in the wrong place.
- Do not modify Docker infrastructure (don't stop/start containers)
- Do not install languages or runtimes in this container — use the service containers instead
