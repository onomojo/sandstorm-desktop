import Dockerode from 'dockerode';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  ContainerRuntime,
  ComposeOpts,
  ContainerFilter,
  Container,
  ContainerInfo,
  ContainerStats,
  ContainerStatus,
  LogOpts,
  ExecOpts,
  ExecResult,
} from './types';
import { DockerConnectionManager } from './docker-connection';

/** Default timeout for exec calls (30 seconds) */
const EXEC_TIMEOUT_MS = 30_000;

/**
 * Resolve the Docker socket path. Checks existence to avoid triggering
 * macOS TCC permission prompts for inaccessible paths.
 */
function resolveDockerSocket(explicit?: string): string {
  if (explicit) return explicit;

  const candidates = [
    '/var/run/docker.sock',
  ];

  // On macOS, Docker Desktop exposes a per-user socket that doesn't need elevated permissions
  if (process.env.HOME) {
    candidates.push(path.join(process.env.HOME, '.docker', 'run', 'docker.sock'));
  }

  for (const sock of candidates) {
    try {
      if (fs.existsSync(sock)) return sock;
    } catch {
      // Path not accessible — skip without triggering further prompts
    }
  }

  // Fallback to default; Dockerode will fail gracefully on connect
  return '/var/run/docker.sock';
}

export class DockerRuntime implements ContainerRuntime {
  readonly name = 'docker';
  private docker: Dockerode;
  private connectionManager: DockerConnectionManager;

  /** Track active log streams for cleanup */
  private activeStreams = new Set<NodeJS.ReadableStream>();

  constructor(socketPath?: string) {
    this.docker = new Dockerode({
      socketPath: resolveDockerSocket(socketPath),
    });
    this.connectionManager = new DockerConnectionManager(
      () => this.pingDocker()
    );
    this.connectionManager.start();
  }

  getConnectionManager(): DockerConnectionManager {
    return this.connectionManager;
  }

  async composeUp(projectDir: string, opts: ComposeOpts): Promise<void> {
    const args = ['compose', ...this.composeFileArgs(opts)];
    if (opts.projectName) args.push('-p', opts.projectName);
    args.push('up', '-d');
    if (opts.build) args.push('--build');

    await this.runCommand('docker', args, projectDir, opts.env);
  }

  async composeDown(projectDir: string, opts: ComposeOpts): Promise<void> {
    const args = ['compose', ...this.composeFileArgs(opts)];
    if (opts.projectName) args.push('-p', opts.projectName);
    args.push('down', '-v', '--remove-orphans');

    await this.runCommand('docker', args, projectDir, opts.env);
  }

