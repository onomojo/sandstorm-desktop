import Dockerode from 'dockerode';
import { Registry } from './registry';
import { PortAllocator } from './port-allocator';
import { sanitizeComposeName } from './stack-manager';

const PROXY_IMAGE = 'alpine/socat:1.8.0.1';

export interface ProxyInfo {
  stackId: string;
  service: string;
  containerPort: number;
  hostPort: number;
  proxyContainerId: string;
}

export class PortProxy {
  private docker: Dockerode;

  constructor(
    private registry: Registry,
    private portAllocator: PortAllocator,
    socketPath?: string
  ) {
    this.docker = new Dockerode({
      socketPath: socketPath ?? '/var/run/docker.sock',
    });
  }

  /**
   * Expose a service port by creating a socat proxy container.
   * Returns the allocated host port.
   */
  async expose(
    stackId: string,
    project: string,
    service: string,
    containerPort: number
  ): Promise<number> {
    // Check if already exposed
    const existing = this.registry.getPortByService(stackId, service, containerPort);
    if (existing?.proxy_container_id) {
      return existing.host_port;
    }

    // Allocate a host port
    const hostPort = await this.portAllocator.allocateOne(stackId, service, containerPort);

    // Determine the stack's Docker network
    const networkName = this.getStackNetwork(project, stackId);

    // Create the proxy container
    const containerName = `sandstorm-proxy-${stackId}-${service}-${containerPort}`;
    const container = await this.docker.createContainer({
      Image: PROXY_IMAGE,
      name: containerName,
      Cmd: [
        'TCP-LISTEN:' + containerPort + ',fork,reuseaddr',
        'TCP:' + service + ':' + containerPort,
      ],
      Labels: {
        'sandstorm.proxy': 'true',
        'sandstorm.stack-id': stackId,
        'sandstorm.service': service,
        'sandstorm.container-port': String(containerPort),
      },
      ExposedPorts: {
        [`${containerPort}/tcp`]: {},
      },
      HostConfig: {
        PortBindings: {
          [`${containerPort}/tcp`]: [{ HostPort: String(hostPort) }],
        },
        NetworkMode: networkName,
      },
    });

    await container.start();

    // Track the proxy container in the registry
    this.registry.setProxyContainerId(stackId, service, containerPort, container.id);

    return hostPort;
  }

  /**
   * Unexpose a service port by stopping and removing its proxy container.
   */
  async unexpose(stackId: string, service: string, containerPort: number): Promise<void> {
    const portInfo = this.registry.getPortByService(stackId, service, containerPort);
    if (!portInfo?.proxy_container_id) return;

    try {
      const container = this.docker.getContainer(portInfo.proxy_container_id);
      try {
        await container.stop({ t: 2 });
      } catch {
        // Container may already be stopped
      }
      await container.remove({ force: true });
    } catch {
      // Container may already be gone
    }

    // Release port and remove registry entry
    this.registry.releasePort(stackId, service, containerPort);
  }

  /**
   * Remove all proxy containers for a stack (used during teardown).
   */
  async removeAllForStack(stackId: string): Promise<void> {
    // Find proxy containers by label
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [
          'sandstorm.proxy=true',
          `sandstorm.stack-id=${stackId}`,
        ],
      },
    });

    for (const containerInfo of containers) {
      try {
        const container = this.docker.getContainer(containerInfo.Id);
        try {
          await container.stop({ t: 2 });
        } catch {
          // Already stopped
        }
        await container.remove({ force: true });
      } catch {
        // Best effort
      }
    }
  }

  /**
   * Get the Docker network name for a stack.
   * Docker Compose default network: sandstorm-<project>-<stackId>_default
   */
  private getStackNetwork(project: string, stackId: string): string {
    return `sandstorm-${sanitizeComposeName(project)}-${sanitizeComposeName(stackId)}_default`;
  }

  /**
   * Pull the proxy image if not already available.
   */
  async ensureImage(): Promise<void> {
    try {
      await this.docker.getImage(PROXY_IMAGE).inspect();
    } catch {
      // Pull the image
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(PROXY_IMAGE, {}, (err: Error | null, stream?: NodeJS.ReadableStream) => {
          if (err || !stream) return reject(err ?? new Error('No stream returned'));
          this.docker.modem.followProgress(stream, (followErr: Error | null) => {
            if (followErr) return reject(followErr);
            resolve();
          });
        });
      });
    }
  }
}
