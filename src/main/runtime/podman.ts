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

export class PodmanRuntime implements ContainerRuntime {
  readonly name = 'podman';

  async composeUp(projectDir: string, opts: ComposeOpts): Promise<void> {
    const args = this.composeFileArgs(opts);
    if (opts.projectName) args.push('-p', opts.projectName);
    args.push('up', '-d');
    if (opts.build) args.push('--build');

    await this.runCommand('podman-compose', args, projectDir, opts.env);
  }

  async composeDown(projectDir: string, opts: ComposeOpts): Promise<void> {
    const args = this.composeFileArgs(opts);
    if (opts.projectName) args.push('-p', opts.projectName);
    args.push('down', '-v');

    await this.runCommand('podman-compose', args, projectDir, opts.env);
  }

  async listContainers(filter?: ContainerFilter): Promise<Container[]> {
    const args = ['ps', '-a', '--format', 'json'];
    if (filter?.name) args.push('--filter', `name=${filter.name}`);
    if (filter?.label) args.push('--filter', `label=${filter.label}`);
    if (filter?.status) args.push('--filter', `status=${filter.status}`);

    const result = await this.runCapture('podman', args);
    if (!result.trim()) return [];

    // Podman outputs one JSON object per line
    const containers = result
      .trim()
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));

    return containers.map((c: PodmanContainer) => ({
      id: c.Id ?? c.id ?? '',
      name: (c.Names?.[0] ?? c.Name ?? '').replace(/^\//, ''),
      image: c.Image ?? '',
      status: this.mapState(c.State ?? c.status ?? '') as ContainerStatus,
      state: c.State ?? c.status ?? '',
      ports: this.parsePorts(c.Ports ?? []),
      labels: c.Labels ?? {},
      created: c.Created ?? c.CreatedAt ?? '',
    }));
  }

  async inspect(containerId: string): Promise<ContainerInfo> {
    const result = await this.runCapture('podman', [
      'inspect',
      containerId,
      '--format',
      'json',
    ]);
    const data = JSON.parse(result);
    const info = Array.isArray(data) ? data[0] : data;

    return {
      id: info.Id,
      name: (info.Name ?? '').replace(/^\//, ''),
      state: {
        status: this.mapState(info.State?.Status ?? '') as ContainerStatus,
        running: info.State?.Running ?? false,
        exitCode: info.State?.ExitCode ?? 0,
        startedAt: info.State?.StartedAt ?? '',
        finishedAt: info.State?.FinishedAt ?? '',
      },
      config: {
        image: info.Config?.Image ?? '',
        env: info.Config?.Env ?? [],
      },
    };
  }

  async *logs(containerId: string, opts?: LogOpts): AsyncIterable<string> {
    const args = ['logs'];
    if (opts?.follow) args.push('-f');
    if (opts?.tail) args.push('--tail', String(opts.tail));
    if (opts?.since) args.push('--since', opts.since);
    args.push(containerId);

    const child = spawn('podman', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    if (child.stdout) {
      for await (const chunk of child.stdout) {
        yield chunk.toString('utf-8');
      }
    }
  }

  async exec(
    containerId: string,
    cmd: string[],
    opts?: ExecOpts
  ): Promise<ExecResult> {
    const args = ['exec'];
    if (opts?.workdir) args.push('-w', opts.workdir);
    if (opts?.env) {
      for (const e of opts.env) args.push('-e', e);
    }
    args.push(containerId, ...cmd);

    return new Promise((resolve, reject) => {
      const child = spawn('podman', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', (code) =>
        resolve({ exitCode: code ?? 0, stdout, stderr })
      );
      child.on('error', reject);
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.runCapture('podman', ['version', '--format', 'json']);
      return true;
    } catch {
      return false;
    }
  }

  async version(): Promise<string> {
    const result = await this.runCapture('podman', [
      'version',
      '--format',
      '{{.Client.Version}}',
    ]);
    return `Podman ${result.trim()}`;
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

  private parsePorts(
    ports: PodmanPort[]
  ): { hostPort: number; containerPort: number; protocol: string }[] {
    return ports
      .filter((p) => p.host_port)
      .map((p) => ({
        hostPort: p.host_port,
        containerPort: p.container_port,
        protocol: p.protocol ?? 'tcp',
      }));
  }

  private composeFileArgs(opts: ComposeOpts): string[] {
    return opts.composeFiles.flatMap((f) => ['-f', f]);
  }

  private runCapture(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`${cmd} exited with code ${code}: ${stderr}`));
      });
      child.on('error', reject);
    });
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

interface PodmanContainer {
  Id?: string;
  id?: string;
  Names?: string[];
  Name?: string;
  Image?: string;
  State?: string;
  status?: string;
  Ports?: PodmanPort[];
  Labels?: Record<string, string>;
  Created?: string;
  CreatedAt?: string;
}

interface PodmanPort {
  host_port: number;
  container_port: number;
  protocol?: string;
}
