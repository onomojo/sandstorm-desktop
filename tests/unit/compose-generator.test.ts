import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  findProjectComposeFile,
  readComposeFileFromConfig,
  parseProjectCompose,
  buildPortMap,
  generateComposeYaml,
  generateConfig,
  generateSandstormCompose,
  checkInitState,
  saveComposeSetup,
  validateComposeYaml,
  hasLegacyPortMappings,
  cleanupLegacyPorts,
} from '../../src/main/compose-generator';

describe('compose-generator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('findProjectComposeFile', () => {
    it('finds docker-compose.yml in project root', () => {
      fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), 'services:\n  app:\n    image: node\n');
      expect(findProjectComposeFile(tmpDir)).toBe('docker-compose.yml');
    });

    it('finds docker-compose.yaml variant', () => {
      fs.writeFileSync(path.join(tmpDir, 'docker-compose.yaml'), 'services:\n  app:\n    image: node\n');
      expect(findProjectComposeFile(tmpDir)).toBe('docker-compose.yaml');
    });

    it('finds compose.yml variant', () => {
      fs.writeFileSync(path.join(tmpDir, 'compose.yml'), 'services:\n  app:\n    image: node\n');
      expect(findProjectComposeFile(tmpDir)).toBe('compose.yml');
    });

    it('returns null when no compose file exists', () => {
      expect(findProjectComposeFile(tmpDir)).toBeNull();
    });

    it('uses configComposeFile when provided and file exists', () => {
      fs.writeFileSync(path.join(tmpDir, 'custom-compose.yml'), 'services:\n  app:\n    image: node\n');
      expect(findProjectComposeFile(tmpDir, 'custom-compose.yml')).toBe('custom-compose.yml');
    });

    it('returns null when configComposeFile points to non-existent file', () => {
      expect(findProjectComposeFile(tmpDir, 'missing.yml')).toBeNull();
    });
  });

  describe('readComposeFileFromConfig', () => {
    it('reads COMPOSE_FILE from config', () => {
      const sandstormDir = path.join(tmpDir, '.sandstorm');
      fs.mkdirSync(sandstormDir, { recursive: true });
      fs.writeFileSync(
        path.join(sandstormDir, 'config'),
        'PROJECT_NAME=test\nCOMPOSE_FILE=docker-compose.yml\nPORT_MAP=\n',
      );
      expect(readComposeFileFromConfig(tmpDir)).toBe('docker-compose.yml');
    });

    it('returns undefined for empty COMPOSE_FILE', () => {
      const sandstormDir = path.join(tmpDir, '.sandstorm');
      fs.mkdirSync(sandstormDir, { recursive: true });
      fs.writeFileSync(
        path.join(sandstormDir, 'config'),
        'PROJECT_NAME=test\nCOMPOSE_FILE=\n',
      );
      expect(readComposeFileFromConfig(tmpDir)).toBeUndefined();
    });

    it('returns undefined when no config exists', () => {
      expect(readComposeFileFromConfig(tmpDir)).toBeUndefined();
    });
  });

  describe('parseProjectCompose', () => {
    it('extracts services with ports and images', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'docker-compose.yml'),
        [
          'services:',
          '  app:',
          '    build: .',
          '    ports:',
          '      - "3000:3000"',
          '      - "3001:3001"',
          '  db:',
          '    image: postgres:16',
          '    ports:',
          '      - "5432:5432"',
          '',
        ].join('\n'),
      );

      const result = parseProjectCompose(tmpDir, 'docker-compose.yml');
      expect(result.services).toHaveLength(2);
      expect(result.projectName).toBe(path.basename(tmpDir).toLowerCase().replace(/[^a-z0-9]/g, '-'));

      const app = result.services.find((s) => s.name === 'app');
      expect(app).toBeDefined();
      expect(app!.ports).toEqual([
        { host: '3000', container: '3000' },
        { host: '3001', container: '3001' },
      ]);
      expect(app!.hasBuilt).toBe(true);
      expect(app!.description).toBe('Application service');

      const db = result.services.find((s) => s.name === 'db');
      expect(db).toBeDefined();
      expect(db!.ports).toEqual([{ host: '5432', container: '5432' }]);
      expect(db!.image).toBe('postgres:16');
      expect(db!.description).toBe('PostgreSQL database');
    });

    it('extracts named networks', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'docker-compose.yml'),
        [
          'services:',
          '  app:',
          '    image: node',
          '',
          'networks:',
          '  frontend:',
          '    name: my-frontend-net',
          '  backend:',
          '    name: my-backend-net',
          '',
        ].join('\n'),
      );

      const result = parseProjectCompose(tmpDir, 'docker-compose.yml');
      expect(result.namedNetworks).toEqual([
        { key: 'frontend', name: 'my-frontend-net' },
        { key: 'backend', name: 'my-backend-net' },
      ]);
    });

    it('handles services with no ports', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'docker-compose.yml'),
        'services:\n  worker:\n    image: node\n',
      );

      const result = parseProjectCompose(tmpDir, 'docker-compose.yml');
      expect(result.services).toHaveLength(1);
      expect(result.services[0].ports).toEqual([]);
    });

    it('auto-describes services by image name', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'docker-compose.yml'),
        [
          'services:',
          '  db:',
          '    image: postgres:16',
          '  cache:',
          '    image: redis:7',
          '  search:',
          '    image: elasticsearch:8',
          '  web:',
          '    image: nginx:latest',
          '  queue:',
          '    image: rabbitmq:3-management',
          '  mongo:',
          '    image: mongo:7',
          '  mysql:',
          '    image: mysql:8',
          '',
        ].join('\n'),
      );

      const result = parseProjectCompose(tmpDir, 'docker-compose.yml');
      const byName = Object.fromEntries(result.services.map((s) => [s.name, s.description]));
      expect(byName.db).toBe('PostgreSQL database');
      expect(byName.cache).toBe('Redis cache/store');
      expect(byName.search).toBe('Search engine');
      expect(byName.web).toBe('Nginx web server');
      expect(byName.queue).toBe('RabbitMQ message broker');
      expect(byName.mongo).toBe('MongoDB database');
      expect(byName.mysql).toBe('MySQL database');
    });
  });

  describe('buildPortMap', () => {
    it('builds correct port map string', () => {
      const services = [
        { name: 'app', ports: [{ host: '3000', container: '3000' }], image: '', hasBuilt: true, description: '' },
        { name: 'db', ports: [{ host: '5432', container: '5432' }], image: 'postgres', hasBuilt: false, description: '' },
      ];
      expect(buildPortMap(services)).toBe('app:3000:3000:0,db:5432:5432:0');
    });

    it('handles multiple ports per service', () => {
      const services = [
        {
          name: 'app',
          ports: [
            { host: '3000', container: '3000' },
            { host: '3001', container: '3001' },
          ],
          image: '',
          hasBuilt: false,
          description: '',
        },
      ];
      expect(buildPortMap(services)).toBe('app:3000:3000:0,app:3001:3001:1');
    });

    it('returns empty string for no ports', () => {
      const services = [
        { name: 'worker', ports: [], image: 'node', hasBuilt: false, description: '' },
      ];
      expect(buildPortMap(services)).toBe('');
    });
  });

  describe('generateComposeYaml', () => {
    it('generates valid compose YAML with port remapping', () => {
      const analysis = {
        services: [
          { name: 'app', ports: [{ host: '3000', container: '3000' }], image: '', hasBuilt: true, description: 'Application service' },
          { name: 'db', ports: [{ host: '5432', container: '5432' }], image: 'postgres:16', hasBuilt: false, description: 'PostgreSQL database' },
        ],
        namedNetworks: [],
        projectName: 'test-project',
        composeFile: 'docker-compose.yml',
      };

      const yaml = generateComposeYaml(analysis);

      // Check header
      expect(yaml).toContain('# Sandstorm stack override');

      // Check app service with image pin and empty port override (on-demand proxy)
      expect(yaml).toContain('  app:');
      expect(yaml).toContain('    image: sandstorm-test-project-app');
      expect(yaml).toContain('    ports: !override []');
      expect(yaml).not.toContain('SANDSTORM_PORT');
      expect(yaml).toContain('      sandstorm.description: "Application service"');

      // Check db service (no image pin since not built)
      expect(yaml).toContain('  db:');
      expect(yaml).not.toContain('    image: sandstorm-test-project-db');
      expect(yaml).toContain('      sandstorm.description: "PostgreSQL database"');

      // Check claude service
      expect(yaml).toContain('  claude:');
      expect(yaml).toContain('    image: sandstorm-test-project-claude');
      expect(yaml).toContain('      - ${SANDSTORM_WORKSPACE}:/app');
    });

    it('includes network overrides when named networks exist', () => {
      const analysis = {
        services: [{ name: 'app', ports: [], image: 'node', hasBuilt: false, description: 'Application service' }],
        namedNetworks: [{ key: 'frontend', name: 'my-net' }],
        projectName: 'test-project',
        composeFile: 'docker-compose.yml',
      };

      const yaml = generateComposeYaml(analysis);
      expect(yaml).toContain('networks:');
      expect(yaml).toContain('  frontend:');
      expect(yaml).toContain('    name: ${SANDSTORM_PROJECT}-frontend');
    });

    it('omits networks block when no named networks', () => {
      const analysis = {
        services: [{ name: 'app', ports: [], image: 'node', hasBuilt: false, description: 'Application service' }],
        namedNetworks: [],
        projectName: 'test-project',
        composeFile: 'docker-compose.yml',
      };

      const yaml = generateComposeYaml(analysis);
      expect(yaml).not.toMatch(/^networks:/m);
    });
  });

  describe('generateConfig', () => {
    it('generates valid config with port map', () => {
      const analysis = {
        services: [
          { name: 'app', ports: [{ host: '3000', container: '3000' }], image: '', hasBuilt: true, description: '' },
          { name: 'db', ports: [{ host: '5432', container: '5432' }], image: 'postgres', hasBuilt: false, description: '' },
        ],
        namedNetworks: [],
        projectName: 'my-project',
        composeFile: 'docker-compose.yml',
      };

      const config = generateConfig(analysis);
      expect(config).toContain('PROJECT_NAME=my-project');
      expect(config).toContain('COMPOSE_FILE=docker-compose.yml');
      expect(config).toContain('PORT_MAP=app:3000:3000:0,db:5432:5432:0');
      expect(config).not.toContain('PORT_OFFSET');
    });
  });

  describe('generateSandstormCompose', () => {
    it('produces complete yaml and config from a project compose file', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'docker-compose.yml'),
        [
          'services:',
          '  app:',
          '    build: .',
          '    ports:',
          '      - "8000:3000"',
          '  db:',
          '    image: postgres:16',
          '    ports:',
          '      - "5432:5432"',
          '',
        ].join('\n'),
      );

      const result = generateSandstormCompose(tmpDir, 'docker-compose.yml');
      expect(result.yaml).toContain('services:');
      expect(result.yaml).toContain('claude:');
      expect(result.config).toContain('PORT_MAP=app:8000:3000:0,db:5432:5432:0');
      expect(result.analysis.services).toHaveLength(2);
    });
  });

  describe('checkInitState', () => {
    it('returns uninitialized when no .sandstorm directory', () => {
      expect(checkInitState(tmpDir)).toBe('uninitialized');
    });

    it('returns partial when config exists but no compose', () => {
      const sandstormDir = path.join(tmpDir, '.sandstorm');
      fs.mkdirSync(sandstormDir, { recursive: true });
      fs.writeFileSync(path.join(sandstormDir, 'config'), 'PROJECT_NAME=test\n');
      expect(checkInitState(tmpDir)).toBe('partial');
    });

    it('returns full when both config and compose exist', () => {
      const sandstormDir = path.join(tmpDir, '.sandstorm');
      fs.mkdirSync(sandstormDir, { recursive: true });
      fs.writeFileSync(path.join(sandstormDir, 'config'), 'PROJECT_NAME=test\n');
      fs.writeFileSync(path.join(sandstormDir, 'docker-compose.yml'), 'services:\n  claude:\n    image: test\n');
      expect(checkInitState(tmpDir)).toBe('full');
    });
  });

  describe('saveComposeSetup', () => {
    it('saves compose YAML and updates config', () => {
      const sandstormDir = path.join(tmpDir, '.sandstorm');
      fs.mkdirSync(sandstormDir, { recursive: true });
      fs.writeFileSync(
        path.join(sandstormDir, 'config'),
        'PROJECT_NAME=test\nCOMPOSE_FILE=docker-compose.yml\n',
      );

      const yaml = 'services:\n  claude:\n    image: test\n';
      const result = saveComposeSetup(tmpDir, yaml, true, 'docker-compose.yml');
      expect(result.success).toBe(true);

      const savedYaml = fs.readFileSync(path.join(sandstormDir, 'docker-compose.yml'), 'utf-8');
      expect(savedYaml).toBe(yaml);
    });

    it('creates stacks directory', () => {
      const sandstormDir = path.join(tmpDir, '.sandstorm');
      fs.mkdirSync(sandstormDir, { recursive: true });
      fs.writeFileSync(path.join(sandstormDir, 'config'), 'PROJECT_NAME=test\n');

      saveComposeSetup(tmpDir, 'services:\n  claude:\n    image: test\n', false);
      expect(fs.existsSync(path.join(sandstormDir, 'stacks'))).toBe(true);
    });
  });

  describe('validateComposeYaml', () => {
    it('accepts valid YAML with services key', () => {
      const result = validateComposeYaml('services:\n  app:\n    image: node\n');
      expect(result.valid).toBe(true);
    });

    it('rejects empty content', () => {
      const result = validateComposeYaml('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('rejects YAML with tabs', () => {
      const result = validateComposeYaml('services:\n\tapp:\n\t\timage: node\n');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('tabs');
    });

    it('rejects YAML without services key', () => {
      const result = validateComposeYaml('volumes:\n  data:\n');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('services');
    });

    it('rejects YAML with unbalanced quotes', () => {
      const result = validateComposeYaml('services:\n  app:\n    image: "node\n');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('quotes');
    });
  });

  describe('hasLegacyPortMappings', () => {
    it('returns false when no sandstorm compose exists', () => {
      expect(hasLegacyPortMappings(tmpDir)).toBe(false);
    });

    it('returns false when compose has no legacy port mappings', () => {
      const sandstormDir = path.join(tmpDir, '.sandstorm');
      fs.mkdirSync(sandstormDir, { recursive: true });
      fs.writeFileSync(
        path.join(sandstormDir, 'docker-compose.yml'),
        'services:\n  app:\n    ports: !override []\n    labels:\n      sandstorm.description: "App"\n'
      );
      expect(hasLegacyPortMappings(tmpDir)).toBe(false);
    });

    it('returns true when compose has SANDSTORM_PORT_ variables', () => {
      const sandstormDir = path.join(tmpDir, '.sandstorm');
      fs.mkdirSync(sandstormDir, { recursive: true });
      fs.writeFileSync(
        path.join(sandstormDir, 'docker-compose.yml'),
        'services:\n  app:\n    ports: !override\n      - "${SANDSTORM_PORT_app_0}:3000"\n'
      );
      expect(hasLegacyPortMappings(tmpDir)).toBe(true);
    });
  });

  describe('cleanupLegacyPorts', () => {
    it('regenerates compose without port mappings', () => {
      // Set up a project with compose file and config
      const sandstormDir = path.join(tmpDir, '.sandstorm');
      fs.mkdirSync(sandstormDir, { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'docker-compose.yml'),
        'services:\n  app:\n    image: node\n    ports:\n      - "3000:3000"\n'
      );
      fs.writeFileSync(
        path.join(sandstormDir, 'config'),
        'PROJECT_NAME=test\nCOMPOSE_FILE=docker-compose.yml\nPORT_MAP=app:3000:3000:0\n'
      );
      // Write a legacy compose with SANDSTORM_PORT_ vars
      fs.writeFileSync(
        path.join(sandstormDir, 'docker-compose.yml'),
        'services:\n  app:\n    ports: !override\n      - "${SANDSTORM_PORT_app_0}:3000"\n'
      );

      const result = cleanupLegacyPorts(tmpDir);
      expect(result.success).toBe(true);

      // Verify the regenerated compose has no SANDSTORM_PORT_ vars
      const newCompose = fs.readFileSync(path.join(sandstormDir, 'docker-compose.yml'), 'utf-8');
      expect(newCompose).not.toContain('SANDSTORM_PORT');
      expect(newCompose).toContain('ports: !override []');
    });

    it('returns error when no project compose file exists', () => {
      const sandstormDir = path.join(tmpDir, '.sandstorm');
      fs.mkdirSync(sandstormDir, { recursive: true });
      fs.writeFileSync(
        path.join(sandstormDir, 'config'),
        'PROJECT_NAME=test\nCOMPOSE_FILE=nonexistent.yml\n'
      );

      const result = cleanupLegacyPorts(tmpDir);
      expect(result.success).toBe(false);
    });
  });
});
