import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DockerRuntime, demuxDockerStream } from '../../src/main/runtime/docker';

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

// --- demuxDockerStream unit tests ---

/**
 * Helper to build a Docker multiplexed stream frame.
 * Header: [stream_type(1), 0, 0, 0, size(4 big-endian)]
 */
function buildDockerFrame(streamType: number, content: string): Buffer {
  const payload = Buffer.from(content, 'utf-8');
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('demuxDockerStream', () => {
  it('demuxes a single stdout frame', () => {
    const frame = buildDockerFrame(1, 'hello world');
    const { frames, remainder } = demuxDockerStream(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(1);
    expect(frames[0].content).toBe('hello world');
    expect(remainder.length).toBe(0);
  });

  it('demuxes a single stderr frame', () => {
    const frame = buildDockerFrame(2, 'error msg');
    const { frames, remainder } = demuxDockerStream(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(2);
    expect(frames[0].content).toBe('error msg');
    expect(remainder.length).toBe(0);
  });

  it('demuxes multiple frames in a single buffer', () => {
    const frame1 = buildDockerFrame(1, 'first');
    const frame2 = buildDockerFrame(1, 'second');
    const frame3 = buildDockerFrame(2, 'err');
    const combined = Buffer.concat([frame1, frame2, frame3]);

    const { frames, remainder } = demuxDockerStream(combined);
    expect(frames).toHaveLength(3);
    expect(frames[0].content).toBe('first');
    expect(frames[1].content).toBe('second');
    expect(frames[2].type).toBe(2);
    expect(frames[2].content).toBe('err');
    expect(remainder.length).toBe(0);
  });

  it('returns remainder when frame is incomplete', () => {
    const frame = buildDockerFrame(1, 'hello world');
    // Chop off the last 3 bytes to simulate a partial frame
    const partial = frame.subarray(0, frame.length - 3);

    const { frames, remainder } = demuxDockerStream(partial);
    expect(frames).toHaveLength(0);
    expect(remainder.length).toBe(partial.length);
  });

  it('handles one complete frame followed by a partial frame', () => {
    const frame1 = buildDockerFrame(1, 'complete');
    const frame2 = buildDockerFrame(1, 'partial data here');
    const partial2 = frame2.subarray(0, 12); // header + 4 bytes of payload
    const combined = Buffer.concat([frame1, partial2]);

    const { frames, remainder } = demuxDockerStream(combined);
    expect(frames).toHaveLength(1);
    expect(frames[0].content).toBe('complete');
    expect(remainder.length).toBe(partial2.length);
  });

  it('handles empty buffer', () => {
    const { frames, remainder } = demuxDockerStream(Buffer.alloc(0));
    expect(frames).toHaveLength(0);
    expect(remainder.length).toBe(0);
  });

  it('returns remainder when buffer is smaller than header size', () => {
    const tiny = Buffer.from([1, 0, 0]);
    const { frames, remainder } = demuxDockerStream(tiny);
    expect(frames).toHaveLength(0);
    expect(remainder.length).toBe(3);
  });

  it('reassembles a frame split across two chunks', () => {
    const frame = buildDockerFrame(1, 'split across chunks');
    const mid = Math.floor(frame.length / 2);
    const chunk1 = frame.subarray(0, mid);
    const chunk2 = frame.subarray(mid);

    // First chunk: incomplete
    const result1 = demuxDockerStream(chunk1);
    expect(result1.frames).toHaveLength(0);
    expect(result1.remainder.length).toBe(chunk1.length);

    // Second chunk: prepend remainder
    const combined = Buffer.concat([result1.remainder, chunk2]);
    const result2 = demuxDockerStream(combined);
    expect(result2.frames).toHaveLength(1);
    expect(result2.frames[0].content).toBe('split across chunks');
    expect(result2.remainder.length).toBe(0);
  });

  it('prevents binary header leakage in multi-frame buffers (issue #115)', () => {
    // Simulates the bug: "heav" + header bytes + "y libraries"
    // With proper demuxing, the headers should be stripped from all frames
    const frame1 = buildDockerFrame(1, 'importing these heav');
    const frame2 = buildDockerFrame(1, 'y libraries');
    const combined = Buffer.concat([frame1, frame2]);

    const { frames } = demuxDockerStream(combined);
    const fullText = frames.map(f => f.content).join('');
    expect(fullText).toBe('importing these heavy libraries');
    // No binary characters should be present
    expect(fullText).not.toMatch(/[\x00-\x08]/);
  });

  it('handles zero-length frame payload', () => {
    const frame = buildDockerFrame(1, '');
    const { frames, remainder } = demuxDockerStream(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0].content).toBe('');
    expect(remainder.length).toBe(0);
  });
});
