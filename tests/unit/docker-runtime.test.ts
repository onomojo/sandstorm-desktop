import { describe, it, expect, vi, beforeEach } from 'vitest';
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
          }),
          inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
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
});
