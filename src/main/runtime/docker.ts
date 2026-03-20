import Dockerode from 'dockerode';
import { spawn } from 'child_process';
import {
  ContainerRuntime,
  ComposeOpts,
  ContainerFilter,
  Container,
  ContainerInfo,
  ContainerStatus,
  LogOpts,
  ExecOpts,
  ExecResult,
} from './types';

export class DockerRuntime implements ContainerRuntime {
  readonly name = 'docker';
  private docker: Dockerode;

  constructor(socketPath?: string) {
    this.docker = new Dockerode({
      socketPath: socketPath ?? '/var/run/docker.sock',
    });
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
    const filters: Record<string, string[]> = {};
    if (filter?.label) filters.label = [filter.label];
    if (filter?.name) filters.name = [filter.name];
    if (filter?.status) filters.status = [filter.status];

    const containers = await this.docker.listContainers({
      all: true,
      filters: Object.keys(filters).length > 0 ? filters : undefined,
    });

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
    const stream = await container.logs({
      stdout: true,
      stderr: true,
      follow: opts?.follow ?? false,
      tail: opts?.tail ?? 100,
      since: opts?.since ? Math.floor(new Date(opts.since).getTime() / 1000) : undefined,
    });

    if (typeof stream === 'string') {
      yield stream;
      return;
    }

    const readable = stream as NodeJS.ReadableStream;
    for await (const chunk of readable) {
      // Docker multiplexed stream: first 8 bytes are header
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buf.length > 8) {
        yield buf.subarray(8).toString('utf-8');
      } else {
        yield buf.toString('utf-8');
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
      stream.on('error', reject);
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async version(): Promise<string> {
    const info = await this.docker.version();
    return `Docker ${info.Version}`;
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
        env: { ...process.env, ...env },
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
