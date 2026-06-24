import type { BrowserWindow } from 'electron';
import type { Registry } from '../control-plane/registry';
import type { StackManager } from '../control-plane/stack-manager';
import type { ContainerRuntime } from '../runtime/types';
import type { AgentBackend } from '../agent';
import type { DockerConnectionManager } from '../runtime/docker-connection';
import type { SessionMonitor } from '../control-plane/session-monitor';
import type { DarkFactoryOrchestrator } from '../control-plane/dark-factory-orchestrator';

export interface IpcContext {
  mainWindow: BrowserWindow | undefined;
  registry: Registry;
  stackManager: StackManager;
  dockerRuntime: ContainerRuntime;
  podmanRuntime: ContainerRuntime;
  cliDir: string;
  agentBackend: AgentBackend;
  dockerConnectionManager: DockerConnectionManager | null;
  sessionMonitor: SessionMonitor;
  darkFactoryOrchestrator: DarkFactoryOrchestrator | null;
}
