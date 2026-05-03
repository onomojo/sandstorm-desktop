# Contributing to Sandstorm Desktop

## Test style guide

### Anti-pattern: silently assuming a runtime environment

Tests that assume specific binaries, paths, or auth state without defending
against those assumptions being wrong will fail with confusing assertion
messages in any environment that differs from the original author's laptop.
This has caused agents to rewrite production code trying to "fix" tests that
were actually broken by a missing prerequisite.

**Examples of the smell:**

```typescript
// BAD — no guard; fails with "expected [] to have length N" if jq is absent
spawnSync('bash', [TOKEN_COUNTER_SCRIPT, outFile]);
expect(lines).toHaveLength(2);

// BAD — no guard; HOME=/root is wrong in many container environments
env: { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin' }

// BAD — asserts claude is authenticated without checking if it's even installed
expect(state.claudeAvailable).toBe(true);
```

### The three remediations (pick the right one)

#### 1. Assert the prerequisite loudly

Use this when the binary/tool **should be present** in all target environments
(e.g., `git` in a dev container, `bash` everywhere). Throw with a message that
names the missing binary:

```typescript
beforeAll(() => {
  const result = spawnSync('which', ['git'], { encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(
      'git binary not found on PATH — install git to run these tests.'
    );
  }
});
```

#### 2. Skip with a reason when the prerequisite is absent

Use this when the test can only run in **specific environments** (e.g., needs
an authenticated external CLI, a specific display server, or network access).
`test.skip` / `it.skip` in Vitest; `test.skip(condition, reason)` in Playwright:

```typescript
// Vitest
const hasClaude = spawnSync('which', ['claude']).status === 0;
it.skipIf(!hasClaude)('renders usage bar', () => { ... });

// Playwright
const hasClaudeCli = spawnSync('which', ['claude'], { encoding: 'utf-8' }).status === 0;
test('renders usage bar', async ({ mainWindow }) => {
  test.skip(!hasClaudeCli, 'claude CLI not found on PATH — requires live, authenticated claude');
  // ...
});
```

The reason string must name the missing prerequisite — not just say "skip".

#### 3. Decouple from the environment entirely

Use this when the test can be made **environment-independent** by mocking the
external dependency. Prefer this for unit tests:

```typescript
// Instead of spawning the real CLI, mock the module
vi.mock('../../src/main/control-plane/claude-backend', () => ({
  runEphemeralAgent: vi.fn().mockResolvedValue({ output: '...' }),
}));
```

### Environment values in fixtures

Never hardcode environment values that differ across machines. Use the current
process's environment and fall back only when the variable is absent:

```typescript
// BAD
env: { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin' }

// GOOD
env: {
  ...process.env,
  HOME: process.env.HOME ?? '/root',
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
}
```

### Checklist for new tests

Before opening a PR that adds or modifies tests, verify:

- [ ] No hardcoded `HOME=`, `PATH=`, `/root`, or `/usr/local/bin` values
- [ ] Any `exec`/`spawn` call that depends on a system binary has a `beforeAll`
      guard that fails loudly if the binary is absent
- [ ] Any assertion on external auth state (claude CLI, GitHub token, etc.) is
      wrapped in a `skip` that fires when the prerequisite is absent
- [ ] `toBeVisible()` assertions on UI elements that depend on external data
      (usage stats, token counts, auth state) are guarded by a skip or a mock
