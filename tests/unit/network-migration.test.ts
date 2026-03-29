import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  parseNamedNetworks,
  findMissingNetworkOverrides,
  migrateNetworkOverrides,
} from '../../src/main/network-migration';

describe('parseNamedNetworks', () => {
  it('extracts named networks from compose content', () => {
    const compose = `
services:
  app:
    image: node:22

networks:
  mynet:
    name: mynet
  backend:
    name: backend-network
    driver: bridge
`;
    const result = parseNamedNetworks(compose);
    expect(result).toEqual([
      { key: 'mynet', name: 'mynet' },
      { key: 'backend', name: 'backend-network' },
    ]);
  });

  it('returns empty array when no networks block exists', () => {
    const compose = `
services:
  app:
    image: node:22
`;
    expect(parseNamedNetworks(compose)).toEqual([]);
  });

  it('skips networks without explicit name property', () => {
    const compose = `
services:
  app:
    image: node:22

networks:
  default:
    driver: bridge
  named:
    name: my-named-net
`;
    const result = parseNamedNetworks(compose);
    expect(result).toEqual([{ key: 'named', name: 'my-named-net' }]);
  });

  it('handles quoted name values', () => {
    const compose = `
networks:
  mynet:
    name: "my-network"
`;
    const result = parseNamedNetworks(compose);
    expect(result).toEqual([{ key: 'mynet', name: 'my-network' }]);
  });

  it('returns empty array for empty content', () => {
    expect(parseNamedNetworks('')).toEqual([]);
  });
});

describe('findMissingNetworkOverrides', () => {
  it('returns all networks when none are overridden', () => {
    const sandstormCompose = `
services:
  app:
    image: node:22
`;
    const networks = [
      { key: 'mynet', name: 'mynet' },
      { key: 'backend', name: 'backend-net' },
    ];
    const missing = findMissingNetworkOverrides(sandstormCompose, networks);
    expect(missing).toEqual(networks);
  });

  it('returns empty when all networks are already overridden', () => {
    const sandstormCompose = `
services:
  app:
    image: node:22

networks:
  mynet:
    name: \${SANDSTORM_PROJECT}-mynet
  backend:
    name: \${SANDSTORM_PROJECT}-backend
`;
    const networks = [
      { key: 'mynet', name: 'mynet' },
      { key: 'backend', name: 'backend-net' },
    ];
    const missing = findMissingNetworkOverrides(sandstormCompose, networks);
    expect(missing).toEqual([]);
  });

  it('returns only missing networks', () => {
    const sandstormCompose = `
networks:
  mynet:
    name: \${SANDSTORM_PROJECT}-mynet
`;
    const networks = [
      { key: 'mynet', name: 'mynet' },
      { key: 'backend', name: 'backend-net' },
    ];
    const missing = findMissingNetworkOverrides(sandstormCompose, networks);
    expect(missing).toEqual([{ key: 'backend', name: 'backend-net' }]);
  });
});

describe('migrateNetworkOverrides', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-migration-'));
    fs.mkdirSync(path.join(tmpDir, '.sandstorm'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds network overrides to sandstorm compose when missing', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'docker-compose.yml'),
      `services:
  app:
    image: node:22

networks:
  mynet:
    name: mynet
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.sandstorm', 'docker-compose.yml'),
      `services:
  app:
    ports:
      - "3001:3000"
`,
    );

    const result = migrateNetworkOverrides(tmpDir);
    expect(result).toBe(true);

    const updated = fs.readFileSync(
      path.join(tmpDir, '.sandstorm', 'docker-compose.yml'),
      'utf-8',
    );
    expect(updated).toContain('networks:');
    expect(updated).toContain('mynet:');
    expect(updated).toContain('name: ${SANDSTORM_PROJECT}-mynet');
  });

  it('appends to existing networks block', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'docker-compose.yml'),
      `networks:
  mynet:
    name: mynet
  other:
    name: other-net
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.sandstorm', 'docker-compose.yml'),
      `services:
  app:
    ports:
      - "3001:3000"

networks:
  mynet:
    name: \${SANDSTORM_PROJECT}-mynet
`,
    );

    const result = migrateNetworkOverrides(tmpDir);
    expect(result).toBe(true);

    const updated = fs.readFileSync(
      path.join(tmpDir, '.sandstorm', 'docker-compose.yml'),
      'utf-8',
    );
    expect(updated).toContain('name: ${SANDSTORM_PROJECT}-other');
    // Original override still present
    expect(updated).toContain('name: ${SANDSTORM_PROJECT}-mynet');
  });

  it('returns false when no project compose exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.sandstorm', 'docker-compose.yml'),
      'services: {}',
    );
    expect(migrateNetworkOverrides(tmpDir)).toBe(false);
  });

  it('returns false when no sandstorm compose exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), 'networks:\n  n:\n    name: n\n');
    fs.rmSync(path.join(tmpDir, '.sandstorm', 'docker-compose.yml'), { force: true });
    expect(migrateNetworkOverrides(tmpDir)).toBe(false);
  });

  it('returns false when project has no named networks', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'docker-compose.yml'),
      `services:
  app:
    image: node:22
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.sandstorm', 'docker-compose.yml'),
      'services: {}',
    );
    expect(migrateNetworkOverrides(tmpDir)).toBe(false);
  });

  it('returns false when all networks already overridden', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'docker-compose.yml'),
      `networks:
  mynet:
    name: mynet
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.sandstorm', 'docker-compose.yml'),
      `services: {}

networks:
  mynet:
    name: \${SANDSTORM_PROJECT}-mynet
`,
    );
    expect(migrateNetworkOverrides(tmpDir)).toBe(false);
  });

  it('handles multiple named networks at once', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'docker-compose.yml'),
      `networks:
  frontend:
    name: frontend-net
  backend:
    name: backend-net
  data:
    name: data-net
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.sandstorm', 'docker-compose.yml'),
      `services:
  app:
    image: node:22
`,
    );

    const result = migrateNetworkOverrides(tmpDir);
    expect(result).toBe(true);

    const updated = fs.readFileSync(
      path.join(tmpDir, '.sandstorm', 'docker-compose.yml'),
      'utf-8',
    );
    expect(updated).toContain('name: ${SANDSTORM_PROJECT}-frontend');
    expect(updated).toContain('name: ${SANDSTORM_PROJECT}-backend');
    expect(updated).toContain('name: ${SANDSTORM_PROJECT}-data');
  });
});
