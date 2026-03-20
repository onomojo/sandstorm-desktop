import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PodmanRuntime } from '../../src/main/runtime/podman';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

function mockSpawn(stdout: string, exitCode: number = 0) {
  const proc = new EventEmitter() as any;
  const stdoutStream = new EventEmitter();
  const stderrStream = new EventEmitter();

  proc.stdout = stdoutStream;
  proc.stderr = stderrStream;

  (spawn as ReturnType<typeof vi.fn>).mockReturnValue(proc);

  // Emit data and close on next tick
  setTimeout(() => {
    stdoutStream.emit('data', Buffer.from(stdout));
    proc.emit('close', exitCode);
  }, 10);

  return proc;
}

describe('PodmanRuntime', () => {
  let runtime: PodmanRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = new PodmanRuntime();
  });

  it('has correct name', () => {
    expect(runtime.name).toBe('podman');
  });

  it('checks availability via version command', async () => {
    mockSpawn('{"Client":{"Version":"4.9.0"}}');
    const available = await runtime.isAvailable();
    expect(available).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      'podman',
      ['version', '--format', 'json'],
      expect.any(Object)
    );
  });

  it('returns version string', async () => {
    mockSpawn('4.9.0');
    const ver = await runtime.version();
    expect(ver).toBe('Podman 4.9.0');
  });

  it('lists containers from JSON output', async () => {
    const containerJson = JSON.stringify({
      Id: 'pod123',
      Names: ['test-container'],
      Image: 'myapp:latest',
      State: 'running',
      Ports: [{ host_port: 8080, container_port: 3000, protocol: 'tcp' }],
      Labels: {},
      Created: '2024-01-01T00:00:00Z',
    });
    mockSpawn(containerJson);

    const containers = await runtime.listContainers();
    expect(containers).toHaveLength(1);
    expect(containers[0].id).toBe('pod123');
    expect(containers[0].status).toBe('running');
    expect(containers[0].ports[0].hostPort).toBe(8080);
  });

  it('handles empty container list', async () => {
    mockSpawn('');
    const containers = await runtime.listContainers();
    expect(containers).toHaveLength(0);
  });

  it('reports unavailable when command fails', async () => {
    mockSpawn('', 1);
    const available = await runtime.isAvailable();
    expect(available).toBe(false);
  });

  it('executes commands in containers', async () => {
    mockSpawn('command output');

    const result = await runtime.exec('container-id', ['echo', 'hello']);
    expect(result.stdout).toBe('command output');
    expect(result.exitCode).toBe(0);

    expect(spawn).toHaveBeenCalledWith(
      'podman',
      ['exec', 'container-id', 'echo', 'hello'],
      expect.any(Object)
    );
  });
});
