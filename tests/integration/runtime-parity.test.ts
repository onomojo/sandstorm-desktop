import { describe, it, expect, beforeAll } from 'vitest';
import { DockerRuntime } from '../../src/main/runtime/docker';
import { PodmanRuntime } from '../../src/main/runtime/podman';

describe('Runtime Parity (Integration)', () => {
  let dockerRuntime: DockerRuntime;
  let podmanRuntime: PodmanRuntime;
  let dockerAvailable: boolean;
  let podmanAvailable: boolean;

  beforeAll(async () => {
    dockerRuntime = new DockerRuntime();
    podmanRuntime = new PodmanRuntime();
    dockerAvailable = await dockerRuntime.isAvailable();
    podmanAvailable = await podmanRuntime.isAvailable();
  });

  it('both runtimes implement the same interface', () => {
    // Verify both have the same methods
    const dockerMethods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(dockerRuntime)
    ).sort();
    const podmanMethods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(podmanRuntime)
    ).sort();

    // Both should have core interface methods
    const required = [
      'composeUp',
      'composeDown',
      'listContainers',
      'inspect',
      'logs',
      'exec',
      'isAvailable',
      'version',
    ];

    for (const method of required) {
      expect(dockerMethods).toContain(method);
      expect(podmanMethods).toContain(method);
    }
  });

  it('both have a name property', () => {
    expect(dockerRuntime.name).toBe('docker');
    expect(podmanRuntime.name).toBe('podman');
  });

  it('Docker listContainers returns consistent format', async () => {
    if (!dockerAvailable) return;

    const containers = await dockerRuntime.listContainers();
    expect(Array.isArray(containers)).toBe(true);

    if (containers.length > 0) {
      const c = containers[0];
      expect(typeof c.id).toBe('string');
      expect(typeof c.name).toBe('string');
      expect(typeof c.status).toBe('string');
      expect(Array.isArray(c.ports)).toBe(true);
    }
  });

  it('Podman listContainers returns consistent format', async () => {
    if (!podmanAvailable) return;

    const containers = await podmanRuntime.listContainers();
    expect(Array.isArray(containers)).toBe(true);

    if (containers.length > 0) {
      const c = containers[0];
      expect(typeof c.id).toBe('string');
      expect(typeof c.name).toBe('string');
      expect(typeof c.status).toBe('string');
      expect(Array.isArray(c.ports)).toBe(true);
    }
  });
});
