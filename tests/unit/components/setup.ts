import { vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

// Mock window.sandstorm API
export function mockSandstormApi() {
  const api = {
    projects: {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn().mockResolvedValue({ id: 1, name: 'test', directory: '/test', added_at: '' }),
      remove: vi.fn().mockResolvedValue(undefined),
      browse: vi.fn().mockResolvedValue(null),
      checkInit: vi.fn().mockResolvedValue(true),
      initialize: vi.fn().mockResolvedValue(true),
    },
    stacks: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'test-stack', project: 'proj', status: 'building', services: [] }),
      teardown: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      history: vi.fn().mockResolvedValue([]),
      setPr: vi.fn().mockResolvedValue(undefined),
    },
    tasks: {
      dispatch: vi.fn().mockResolvedValue({ id: 1, stack_id: 'test', prompt: '', status: 'running' }),
      list: vi.fn().mockResolvedValue([]),
    },
    diff: {
      get: vi.fn().mockResolvedValue(''),
    },
    push: {
      execute: vi.fn().mockResolvedValue(undefined),
    },
    ports: {
      get: vi.fn().mockResolvedValue([]),
    },
    logs: {
      stream: vi.fn().mockResolvedValue(''),
    },
    stats: {
      stackMemory: vi.fn().mockResolvedValue(0),
      stackDetailed: vi.fn().mockResolvedValue({ stackId: '', totalMemory: 0, containers: [] }),
      taskMetrics: vi.fn().mockResolvedValue({ stackId: '', totalTasks: 0, completedTasks: 0, failedTasks: 0, runningTasks: 0, avgTaskDurationMs: 0 }),
    },
    runtime: {
      available: vi.fn().mockResolvedValue({ docker: true, podman: false }),
    },
    claude: {
      send: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockResolvedValue(undefined),
      history: vi.fn().mockResolvedValue({ messages: [], processing: false }),
    },
    on: vi.fn().mockReturnValue(() => {}),
  };

  Object.defineProperty(window, 'sandstorm', {
    value: api,
    writable: true,
    configurable: true,
  });

  return api;
}
