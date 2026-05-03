import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DockerRuntime } from '../../src/main/runtime/docker';

describe('Stack Lifecycle (Integration)', () => {
  let runtime: DockerRuntime;
  let dockerAvailable: boolean;

  beforeAll(async () => {
    runtime = new DockerRuntime();
    dockerAvailable = await runtime.isAvailable();
  });

  afterAll(() => {
    // Cleanup is handled per-test
  });

  it('can connect to Docker and list containers', async () => {
    if (!dockerAvailable) return;
    const containers = await runtime.listContainers();
    expect(Array.isArray(containers)).toBe(true);
  });

  it('reports Docker version', async () => {
    if (!dockerAvailable) return;
    const version = await runtime.version();
    expect(version).toMatch(/^Docker /);
  });

  it('can inspect a running container if any exist', async () => {
    if (!dockerAvailable) return;
    const containers = await runtime.listContainers({ status: 'running' });
    if (containers.length === 0) {
      return;
    }

    const info = await runtime.inspect(containers[0].id);
    expect(info.id).toBeTruthy();
    expect(info.state.running).toBe(true);
  });
});
