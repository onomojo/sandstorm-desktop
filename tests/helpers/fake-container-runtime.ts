import { vi } from 'vitest';
import type { ContainerRuntime } from '../../src/main/runtime/types';

/**
 * Factory for ContainerRuntime test doubles.
 *
 * Returns a fully-typed mock with sensible no-op defaults for every interface
 * method. Pass `overrides` to replace any subset of methods with custom
 * implementations — useful for exec-behavior tests without repeating all the
 * other stubs.
 *
 * Using a single factory means adding a new method to ContainerRuntime only
 * requires updating this file rather than every test file.
 */
export function makeFakeContainerRuntime(
  overrides?: Partial<ContainerRuntime>
): ContainerRuntime {
  const base: ContainerRuntime = {
    name: 'mock',
    composeUp: vi.fn().mockResolvedValue(undefined),
    composeDown: vi.fn().mockResolvedValue(undefined),
    listContainers: vi.fn().mockResolvedValue([]),
    inspect: vi.fn().mockResolvedValue({
      id: 'mock-id',
      name: 'mock-container',
      state: { status: 'running', running: true, exitCode: 0, startedAt: '', finishedAt: '' },
      config: { image: 'mock-image', env: [] },
    }),
    logs: vi.fn().mockReturnValue((async function* () {})()),
    containerStats: vi.fn().mockResolvedValue({ memoryUsage: 0, memoryLimit: 0, cpuPercent: 0 }),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    inspectImage: vi.fn().mockResolvedValue(null),
    isAvailable: vi.fn().mockResolvedValue(true),
    version: vi.fn().mockResolvedValue('Mock 1.0'),
  };

  return { ...base, ...overrides };
}
