import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PortAllocator } from '../../src/main/control-plane/port-allocator';
import { Registry } from '../../src/main/control-plane/registry';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Port Allocation (Integration)', () => {
  let registry: Registry;
  let allocator: PortAllocator;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `sandstorm-port-int-${Date.now()}.db`);
    registry = await Registry.create(dbPath);
    // Use a high range to avoid conflicts with real services
    allocator = new PortAllocator(registry, [49000, 49099]);
  });

  afterEach(() => {
    registry.close();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(`${dbPath}-wal`);
      fs.unlinkSync(`${dbPath}-shm`);
    } catch {
      // ignore
    }
  });

  it('allocates ports that are actually free on the OS', async () => {
    registry.createStack({
      id: 'int-port-1',
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'up',
      runtime: 'docker',
    });

    const ports = await allocator.allocate('int-port-1', [
      { service: 'app', containerPort: 3000 },
      { service: 'api', containerPort: 3001 },
    ]);

    expect(ports.size).toBe(2);

    // Verify ports are in the expected range
    for (const [, port] of ports) {
      expect(port).toBeGreaterThanOrEqual(49000);
      expect(port).toBeLessThanOrEqual(49099);
    }
  });

  it('concurrent allocations get unique ports', async () => {
    // Create multiple stacks
    for (let i = 1; i <= 5; i++) {
      registry.createStack({
        id: `concurrent-${i}`,
        project: 'proj',
        project_dir: '/proj',
        ticket: null,
        branch: null,
        description: null,
        status: 'up',
        runtime: 'docker',
      });
    }

    // Allocate ports for all stacks
    const allPorts: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const ports = await allocator.allocate(`concurrent-${i}`, [
        { service: 'app', containerPort: 3000 },
        { service: 'api', containerPort: 3001 },
      ]);
      allPorts.push(...ports.values());
    }

    // All ports should be unique
    const uniquePorts = new Set(allPorts);
    expect(uniquePorts.size).toBe(allPorts.length);
  });
});
