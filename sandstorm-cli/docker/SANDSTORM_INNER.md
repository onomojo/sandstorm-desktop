# Sandstorm Inner Claude

You are running inside a Sandstorm stack — an isolated Docker environment with its own database, services, and repo clone.

## Running commands on other services

Use `sandstorm-exec` to run commands on sibling service containers:

```bash
sandstorm-exec <service> <command> [args...]
```

For example:
- **Run tests:** `sandstorm-exec app npm test`
- **Run Rails tests:** `sandstorm-exec api bash -c 'cd /rails && bin/rails test'`
- **Run a specific test:** `sandstorm-exec api bash -c 'cd /rails && bin/rails test test/controllers/api/v1/some_controller_test.rb'`
- **Rails console:** `sandstorm-exec api bash -c 'cd /rails && bin/rails console'`
- **Check logs:** `docker logs ${SANDSTORM_PROJECT}-api-1`

The actual services available in your stack are listed in the **Stack Services** section below (injected at startup). Use `sandstorm-exec` with the service names listed there.

**IMPORTANT:** Do NOT install languages or run project commands directly on this container. Always use `sandstorm-exec` to run commands on the appropriate service container.

## Code editing

Edit files directly in `/app` — this is a clone of the repo. Changes you make here are visible to the running services via bind mounts.

## Browser Automation (Chrome DevTools MCP)

You have a headless Chromium browser available via Chrome DevTools MCP tools. Use these to:
- Navigate to pages, click elements, fill forms, type text
- Take screenshots to visually verify UI
- Inspect console messages and network requests
- Run Lighthouse audits and performance traces

### Accessing stack services in the browser

Use Docker service hostnames to reach services in this stack (see Stack Services section for actual service names and ports).

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
4. Once review passes, **verification runs** your project's `.sandstorm/verify.sh` script
5. If verification fails, you'll receive the error output — **fix the failures**

This loop repeats until review + verification both pass (or max iterations are reached).

### What this means for you

- **Write tests** for every code change — missing tests will fail review
- **Don't skip error handling** — the review agent checks for it
- **When you receive review feedback**, fix exactly what's listed. Don't refactor unrelated code.
- **When you receive verify failures**, focus on the specific errors (test failures, type errors, build errors)
- The review agent has NO context from your session — it only sees the task description and your diff. Write clean, self-explanatory code.

### Scope constraints on iteration 2+

Every iteration prompt after the first re-injects the original task verbatim. On review-fix and verify-fix iterations you will receive explicit scope constraints:

- **Do not modify files outside the scope of the original task.** The reviewer will reject out-of-scope changes regardless of code quality.
- **Do not modify tests to make them pass.** Fix production code instead.
- **Do not loosen assertions, skip test cases, or weaken error checks.**

### STOP_AND_ASK — deadlock break

If you determine that verify cannot pass **without** making out-of-scope changes (e.g., a pre-existing broken test unrelated to your ticket keeps failing), do NOT silently drift. Instead, output exactly:

```
STOP_AND_ASK: <one-sentence reason naming the out-of-scope file or problem>
```

on its own line, then stop immediately without making further changes. The harness will halt the loop, set the stack status to `needs_human`, and surface your reason to the human operator. The human will then fix the pre-existing issue separately and re-dispatch your ticket.

## What you should NOT do

- Do not push to GitHub (you only have read-only access)
- Do not switch git branches — stay on whatever branch was checked out when the stack started. Your branch was set by the orchestrator; switching to another branch will cause your work to land in the wrong place.
- Do not modify Docker infrastructure (don't stop/start containers)
- Do not install languages or runtimes in this container — use `sandstorm-exec` to run commands on the service containers instead
