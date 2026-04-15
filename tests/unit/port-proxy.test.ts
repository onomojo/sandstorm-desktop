import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PortProxy } from '../../src/main/control-plane/port-proxy';
import { Registry } from '../../src/main/control-plane/registry';
import { PortAllocator } from '../../src/main/control-plane/port-allocator';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTempDb(): string {
  return path.join(os.tmpdir(), `sandstorm-proxy-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

// Mock Dockerode
vi.mock('dockerode', () => {
  const mockContainer = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    id: 'mock-container-id-123',
  };

  const MockDockerode = vi.fn().mockImplementation(() => ({
    createContainer: vi.fn().mockResolvedValue(mockContainer),
    getContainer: vi.fn().mockReturnValue(mockContainer),
    getImage: vi.fn().mockReturnValue({
      inspect: vi.fn().mockResolvedValue({}),
    }),
    listContainers: vi.fn().mockResolvedValue([]),
    pull: vi.fn(),
    modem: { followProgress: vi.fn() },
  }));

  return { default: MockDockerode };
});

describe('PortProxy', () => {
  let registry: Registry;
  let allocator: PortAllocator;
  let proxy: PortProxy;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = makeTempDb();
    registry = await Registry.create(dbPath);
    allocator = new PortAllocator(registry, [30000, 30099]);
    proxy = new PortProxy(registry, allocator);

    registry.createStack({
      id: 'proxy-test-1',
      project: 'myproject',
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

  it('expose allocates a port and records in registry', async () => {
    const hostPort = await proxy.expose('proxy-test-1', 'myproject', 'app', 3000);

    expect(hostPort).toBeGreaterThanOrEqual(30000);
    expect(hostPort).toBeLessThanOrEqual(30099);

    const portInfo = registry.getPortByService('proxy-test-1', 'app', 3000);
    expect(portInfo).toBeDefined();
    expect(portInfo!.host_port).toBe(hostPort);
    expect(portInfo!.proxy_container_id).toBe('mock-container-id-123');
  });

  it('expose returns existing port if already exposed', async () => {
    const hostPort1 = await proxy.expose('proxy-test-1', 'myproject', 'app', 3000);
    const hostPort2 = await proxy.expose('proxy-test-1', 'myproject', 'app', 3000);

    expect(hostPort1).toBe(hostPort2);
  });

  it('unexpose removes the port from registry', async () => {
    await proxy.expose('proxy-test-1', 'myproject', 'app', 3000);
    await proxy.unexpose('proxy-test-1', 'app', 3000);

    const portInfo = registry.getPortByService('proxy-test-1', 'app', 3000);
    expect(portInfo).toBeUndefined();
  });

  it('unexpose is a no-op when port is not exposed', async () => {
    await expect(proxy.unexpose('proxy-test-1', 'app', 3000)).resolves.not.toThrow();
  });

  it('removeAllForStack completes without error', async () => {
    await expect(proxy.removeAllForStack('proxy-test-1')).resolves.not.toThrow();
  });

  it('ensureImage completes without error when image exists', async () => {
    await expect(proxy.ensureImage()).resolves.not.toThrow();
  });

  it('multiple services can be exposed on different ports', async () => {
    const port1 = await proxy.expose('proxy-test-1', 'myproject', 'app', 3000);
    const port2 = await proxy.expose('proxy-test-1', 'myproject', 'db', 5432);

    expect(port1).not.toBe(port2);

    const ports = registry.getPorts('proxy-test-1');
    expect(ports).toHaveLength(2);
  });

  it('getStackNetwork returns correct format', () => {
    // Access private method through the class for testing
    const network = (proxy as any).getStackNetwork('my-project', 'stack-1');
    expect(network).toBe('sandstorm-my-project-stack-1_default');
  });
});
