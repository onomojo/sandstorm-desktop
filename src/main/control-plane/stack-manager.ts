import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Registry, Stack, StackHistoryRecord, Task } from './registry';
import { PortAllocator, ServicePort } from './port-allocator';
import { TaskWatcher } from './task-watcher';
import { ContainerRuntime, Container } from '../runtime/types';

export interface CreateStackOpts {
  name: string;
  projectDir: string;
  ticket?: string;
  branch?: string;
  description?: string;
  runtime: 'docker' | 'podman';
  task?: string;
}

export interface StackWithServices extends Stack {
  services: ServiceInfo[];
}

export interface ServiceInfo {
  name: string;
  status: string;
  exitCode?: number;
  hostPort?: number;
  containerPort?: number;
  containerId: string;
}

/**
 * Sanitize a string for use in Docker Compose project names.
 * Compose project names must consist only of lowercase alphanumeric characters,
 * hyphens, and underscores, and must start with a letter or underscore.
 */
export function sanitizeComposeName(input: string): string {
  let name = input
    .toLowerCase()
    .replace(/\s+/g, '-')       // spaces → hyphens
    .replace(/[^a-z0-9_-]/g, '') // strip invalid chars
    .replace(/-{2,}/g, '-')      // collapse repeated hyphens
    .replace(/^[-]+/, '')         // strip leading hyphens
    .replace(/[-]+$/, '');        // strip trailing hyphens

  // Must start with a letter or underscore
  if (name && !/^[a-z_]/.test(name)) {
    name = `s${name}`;
  }

  return name || 'stack';
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class StackManager {
  private onStackUpdate?: () => void;

  constructor(
    private registry: Registry,
    private portAllocator: PortAllocator,
    private taskWatcher: TaskWatcher,
    private runtime: ContainerRuntime,
    private cliDir: string = ''
  ) {}

  setOnStackUpdate(callback: () => void): void {
    this.onStackUpdate = callback;
  }

  private notifyUpdate(): void {
    this.onStackUpdate?.();
  }

  /**
   * Resolve path to the sandstorm CLI entry point.
   */
  private getCliBin(): string {
    return path.join(this.cliDir, 'bin', 'sandstorm');
  }

  /**
   * Run a sandstorm CLI command in the given project directory.
   */
  runCli(
    projectDir: string,
    args: string[],
    env?: Record<string, string>
  ): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('bash', [this.getCliBin(), ...args], {
        cwd: projectDir,
        env: {
          ...process.env,
          ...env,
          PATH: [
            `${process.env.HOME}/.local/bin`,
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/usr/local/sbin',
            process.env.PATH,
          ].join(':'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', (code) =>
        resolve({ stdout, stderr, exitCode: code ?? 1 })
      );
      child.on('error', reject);
    });
  }

  createStack(opts: CreateStackOpts): Stack {
    const projectName = path.basename(opts.projectDir);

    // Create registry entry first (ports table has FK to stacks)
    const stack = this.registry.createStack({
      id: opts.name,
      project: projectName,
      project_dir: opts.projectDir,
      ticket: opts.ticket ?? null,
      branch: opts.branch ?? null,
      description: opts.description ?? null,
      status: 'building',
      runtime: opts.runtime,
    });

    // Launch the heavy work in the background
    this.buildStackInBackground(opts, projectName).catch(() => {
      // Error already stored in registry by buildStackInBackground
    });

    return stack;
  }

  private async buildStackInBackground(opts: CreateStackOpts, _projectName: string): Promise<void> {
    try {
      // Allocate ports via PortAllocator (tracks in SQLite, finds free ports)
      const servicePorts = await this.discoverServicePorts(opts.projectDir);
      const portMap = await this.portAllocator.allocate(opts.name, servicePorts);

      // Build port env vars in the format the CLI/compose expects: SANDSTORM_PORT_<service>_<index>
      const portEnv: Record<string, string> = {};
      for (const [serviceKey, hostPort] of portMap) {
        portEnv[`SANDSTORM_PORT_${serviceKey}`] = String(hostPort);
      }

      // Build CLI args
      const args = ['up', opts.name];
      if (opts.ticket) args.push('--ticket', opts.ticket);
      if (opts.branch) args.push('--branch', opts.branch);

      const result = await this.runCli(opts.projectDir, args, portEnv);

      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || 'Stack creation failed');
      }

      this.registry.updateStackStatus(opts.name, 'up');
      this.notifyUpdate();

      // If a task was provided, dispatch it immediately
      if (opts.task) {
        await this.dispatchTask(opts.name, opts.task);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.registry.updateStackStatus(opts.name, 'failed', errorMessage);
      this.notifyUpdate();
    }
  }

  stopStack(stackId: string): void {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);

    this.taskWatcher.unwatch(stackId);
    this.registry.updateStackStatus(stackId, 'stopped');
    this.notifyUpdate();

    // Stop containers in background (keeps containers/volumes/images intact)
    this.stopInBackground(stack, stackId).catch(() => {});
  }

  private async stopInBackground(stack: Stack, stackId: string): Promise<void> {
    try {
      await this.runCli(stack.project_dir, ['stop', stackId]);
    } catch {
      // Best effort
    }
  }

  startStack(stackId: string): void {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);

    this.registry.updateStackStatus(stackId, 'building');
    this.notifyUpdate();

    // Start containers in background
    this.startInBackground(stack, stackId).catch(() => {});
  }

  private async startInBackground(stack: Stack, stackId: string): Promise<void> {
    try {
      const result = await this.runCli(stack.project_dir, ['start', stackId]);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || 'Stack start failed');
      }
      this.registry.updateStackStatus(stackId, 'up');
      this.notifyUpdate();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.registry.updateStackStatus(stackId, 'failed', errorMessage);
      this.notifyUpdate();
    }
  }

  teardownStack(stackId: string): void {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);

    this.taskWatcher.unwatch(stackId);

    // Archive to history before deleting
    const finalStatus =
      stack.status === 'completed' ? 'completed' :
      stack.status === 'failed' ? 'failed' :
      'torn_down' as const;
    this.registry.archiveStack(stackId, finalStatus);

    // Delete from registry and release ports immediately so the UI updates
    this.portAllocator.release(stackId);
    this.registry.deleteStack(stackId);
    this.notifyUpdate();

    // Run Docker teardown in background (best effort)
    this.teardownInBackground(stack, stackId).catch(() => {
      // Best effort
    });
  }

  private async teardownInBackground(stack: Stack, stackId: string): Promise<void> {
    try {
      await this.runCli(stack.project_dir, ['down', stackId]);
    } catch {
      // Best effort — if CLI fails, containers may need manual cleanup
    }
  }

  async dispatchTask(stackId: string, prompt: string): Promise<Task> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);

    const task = this.registry.createTask(stackId, prompt);

    const claudeContainer = await this.findClaudeContainer(stack);
    if (!claudeContainer) {
      throw new Error(`Claude container not found for stack "${stackId}"`);
    }

    // Use the sandstorm CLI to dispatch the task. The CLI's `task` command
    // handles credential sync (OAuth), writes files as the correct user
    // (`-u claude`), and creates the trigger file with proper ownership —
    // preventing the infinite-loop and not-logged-in bugs.
    const result = await this.runCli(stack.project_dir, ['task', stackId, prompt]);

    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || 'Task dispatch failed'
      );
    }

    // Start watching for completion
    this.taskWatcher.watch(stackId, claudeContainer.id);

    // Stream live output to renderer (fire-and-forget)
    this.taskWatcher.streamOutput(stackId, claudeContainer.id, () => {}).catch(() => {});

    return task;
  }

  async getStackWithServices(stackId: string): Promise<StackWithServices | undefined> {
    const stack = this.registry.getStack(stackId);
    if (!stack) return undefined;

    const services = await this.getServices(stack);
    return { ...stack, services };
  }

  async listStacksWithServices(): Promise<StackWithServices[]> {
    const stacks = this.registry.listStacks();
    const results: StackWithServices[] = [];

    for (const stack of stacks) {
      const services = await this.getServices(stack);
      results.push({ ...stack, services });
    }

    return results;
  }

  async getDiff(stackId: string): Promise<string> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);

    const result = await this.runCli(stack.project_dir, ['diff', stackId]);
    return result.stdout;
  }

  async push(stackId: string, message?: string): Promise<void> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);

    const args = ['push', stackId];
    if (message) args.push(message);

    const result = await this.runCli(stack.project_dir, args);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'Push failed');
    }
  }

  getTasksForStack(stackId: string): Task[] {
    return this.registry.getTasksForStack(stackId);
  }

  listStackHistory(): StackHistoryRecord[] {
    return this.registry.listStackHistory();
  }

  // --- Private helpers ---

  private async getServices(stack: Stack): Promise<ServiceInfo[]> {
    const composeProjectName = `sandstorm-${sanitizeComposeName(stack.project)}-${sanitizeComposeName(stack.id)}`;
    const containers = await this.runtime.listContainers({
      name: composeProjectName,
    });

    const ports = this.registry.getPorts(stack.id);
    const portMap = new Map(ports.map((p) => [p.service, p]));

    return containers.map((c) => {
      const serviceName = this.extractServiceName(c.name, composeProjectName);
      const portInfo = portMap.get(serviceName);

      return {
        name: serviceName,
        status: c.status,
        exitCode: c.status === 'exited' ? undefined : undefined,
        hostPort: portInfo?.host_port,
        containerPort: portInfo?.container_port,
        containerId: c.id,
      };
    });
  }

  private async findClaudeContainer(stack: Stack): Promise<Container | undefined> {
    const composeProjectName = `sandstorm-${sanitizeComposeName(stack.project)}-${sanitizeComposeName(stack.id)}`;
    const containers = await this.runtime.listContainers({
      name: `${composeProjectName}-claude`,
    });
    return containers[0];
  }

  private extractServiceName(containerName: string, projectName: string): string {
    // Container names are typically: projectName-service-1
    const withoutProject = containerName.replace(`${projectName}-`, '');
    return withoutProject.replace(/-\d+$/, '');
  }

  private discoverServicePorts(projectDir: string): Promise<ServicePort[]> {
    // Read .sandstorm/config for PORT_MAP
    const configPath = path.join(projectDir, '.sandstorm', 'config');
    if (!fs.existsSync(configPath)) return Promise.resolve([]);

    const config = fs.readFileSync(configPath, 'utf-8');
    const portMapLine = config
      .split('\n')
      .find((l) => l.startsWith('PORT_MAP='));
    if (!portMapLine) return Promise.resolve([]);

    const portMapValue = portMapLine.split('=')[1]?.replace(/"/g, '');
    if (!portMapValue) return Promise.resolve([]);

    // Format: service:host_port:container_port:index,...
    // Use service_index as the key to match compose env var format: SANDSTORM_PORT_<service>_<index>
    return Promise.resolve(
      portMapValue.split(',').map((entry) => {
        const [service, , containerPort, index] = entry.split(':');
        return {
          service: `${service}_${index || '0'}`,
          containerPort: parseInt(containerPort, 10),
        };
      })
    );
  }
}
