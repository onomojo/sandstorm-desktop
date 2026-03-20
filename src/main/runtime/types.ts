export interface ComposeOpts {
  projectName: string;
  composeFiles: string[];
  env?: Record<string, string>;
  build?: boolean;
}

export interface ContainerFilter {
  label?: string;
  name?: string;
  status?: string;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  status: ContainerStatus;
  state: string;
  ports: ContainerPort[];
  labels: Record<string, string>;
  created: string;
}

export type ContainerStatus = 'running' | 'exited' | 'restarting' | 'paused' | 'created' | 'dead';

export interface ContainerPort {
  hostPort: number;
  containerPort: number;
  protocol: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  state: {
    status: ContainerStatus;
    running: boolean;
    exitCode: number;
    startedAt: string;
    finishedAt: string;
  };
  config: {
    image: string;
    env: string[];
  };
}

export interface LogOpts {
  follow?: boolean;
  tail?: number;
  since?: string;
}

export interface ExecOpts {
  workdir?: string;
  env?: string[];
  interactive?: boolean;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ContainerRuntime {
  // Lifecycle
  composeUp(projectDir: string, opts: ComposeOpts): Promise<void>;
  composeDown(projectDir: string, opts: ComposeOpts): Promise<void>;

  // Inspection
  listContainers(filter?: ContainerFilter): Promise<Container[]>;
  inspect(containerId: string): Promise<ContainerInfo>;
  logs(containerId: string, opts?: LogOpts): AsyncIterable<string>;

  // Execution
  exec(
    containerId: string,
    cmd: string[],
    opts?: ExecOpts
  ): Promise<ExecResult>;

  // Health
  isAvailable(): Promise<boolean>;
  version(): Promise<string>;

  // Identity
  readonly name: string;
}
