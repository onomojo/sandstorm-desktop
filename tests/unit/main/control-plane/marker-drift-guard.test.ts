/**
 * Drift-guard test (ticket #557, Dependency Contracts).
 *
 * The token-limit marker and {-filter appear in two places:
 *   1. sandstorm-cli/docker/task-runner.sh — check_for_token_limit()
 *   2. StackManager.recheckCompletedStack — the inline exec command
 *
 * This test reads task-runner.sh and asserts the desktop re-check command
 * uses the identical marker string and {-line exclusion, so a change to
 * one side without the other is caught in CI.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const TASK_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../../sandstorm-cli/docker/task-runner.sh',
);

const STACK_MANAGER_PATH = path.resolve(
  __dirname,
  '../../../../src/main/control-plane/stack-manager.ts',
);

describe('token-limit marker drift guard', () => {
  it('task-runner.sh check_for_token_limit contains the expected marker', () => {
    const source = fs.readFileSync(TASK_RUNNER_PATH, 'utf8');
    // The function should exist
    expect(source).toContain('check_for_token_limit');
    // The marker string (case-insensitive grep)
    expect(source).toContain("You've hit your session limit");
    // The {-filter
    expect(source).toMatch(/\^\[\[:space:\]\]\*.*\{/);
  });

  it('stack-manager.ts recheckCompletedStack uses the same marker as task-runner.sh', () => {
    const shellSource = fs.readFileSync(TASK_RUNNER_PATH, 'utf8');
    const tsSource = fs.readFileSync(STACK_MANAGER_PATH, 'utf8');

    // Extract the marker from task-runner.sh
    // The line looks like: grep -qi "You've hit your session limit"
    const markerMatch = shellSource.match(/grep -qi\s+"([^"]+)"/);
    expect(markerMatch).not.toBeNull();
    const marker = markerMatch![1];

    // The desktop re-check command must contain the same marker
    expect(tsSource).toContain(marker);
  });

  it('stack-manager.ts recheckCompletedStack uses the {-line exclusion', () => {
    const tsSource = fs.readFileSync(STACK_MANAGER_PATH, 'utf8');

    // The exec command must include the {-filter (grep -vE '^[[:space:]]*\{')
    // Allow for JS string escaping (\\{ or \{)
    expect(tsSource).toMatch(/\^\[\[:space:\]\]\*\\*\{/);
  });

  it('stack-manager.ts recheckCompletedStack targets /tmp/claude-raw.log', () => {
    const tsSource = fs.readFileSync(STACK_MANAGER_PATH, 'utf8');
    expect(tsSource).toContain('/tmp/claude-raw.log');
  });
});
