import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Registry, Stack, StackStatus, Task } from './registry';
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

export class StackManager {
  constructor(
    private registry: Registry,
    private portAllocator: PortAllocator,
    private taskWatcher: TaskWatcher,
    private runtime: ContainerRuntime
  ) {}

  async createStack(opts: CreateStackOpts): Promise<Stack> {
    const projectName = path.basename(opts.projectDir);
    const composeProjectName = `sandstorm-${projectName}-${opts.name}`;

    // Parse compose file to discover services and ports
    const servicePorts = await this.discoverServicePorts(opts.projectDir);

    // Allocate ports
    const portMap = await this.portAllocator.allocate(opts.name, servicePorts);

    // Create registry entry
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

    // Build port env vars for compose
    const portEnv: Record<string, string> = {};
    for (const [service, hostPort] of portMap) {
      portEnv[`SANDSTORM_PORT_${service.toUpperCase()}`] = String(hostPort);
    }

    // Clone workspace
    const workspaceDir = path.join(opts.projectDir, '.sandstorm', 'workspaces', opts.name);
    await this.cloneWorkspace(opts.projectDir, workspaceDir, opts.branch);

    // Compose up
    try {
      const composeFiles = this.findComposeFiles(opts.projectDir);
      await this.runtime.composeUp(workspaceDir, {
        projectName: composeProjectName,
        composeFiles,
        env: {
          ...portEnv,
          GIT_USER_NAME: await this.getGitConfig('user.name'),
          GIT_USER_EMAIL: await this.getGitConfig('user.email'),
        },
        build: true,
      });

      this.registry.updateStackStatus(opts.name, 'up');

      // If a task was provided, dispatch it immediately
      if (opts.task) {
        await this.dispatchTask(opts.name, opts.task);
      }
    } catch (err) {
      this.registry.updateStackStatus(opts.name, 'failed');
      throw err;
    }

    return this.registry.getStack(opts.name)!;
  }

  async teardownStack(stackId: string): Promise<void> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);

    this.taskWatcher.unwatch(stackId);

    const composeProjectName = `sandstorm-${stack.project}-${stackId}`;
    const composeFiles = this.findComposeFiles(stack.project_dir);

    try {
      await this.runtime.composeDown(stack.project_dir, {
        projectName: composeProjectName,
        composeFiles,
      });
    } catch {
      // Best effort teardown
    }

    this.portAllocator.release(stackId);

    // Clean workspace
    const workspaceDir = path.join(
      stack.project_dir,
      '.sandstorm',
      'workspaces',
      stackId
    );
    if (fs.existsSync(workspaceDir)) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }

    this.registry.deleteStack(stackId);
  }

  async dispatchTask(stackId: string, prompt: string): Promise<Task> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);

    const task = this.registry.createTask(stackId, prompt);

    const claudeContainer = await this.findClaudeContainer(stack);
    if (!claudeContainer) {
      throw new Error(`Claude container not found for stack "${stackId}"`);
    }

    // Write prompt to container
    await this.runtime.exec(claudeContainer.id, [
      'bash',
      '-c',
      `echo ${this.shellEscape(prompt)} > /tmp/claude-task-prompt.txt`,
    ]);

    // Write task label
    const label = prompt.substring(0, 80);
    await this.runtime.exec(claudeContainer.id, [
      'bash',
      '-c',
      `echo ${this.shellEscape(label)} > /tmp/claude-task-label.txt`,
    ]);

    // Trigger the task
    await this.runtime.exec(claudeContainer.id, [
      'touch',
      '/tmp/claude-task-trigger',
    ]);

    // Start watching for completion
    this.taskWatcher.watch(stackId, claudeContainer.id);

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

    const claudeContainer = await this.findClaudeContainer(stack);
    if (!claudeContainer) return '';

    const result = await this.runtime.exec(claudeContainer.id, [
      'git',
      'diff',
      'HEAD',
    ]);
    return result.stdout;
  }

  async push(stackId: string, message?: string): Promise<void> {
    const stack = this.registry.getStack(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);

    const claudeContainer = await this.findClaudeContainer(stack);
    if (!claudeContainer) throw new Error('Claude container not found');

    const commitMsg = message ?? `sandstorm: ${stack.description ?? stackId}`;
    await this.runtime.exec(claudeContainer.id, [
      'bash',
      '-c',
      `cd /app && git add -A && git commit -m ${this.shellEscape(commitMsg)} && git push`,
    ]);
  }

  getTasksForStack(stackId: string): Task[] {
    return this.registry.getTasksForStack(stackId);
  }

  // --- Private helpers ---

  private async getServices(stack: Stack): Promise<ServiceInfo[]> {
    const composeProjectName = `sandstorm-${stack.project}-${stack.id}`;
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
    const composeProjectName = `sandstorm-${stack.project}-${stack.id}`;
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

  private async discoverServicePorts(projectDir: string): Promise<ServicePort[]> {
    // Read .sandstorm/config for PORT_MAP
    const configPath = path.join(projectDir, '.sandstorm', 'config');
    if (!fs.existsSync(configPath)) return [];

    const config = fs.readFileSync(configPath, 'utf-8');
    const portMapLine = config
      .split('\n')
      .find((l) => l.startsWith('PORT_MAP='));
    if (!portMapLine) return [];

    const portMapValue = portMapLine.split('=')[1]?.replace(/"/g, '');
    if (!portMapValue) return [];

    // Format: service:host_port:container_port:index,...
    return portMapValue.split(',').map((entry) => {
      const [service, , containerPort] = entry.split(':');
      return {
        service,
        containerPort: parseInt(containerPort, 10),
      };
    });
  }

  private findComposeFiles(projectDir: string): string[] {
    const files: string[] = [];
    const mainCompose = path.join(projectDir, 'docker-compose.yml');
    if (fs.existsSync(mainCompose)) files.push(mainCompose);

    const sandstormCompose = path.join(
      projectDir,
      '.sandstorm',
      'docker-compose.yml'
    );
    if (fs.existsSync(sandstormCompose)) files.push(sandstormCompose);

    return files;
  }

  private async cloneWorkspace(
    projectDir: string,
    workspaceDir: string,
    branch?: string
  ): Promise<void> {
    fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });

    if (fs.existsSync(workspaceDir)) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }

    // Get remote URL
    const remoteUrl = await this.gitCommand(projectDir, [
      'remote',
      'get-url',
      'origin',
    ]);

    // Clone
    const cloneArgs = ['clone', remoteUrl.trim(), workspaceDir];
    if (branch) cloneArgs.push('-b', branch);
    await this.gitCommand(projectDir, cloneArgs);
  }

  private gitCommand(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`git ${args[0]} failed: ${stderr}`));
      });
      child.on('error', reject);
    });
  }

  private async getGitConfig(key: string): Promise<string> {
    try {
      return (await this.gitCommand('.', ['config', '--global', key])).trim();
    } catch {
      return '';
    }
  }

  private shellEscape(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
}
