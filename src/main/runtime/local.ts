import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
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

interface LocalContainer {
  id: string;
  name: string;
  image: string;
  tmpdir: string;
  status: ContainerStatus;
  created: string;
  labels: Record<string, string>;
}

interface LocalLoop {
  stopped: boolean;
  timer: ReturnType<typeof setInterval> | null;
}

/**
 * ContainerRuntime that runs commands as local subprocesses inside per-container
 * tmpdirs. Requires no Docker or Podman daemon — intended for unit testing and
 * local development workflows where container isolation is not needed.
 *
 * Containers are registered programmatically via `registerContainer()`.
 * Images are registered via `registerImage()`.
 */
export class LocalRuntime implements ContainerRuntime {
  readonly name = 'local';

  private containers = new Map<string, LocalContainer>();
  private imageLabels = new Map<string, Record<string, string>>();
  private ownedTmpdirs: string[] = [];
  private composeContainers = new Map<string, string>();
  private loops = new Map<string, LocalLoop>();

  /**
   * Register a fake container. Returns the tmpdir path created for it.
   * If `tmpdir` is not provided, a new one is created and will be cleaned
   * up when `destroy()` is called.
   */
  registerContainer(
    id: string,
    opts: { name: string; image: string; tmpdir?: string; status?: ContainerStatus; labels?: Record<string, string> }
  ): string {
    let tmpdir = opts.tmpdir;
    if (!tmpdir) {
      tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'localrt-'));
      this.ownedTmpdirs.push(tmpdir);
    }
    this.containers.set(id, {
      id,
      name: opts.name,
      image: opts.image,
      tmpdir,
      status: opts.status ?? 'running',
      created: new Date().toISOString(),
      labels: opts.labels ?? {},
    });
    return tmpdir;
  }

  /**
   * Register fake image metadata (labels). Returns null from `inspectImage`
   * for any ref not registered here.
   */
  registerImage(ref: string, labels: Record<string, string>): void {
    this.imageLabels.set(ref, labels);
  }

  /** Remove all registered containers and clean up owned tmpdirs. */
  destroy(): void {
    for (const id of [...this.loops.keys()]) {
      this.stopLocalLoop(id);
    }
    this.containers.clear();
    this.imageLabels.clear();
    this.composeContainers.clear();
    for (const dir of this.ownedTmpdirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    this.ownedTmpdirs = [];
  }

  /** Return the container id registered for a compose project name. */
  getProjectContainerId(projectName: string): string | undefined {
    return this.composeContainers.get(projectName);
  }

  /** Return the per-container tmpdir path for the given container id. */
  getContainerTmpdir(containerId: string): string | undefined {
    return this.containers.get(containerId)?.tmpdir;
  }

  private startLocalLoop(id: string, tmpdir: string): void {
    const loop: LocalLoop = { stopped: false, timer: null };
    this.loops.set(id, loop);

    try { fs.writeFileSync(path.join(tmpdir, 'claude-ready'), 'ready', 'utf8'); } catch { /* ignore */ }

    loop.timer = setInterval(() => {
      if (loop.stopped) return;
      const triggerPath = path.join(tmpdir, 'claude-task-trigger');
      if (!fs.existsSync(triggerPath)) return;

      try { fs.unlinkSync(triggerPath); } catch { return; }

      try {
        try { fs.unlinkSync(path.join(tmpdir, 'claude-ready')); } catch { /* ignore */ }
        fs.writeFileSync(path.join(tmpdir, 'claude-task.status'), 'running', 'utf8');
        fs.writeFileSync(path.join(tmpdir, 'claude-task.pid'), String(process.pid), 'utf8');
        fs.writeFileSync(path.join(tmpdir, 'claude-task.review-iterations'), '0', 'utf8');
        fs.writeFileSync(path.join(tmpdir, 'claude-task.verify-retries'), '0', 'utf8');
        fs.writeFileSync(path.join(tmpdir, 'claude-task.log'), 'fake local loop: task simulated\n', 'utf8');
        fs.writeFileSync(path.join(tmpdir, 'claude-task.status'), 'completed', 'utf8');
        fs.writeFileSync(path.join(tmpdir, 'claude-task.exit'), '0', 'utf8');
        fs.writeFileSync(path.join(tmpdir, 'claude-ready'), 'ready', 'utf8');
      } catch { /* tmpdir removed during teardown */ }
    }, 50);
  }

  private stopLocalLoop(id: string): void {
    const loop = this.loops.get(id);
    if (!loop) return;
    loop.stopped = true;
    if (loop.timer !== null) {
      clearInterval(loop.timer);
      loop.timer = null;
    }
    this.loops.delete(id);
  }

  async composeUp(_projectDir: string, opts: ComposeOpts): Promise<void> {
    const id = opts.projectName;
    const tmpdir = this.registerContainer(id, {
      name: opts.projectName,
      image: 'local',
      status: 'running',
      labels: { 'com.docker.compose.project': opts.projectName },
    });
    this.composeContainers.set(opts.projectName, id);
    this.startLocalLoop(id, tmpdir);
  }

  async composeDown(_projectDir: string, opts: ComposeOpts): Promise<void> {
    const id = this.composeContainers.get(opts.projectName);
    if (id) {
      this.stopLocalLoop(id);
      const c = this.containers.get(id);
      if (c && this.ownedTmpdirs.includes(c.tmpdir)) {
        try { fs.rmSync(c.tmpdir, { recursive: true, force: true }); } catch { /* ignore */ }
        this.ownedTmpdirs = this.ownedTmpdirs.filter((d) => d !== c.tmpdir);
      }
      this.containers.delete(id);
      this.composeContainers.delete(opts.projectName);
    }
  }

  async listContainers(filter?: ContainerFilter): Promise<Container[]> {
    let result = Array.from(this.containers.values());
    if (filter?.name) {
      result = result.filter((c) => c.name.includes(filter.name!));
    }
    if (filter?.status) {
      result = result.filter((c) => c.status === filter.status);
    }
    if (filter?.label) {
      const eq = filter.label.indexOf('=');
      if (eq !== -1) {
        const key = filter.label.slice(0, eq);
        const val = filter.label.slice(eq + 1);
        result = result.filter((c) => c.labels[key] === val);
      } else {
        result = result.filter((c) => Object.prototype.hasOwnProperty.call(c.labels, filter.label!));
      }
    }
    return result.map((c) => ({
      id: c.id,
      name: c.name,
      image: c.image,
      status: c.status,
      state: c.status,
      ports: [],
      labels: c.labels,
      created: c.created,
    }));
  }

  async inspect(containerId: string): Promise<ContainerInfo> {
    const c = this.containers.get(containerId);
    if (!c) throw new Error(`LocalRuntime: container ${containerId} not found`);
    return {
      id: c.id,
      name: c.name,
      state: {
        status: c.status,
        running: c.status === 'running',
        exitCode: 0,
        startedAt: c.created,
        finishedAt: '',
      },
      config: { image: c.image, env: [] },
    };
  }

  async *logs(_containerId: string, _opts?: LogOpts): AsyncIterable<string> {
    // No logs in local mode
  }

  async containerStats(_containerId: string): Promise<ContainerStats> {
    return { memoryUsage: 0, memoryLimit: 0, cpuPercent: 0 };
  }

  async exec(
    containerId: string,
    cmd: string[],
    opts?: ExecOpts
  ): Promise<ExecResult> {
    const c = this.containers.get(containerId);
    if (!c) {
      return { exitCode: 1, stdout: '', stderr: `container not found: ${containerId}` };
    }
    const cwd = opts?.workdir
      ? path.resolve(c.tmpdir, opts.workdir)
      : c.tmpdir;

    const env: NodeJS.ProcessEnv = { ...process.env };
    // Redirect $TMPDIR so shell scripts using it also resolve under the container tmpdir
    env['TMPDIR'] = c.tmpdir;
    if (opts?.env) {
      for (const entry of opts.env) {
        const eq = entry.indexOf('=');
        if (eq !== -1) env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
    }

    // Rewrite absolute /tmp/ path references in command args to the per-container tmpdir
    const rewrittenCmd = cmd.map((arg) => arg.split('/tmp/').join(c.tmpdir + '/'));
    const hasInput = opts?.input != null;
    const [bin, ...args] = rewrittenCmd;

    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd,
        env,
        stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      if (hasInput && child.stdin) {
        child.stdin.write(opts!.input!);
        child.stdin.end();
      }
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
      child.on('error', reject);
    });
  }

  async inspectImage(ref: string): Promise<{ labels: Record<string, string> } | null> {
    const labels = this.imageLabels.get(ref);
    return labels != null ? { labels } : null;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async version(): Promise<string> {
    return 'local';
  }
}