  async listContainers(filter?: ContainerFilter): Promise<Container[]> {
    if (this.connectionManager.shouldThrottle()) return [];

    try {
      const filters: Record<string, string[]> = {};
      if (filter?.label) filters.label = [filter.label];
      if (filter?.name) filters.name = [filter.name];
      if (filter?.status) filters.status = [filter.status];

      const containers = await this.docker.listContainers({
        all: true,
        filters: Object.keys(filters).length > 0 ? filters : undefined,
      });

      this.connectionManager.reportSuccess();

      return containers.map((c) => ({
        id: c.Id,
        name: c.Names[0]?.replace(/^\//, '') ?? '',
        image: c.Image,
        status: this.mapState(c.State) as ContainerStatus,
        state: c.State,
        ports: (c.Ports ?? []).map((p) => ({
          hostPort: p.PublicPort ?? 0,
          containerPort: p.PrivatePort,
          protocol: p.Type,
        })),
        labels: c.Labels ?? {},
        created: new Date(c.Created * 1000).toISOString(),
      }));
    } catch (err) {
      this.connectionManager.reportFailure();
      throw err;
    }
  }

  async inspect(containerId: string): Promise<ContainerInfo> {
    const container = this.docker.getContainer(containerId);
    const data = await container.inspect();

    return {
      id: data.Id,
      name: data.Name.replace(/^\//, ''),
      state: {
        status: this.mapState(data.State.Status) as ContainerStatus,
        running: data.State.Running,
        exitCode: data.State.ExitCode,
        startedAt: data.State.StartedAt,
        finishedAt: data.State.FinishedAt,
      },
      config: {
        image: data.Config.Image,
        env: data.Config.Env ?? [],
      },
    };
  }

  async *logs(containerId: string, opts?: LogOpts): AsyncIterable<string> {
    const container = this.docker.getContainer(containerId);
    const baseOpts: Dockerode.ContainerLogsOptions = {
      stdout: true,
      stderr: true,
      tail: opts?.tail ?? 100,
      since: opts?.since ? Math.floor(new Date(opts.since).getTime() / 1000) : undefined,
    };

    let stream: Buffer | NodeJS.ReadableStream;
    if (opts?.follow) {
      stream = await container.logs({ ...baseOpts, follow: true });
    } else {
      stream = await container.logs({ ...baseOpts, follow: false });
    }

    if (typeof stream === 'string' || Buffer.isBuffer(stream)) {
      yield Buffer.isBuffer(stream) ? stream.toString('utf-8') : stream;
      return;
    }

    const readable = stream as NodeJS.ReadableStream;
    this.activeStreams.add(readable);
    try {
      for await (const chunk of readable) {
        // Docker multiplexed stream: first 8 bytes are header
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (buf.length > 8) {
          yield buf.subarray(8).toString('utf-8');
        } else {
          yield buf.toString('utf-8');
        }
      }
    } finally {
      this.activeStreams.delete(readable);
      // Ensure the stream is destroyed if not already
      if ('destroy' in readable && typeof (readable as NodeJS.ReadableStream & { destroy: () => void }).destroy === 'function') {
        (readable as NodeJS.ReadableStream & { destroy: () => void }).destroy();
      }
    }
  }

  async exec(
    containerId: string,
    cmd: string[],
    opts?: ExecOpts
  ): Promise<ExecResult> {
    const container = this.docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: opts?.workdir,
      Env: opts?.env,
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    let stdout = '';
    let stderr = '';

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        stream.destroy();
        reject(new Error(`exec timed out after ${EXEC_TIMEOUT_MS}ms: ${cmd.join(' ')}`));
      }, EXEC_TIMEOUT_MS);

      stream.on('data', (chunk: Buffer) => {
        // Demux docker stream
        if (chunk.length > 8) {
          const type = chunk[0];
          const content = chunk.subarray(8).toString('utf-8');
          if (type === 1) stdout += content;
          else if (type === 2) stderr += content;
          else stdout += content;
        } else {
          stdout += chunk.toString('utf-8');
        }
      });
      stream.on('end', async () => {
        clearTimeout(timeout);
        try {
          const inspection = await exec.inspect();
          resolve({
            exitCode: inspection.ExitCode ?? 0,
            stdout,
            stderr,
          });
        } catch {
          resolve({ exitCode: 0, stdout, stderr });
        }
      });
      stream.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async containerStats(containerId: string): Promise<ContainerStats> {
    if (this.connectionManager.shouldThrottle()) {
      return { memoryUsage: 0, memoryLimit: 0, cpuPercent: 0 };
    }

    if (!this.connectionManager.acquireStatsSlot()) {
      return { memoryUsage: 0, memoryLimit: 0, cpuPercent: 0 };
    }

    try {
      if (!this.connectionManager.acquireRateLimit()) {
        return { memoryUsage: 0, memoryLimit: 0, cpuPercent: 0 };
      }

      const container = this.docker.getContainer(containerId);
      const stats = await container.stats({ stream: false });
      const data = typeof stats === 'string' ? JSON.parse(stats) : stats;

      this.connectionManager.reportSuccess();

      const memoryUsage = data.memory_stats?.usage ?? 0;
      const memoryLimit = data.memory_stats?.limit ?? 0;

      // CPU calculation
      let cpuPercent = 0;
      const cpuDelta =
        (data.cpu_stats?.cpu_usage?.total_usage ?? 0) -
        (data.precpu_stats?.cpu_usage?.total_usage ?? 0);
      const systemDelta =
        (data.cpu_stats?.system_cpu_usage ?? 0) -
        (data.precpu_stats?.system_cpu_usage ?? 0);
      const numCpus = data.cpu_stats?.online_cpus ?? 1;
      if (systemDelta > 0 && cpuDelta >= 0) {
        cpuPercent = (cpuDelta / systemDelta) * numCpus * 100;
      }

      return { memoryUsage, memoryLimit, cpuPercent };
    } catch (err) {
      this.connectionManager.reportFailure();
      throw err;
    } finally {
      this.connectionManager.releaseStatsSlot();
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.pingDocker();
  }

  async version(): Promise<string> {
    const info = await this.docker.version();
    return `Docker ${info.Version}`;
  }

  /**
   * Clean up all active streams and stop health monitoring.
   * Call on app shutdown.
   */
  destroy(): void {
    for (const stream of this.activeStreams) {
      if ('destroy' in stream && typeof (stream as NodeJS.ReadableStream & { destroy: () => void }).destroy === 'function') {
        (stream as NodeJS.ReadableStream & { destroy: () => void }).destroy();
      }
    }
    this.activeStreams.clear();
    this.connectionManager.destroy();
  }

  private async pingDocker(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  private mapState(state: string): string {
    const normalized = state.toLowerCase();
    if (normalized === 'running') return 'running';
    if (normalized === 'exited') return 'exited';
    if (normalized === 'restarting') return 'restarting';
    if (normalized === 'paused') return 'paused';
    if (normalized === 'created') return 'created';
    if (normalized === 'dead') return 'dead';
    return normalized;
  }

  private composeFileArgs(opts: ComposeOpts): string[] {
    return opts.composeFiles.flatMap((f) => ['-f', f]);
  }

  private runCommand(
    cmd: string,
    args: string[],
    cwd: string,
    env?: Record<string, string>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        env: {
          ...process.env,
          ...env,
          PATH: [
            ...(process.env.HOME ? [`${process.env.HOME}/.local/bin`] : []),
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/usr/local/sbin',
            process.env.PATH,
          ].filter(Boolean).join(':'),
        },
        stdio: 'pipe',
      });
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
      });
      child.on('error', reject);
    });
  }
}
