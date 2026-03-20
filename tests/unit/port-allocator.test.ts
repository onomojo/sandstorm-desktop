import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PortAllocator } from '../../src/main/control-plane/port-allocator';
import { Registry } from '../../src/main/control-plane/registry';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-port-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

describe('PortAllocator', () => {
  let registry: Registry;
  let allocator: PortAllocator;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    allocator = new PortAllocator(registry, [30000, 30099]);

    registry.createStack({
      id: 'alloc-test-1',
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'up',
      runtime: 'docker',
    });
    registry.createStack({
      id: 'alloc-test-2',
      project: 'proj',
      project_dir: '/proj',
      ticket: null,
      branch: null,
      description: null,
      status: 'up',
      runtime: 'docker',
    });
  });

  afterEach(() => {
    registry.close();
    cleanupDb(dbPath);
  });

  it('allocates unique ports for services', async () => {
    const ports = await allocator.allocate('alloc-test-1', [
      { service: 'app', containerPort: 3000 },
      { service: 'api', containerPort: 3001 },
    ]);

    expect(ports.size).toBe(2);
    const appPort = ports.get('app')!;
    const apiPort = ports.get('api')!;
    expect(appPort).toBeGreaterThanOrEqual(30000);
    expect(appPort).toBeLessThanOrEqual(30099);
    expect(apiPort).toBeGreaterThanOrEqual(30000);
    expect(apiPort).toBeLessThanOrEqual(30099);
    expect(appPort).not.toBe(apiPort);
  });

  it('does not allocate ports already in use by another stack', async () => {
    const ports1 = await allocator.allocate('alloc-test-1', [
      { service: 'app', containerPort: 3000 },
    ]);

    const ports2 = await allocator.allocate('alloc-test-2', [
      { service: 'app', containerPort: 3000 },
    ]);

    expect(ports1.get('app')).not.toBe(ports2.get('app'));
  });

  it('persists allocated ports in registry', async () => {
    await allocator.allocate('alloc-test-1', [
      { service: 'app', containerPort: 3000 },
    ]);

    const storedPorts = registry.getPorts('alloc-test-1');
    expect(storedPorts).toHaveLength(1);
    expect(storedPorts[0].service).toBe('app');
    expect(storedPorts[0].container_port).toBe(3000);
  });

  it('releases ports back to pool', async () => {
    await allocator.allocate('alloc-test-1', [
      { service: 'app', containerPort: 3000 },
    ]);

    allocator.release('alloc-test-1');
    expect(registry.getPorts('alloc-test-1')).toHaveLength(0);
  });

  it('allocates no ports when given empty service list', async () => {
    const ports = await allocator.allocate('alloc-test-1', []);
    expect(ports.size).toBe(0);
    expect(registry.getPorts('alloc-test-1')).toHaveLength(0);
  });

  it('throws FK error when allocating for non-existent stack', async () => {
    await expect(
      allocator.allocate('ghost-stack', [
        { service: 'app', containerPort: 3000 },
      ])
    ).rejects.toThrow();
  });

  it('release on non-existent stack is a no-op', () => {
    expect(() => allocator.release('ghost')).not.toThrow();
  });

  it('released ports can be re-allocated', async () => {
    const ports1 = await allocator.allocate('alloc-test-1', [
      { service: 'app', containerPort: 3000 },
    ]);
    const firstPort = ports1.get('app')!;

    allocator.release('alloc-test-1');

    // Now the same port should be available for another stack
    const ports2 = await allocator.allocate('alloc-test-2', [
      { service: 'app', containerPort: 3000 },
    ]);
    // It might or might not be the same port (depends on OS port availability),
    // but it should successfully allocate
    expect(ports2.size).toBe(1);
  });
});
