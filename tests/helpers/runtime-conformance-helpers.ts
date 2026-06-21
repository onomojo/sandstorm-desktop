import { expect } from 'vitest';
import type { ContainerRuntime } from '../../src/main/runtime/types';

/** Assert that a runtime instance exposes every required interface method. */
export function assertInterfaceComplete(runtime: ContainerRuntime): void {
  const required = [
    'composeUp',
    'composeDown',
    'listContainers',
    'inspect',
    'logs',
    'containerStats',
    'exec',
    'inspectImage',
    'isAvailable',
    'version',
  ];
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(runtime));
  for (const method of required) {
    expect(methods, `Missing method: ${method}`).toContain(method);
  }
}

/** Assert that inspectImage returns null for an image that does not exist. */
export async function assertInspectImageUnknown(runtime: ContainerRuntime): Promise<void> {
  const result = await runtime.inspectImage('sandstorm-parity-test-nonexistent-image:9999');
  expect(result).toBeNull();
}

/** Assert that listContainers returns an array with the expected shape. */
export async function assertListContainersShape(runtime: ContainerRuntime): Promise<void> {
  const containers = await runtime.listContainers();
  expect(Array.isArray(containers)).toBe(true);

  if (containers.length > 0) {
    const c = containers[0];
    expect(typeof c.id).toBe('string');
    expect(typeof c.name).toBe('string');
    expect(typeof c.status).toBe('string');
    expect(Array.isArray(c.ports)).toBe(true);
  }
}

/**
 * Assert that filtering by a label that no container has returns an empty array.
 * Safe to call without any running containers.
 */
export async function assertListContainersLabelFilterEmpty(runtime: ContainerRuntime): Promise<void> {
  const results = await runtime.listContainers({ label: 'sandstorm-parity-test-nonexistent=xyz9999' });
  expect(Array.isArray(results)).toBe(true);
  expect(results).toHaveLength(0);
}

/** Assert that exec runs a command and returns its stdout. */
export async function assertExecReturnsStdout(runtime: ContainerRuntime, containerId: string): Promise<void> {
  const result = await runtime.exec(containerId, ['echo', 'hello']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('hello');
}

/** Assert that exec captures stdout and stderr separately. */
export async function assertExecCapturesStderr(runtime: ContainerRuntime, containerId: string): Promise<void> {
  const result = await runtime.exec(containerId, ['sh', '-c', 'echo err >&2; echo out']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('out');
  expect(result.stderr.trim()).toBe('err');
}

/** Assert that exec returns non-zero exit codes. */
export async function assertExecNonZeroExit(runtime: ContainerRuntime, containerId: string): Promise<void> {
  const result = await runtime.exec(containerId, ['sh', '-c', 'exit 42']);
  expect(result.exitCode).toBe(42);
}

/** Assert that exec pipes opts.input to stdin (cat-style roundtrip). */
export async function assertExecInputRoundtrip(runtime: ContainerRuntime, containerId: string): Promise<void> {
  const result = await runtime.exec(containerId, ['cat'], { input: 'hello stdin\n' });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('hello stdin\n');
}
