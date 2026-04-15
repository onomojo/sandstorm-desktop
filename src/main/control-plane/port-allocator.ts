import { Registry } from './registry';
import net from 'net';

export interface ServicePort {
  service: string;
  containerPort: number;
}

export class PortAllocator {
  private rangeStart: number;
  private rangeEnd: number;

  constructor(
    private registry: Registry,
    range: [number, number] = [10000, 19999]
  ) {
    this.rangeStart = range[0];
    this.rangeEnd = range[1];
  }

  async allocate(
    stackId: string,
    services: ServicePort[]
  ): Promise<Map<string, number>> {
    const allocated = new Set(this.registry.getAllAllocatedPorts());
    const result = new Map<string, number>();
    const newPorts: { service: string; host_port: number; container_port: number; proxy_container_id: null }[] = [];

    for (const svc of services) {
      const port = await this.findAvailablePort(allocated);
      allocated.add(port);
      result.set(svc.service, port);
      newPorts.push({
        service: svc.service,
        host_port: port,
        container_port: svc.containerPort,
        proxy_container_id: null,
      });
    }

    this.registry.setPorts(stackId, newPorts);
    return result;
  }

  /**
   * Allocate a single host port for a specific service port (on-demand exposure).
   */
  async allocateOne(stackId: string, service: string, containerPort: number): Promise<number> {
    const allocated = new Set(this.registry.getAllAllocatedPorts());
    const port = await this.findAvailablePort(allocated);
    this.registry.setPort(stackId, service, port, containerPort);
    return port;
  }

  release(stackId: string): void {
    this.registry.releasePorts(stackId);
  }

  private async findAvailablePort(excluded: Set<number>): Promise<number> {
    for (let port = this.rangeStart; port <= this.rangeEnd; port++) {
      if (excluded.has(port)) continue;
      if (await this.isPortFree(port)) {
        return port;
      }
    }
    throw new Error(
      `No available ports in range ${this.rangeStart}-${this.rangeEnd}`
    );
  }

  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
  }
}
