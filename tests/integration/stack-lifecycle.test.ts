import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DockerRuntime } from '../../src/main/runtime/docker';

describe('Stack Lifecycle (Integration)', () => {
  let runtime: DockerRuntime;

  beforeAll(async () => {
    runtime = new DockerRuntime();
    const available = await runtime.isAvailable();
    if (!available) {
      throw new Error('Docker is not available — skipping integration tests');
    }
  });

  afterAll(() => {
    // Cleanup is handled per-test
  });

  it('can connect to Docker and list containers', async () => {
    const containers = await runtime.listContainers();
    expect(Array.isArray(containers)).toBe(true);
  });

  it('reports Docker version', async () => {
    const version = await runtime.version();
    expect(version).toMatch(/^Docker /);
  });

  it('can inspect a running container if any exist', async () => {
    const containers = await runtime.listContainers({ status: 'running' });
    if (containers.length === 0) {
      // No running containers — skip this test gracefully
      return;
    }

    const info = await runtime.inspect(containers[0].id);
    expect(info.id).toBeTruthy();
    expect(info.state.running).toBe(true);
  });
});
