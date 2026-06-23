import Database from 'better-sqlite3';
import type { PortMapping } from '../registry';

export class PortsModule {
  constructor(private db: Database.Database) {}

  setPorts(stackId: string, ports: Omit<PortMapping, 'stack_id'>[]): void {
    const insertPort = this.db.prepare(
      'INSERT INTO ports (stack_id, service, host_port, container_port) VALUES (?, ?, ?, ?)'
    );
    const insertAll = this.db.transaction((entries: Omit<PortMapping, 'stack_id'>[]) => {
      for (const port of entries) {
        insertPort.run(stackId, port.service, port.host_port, port.container_port);
      }
    });
    insertAll(ports);
  }

  getPorts(stackId: string): PortMapping[] {
    return this.db.prepare(
      'SELECT * FROM ports WHERE stack_id = ? ORDER BY host_port ASC'
    ).all(stackId) as PortMapping[];
  }

  getAllAllocatedPorts(): number[] {
    return (this.db.prepare(
      'SELECT host_port FROM ports'
    ).all() as { host_port: number }[]).map((r) => r.host_port);
  }

  releasePorts(stackId: string): void {
    this.db.prepare('DELETE FROM ports WHERE stack_id = ?').run(stackId);
  }

  getPortByService(stackId: string, service: string, containerPort: number): PortMapping | undefined {
    return this.db.prepare(
      'SELECT * FROM ports WHERE stack_id = ? AND service = ? AND container_port = ?'
    ).get(stackId, service, containerPort) as PortMapping | undefined;
  }

  setPort(stackId: string, service: string, hostPort: number, containerPort: number): void {
    this.db.prepare(
      'INSERT INTO ports (stack_id, service, host_port, container_port) VALUES (?, ?, ?, ?)'
    ).run(stackId, service, hostPort, containerPort);
  }

  setProxyContainerId(stackId: string, service: string, containerPort: number, proxyContainerId: string): void {
    this.db.prepare(
      'UPDATE ports SET proxy_container_id = ? WHERE stack_id = ? AND service = ? AND container_port = ?'
    ).run(proxyContainerId, stackId, service, containerPort);
  }

  releasePort(stackId: string, service: string, containerPort: number): void {
    this.db.prepare(
      'DELETE FROM ports WHERE stack_id = ? AND service = ? AND container_port = ?'
    ).run(stackId, service, containerPort);
  }
}
