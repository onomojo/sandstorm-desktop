import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DockerRuntime } from '../../src/main/runtime/docker';

// Mock dockerode
vi.mock('dockerode', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      ping: vi.fn().mockResolvedValue('OK'),
      version: vi.fn().mockResolvedValue({ Version: '24.0.7' }),
      listContainers: vi.fn().mockResolvedValue([
        {
          Id: 'abc123',
          Names: ['/sandstorm-proj-1-app-1'],
          Image: 'myapp:latest',
          State: 'running',
          Ports: [{ PublicPort: 3000, PrivatePort: 3000, Type: 'tcp' }],
          Labels: {},
          Created: 1700000000,
        },
      ]),
      getContainer: vi.fn().mockReturnValue({
        inspect: vi.fn().mockResolvedValue({
          Id: 'abc123',
          Name: '/sandstorm-proj-1-app-1',
          State: {
            Status: 'running',
            Running: true,
            ExitCode: 0,
            StartedAt: '2024-01-01T00:00:00Z',
            FinishedAt: '0001-01-01T00:00:00Z',
          },
          Config: {
            Image: 'myapp:latest',
            Env: ['FOO=bar'],
          },
        }),
        logs: vi.fn().mockResolvedValue('log line 1\nlog line 2'),
        exec: vi.fn().mockResolvedValue({
          start: vi.fn().mockResolvedValue({
            on: vi.fn().mockImplementation((event: string, cb: Function) => {
              if (event === 'end') setTimeout(cb, 10);
            }),
            destroy: vi.fn(),
          }),
          inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
        }),
        stats: vi.fn().mockResolvedValue({
          memory_stats: { usage: 1024 * 1024, limit: 4 * 1024 * 1024 * 1024 },
          cpu_stats: { cpu_usage: { total_usage: 2000 }, system_cpu_usage: 10000, online_cpus: 4 },
          precpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 9000 },
        }),
      }),
    })),
  };
});

describe('DockerRuntime', () => {
  let runtime: DockerRuntime;

  beforeEach(() => {
    runtime = new DockerRuntime();
  });

  afterEach(() => {
    runtime.destroy();
  });

  it('reports availability via ping', async () => {
    expect(await runtime.isAvailable()).toBe(true);
  });

  it('returns version string', async () => {
    const ver = await runtime.version();
    expect(ver).toBe('Docker 24.0.7');
  });

  it('lists containers with mapped fields', async () => {
    const containers = await runtime.listContainers();
    expect(containers).toHaveLength(1);
    expect(containers[0].id).toBe('abc123');
    expect(containers[0].name).toBe('sandstorm-proj-1-app-1');
    expect(containers[0].status).toBe('running');
    expect(containers[0].ports[0].hostPort).toBe(3000);
  });

  it('inspects a container', async () => {
    const info = await runtime.inspect('abc123');
    expect(info.id).toBe('abc123');
    expect(info.state.running).toBe(true);
    expect(info.state.exitCode).toBe(0);
    expect(info.config.image).toBe('myapp:latest');
  });

  it('has correct name', () => {
    expect(runtime.name).toBe('docker');
  });

  // --- Connection manager integration ---

  it('exposes connection manager', () => {
    const cm = runtime.getConnectionManager();
    expect(cm).toBeDefined();
    expect(typeof cm.isConnected).toBe('boolean');
  });

  it('containerStats returns zeros when throttled', async () => {
    const cm = runtime.getConnectionManager();
    // Force throttle by reporting many failures
    for (let i = 0; i < 5; i++) cm.reportFailure();

    const stats = await runtime.containerStats('abc123');
    expect(stats.memoryUsage).toBe(0);
    expect(stats.cpuPercent).toBe(0);
  });

  it('containerStats returns zeros when stats slots exhausted', async () => {
    const cm = runtime.getConnectionManager();
    // Force connected state
    cm.reportSuccess();
    // Exhaust all stats slots
    for (let i = 0; i < 10; i++) cm.acquireStatsSlot();

    const stats = await runtime.containerStats('abc123');
    expect(stats.memoryUsage).toBe(0);
  });

  it('listContainers returns empty array when throttled', async () => {
    const cm = runtime.getConnectionManager();
    for (let i = 0; i < 5; i++) cm.reportFailure();

    const containers = await runtime.listContainers();
    expect(containers).toEqual([]);
  });

  // --- Stream cleanup ---

  it('destroy cleans up connection manager', () => {
    const cm = runtime.getConnectionManager();
    const stopSpy = vi.spyOn(cm, 'destroy');
    runtime.destroy();
    expect(stopSpy).toHaveBeenCalled();
  });
});
