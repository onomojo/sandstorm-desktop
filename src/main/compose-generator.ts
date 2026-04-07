import fs from 'fs';
import path from 'path';

export interface ServiceAnalysis {
  name: string;
  ports: Array<{ host: string; container: string }>;
  image: string;
  hasBuilt: boolean;
  description: string;
}

export interface ComposeAnalysis {
  services: ServiceAnalysis[];
  namedNetworks: Array<{ key: string; name: string }>;
  projectName: string;
  composeFile: string;
}

export interface GenerateComposeResult {
  yaml: string;
  config: string;
  analysis: ComposeAnalysis;
}

/**
 * Find the project's docker-compose file. Checks COMPOSE_FILE from config first,
 * then falls back to standard file names.
 */
export function findProjectComposeFile(projectDir: string, configComposeFile?: string): string | null {
  if (configComposeFile) {
    const resolved = path.isAbsolute(configComposeFile)
      ? configComposeFile
      : path.join(projectDir, configComposeFile);
    return fs.existsSync(resolved) ? configComposeFile : null;
  }

  const candidates = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(projectDir, candidate))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Read COMPOSE_FILE value from .sandstorm/config
 */
export function readComposeFileFromConfig(projectDir: string): string | undefined {
  const configPath = path.join(projectDir, '.sandstorm', 'config');
  if (!fs.existsSync(configPath)) return undefined;

  const content = fs.readFileSync(configPath, 'utf-8');
  const match = content.match(/^COMPOSE_FILE=(.*)$/m);
  if (match) {
    return match[1].trim() || undefined;
  }
  return undefined;
}

/**
 * Parse a docker-compose.yml file to extract service info and network info.
 * Uses regex-based parsing (consistent with the codebase pattern - no js-yaml dependency).
 */
export function parseProjectCompose(projectDir: string, composeFile: string): ComposeAnalysis {
  const fullPath = path.isAbsolute(composeFile)
    ? composeFile
    : path.join(projectDir, composeFile);
  const content = fs.readFileSync(fullPath, 'utf-8');
  const projectName = path.basename(projectDir).toLowerCase().replace(/[^a-z0-9]/g, '-');

  const services = parseServices(content);
  const namedNetworks = parseNetworks(content);

  return {
    services,
    namedNetworks,
    projectName,
    composeFile,
  };
}

/**
 * Parse services from a docker-compose.yml content string.
 */
function parseServices(content: string): ServiceAnalysis[] {
  const services: ServiceAnalysis[] = [];

  // Find the top-level services: block
  const servicesMatch = content.match(/^services:\s*\n((?:[ \t]+.*\n?)*)/m);
  if (!servicesMatch) return services;

  const servicesBlock = servicesMatch[1];

  // Split into individual service blocks (2-space indented keys)
  const serviceChunks = servicesBlock.split(/^  (?=\w)/m).filter(Boolean);

  for (const chunk of serviceChunks) {
    const nameMatch = chunk.match(/^([\w][\w-]*):\s*$/m) || chunk.match(/^([\w][\w-]*):\s*\n/m);
    if (!nameMatch) continue;

    const name = nameMatch[1];
    const ports = parsePorts(chunk);
    const image = parseImage(chunk);
    const hasBuilt = /^\s+build:/m.test(chunk);
    const description = autoDescribeService(name, image);

    services.push({ name, ports, image, hasBuilt, description });
  }

  return services;
}

/**
 * Parse port mappings from a service block.
 */
function parsePorts(serviceBlock: string): Array<{ host: string; container: string }> {
  const ports: Array<{ host: string; container: string }> = [];

  // Match ports section
  const portsMatch = serviceBlock.match(/^\s+ports:\s*\n((?:\s+-\s+.*\n?)*)/m);
  if (!portsMatch) return ports;

  const portsBlock = portsMatch[1];
  const portLines = portsBlock.match(/^\s+-\s+["']?(\d+):(\d+)["']?\s*$/gm);
  if (!portLines) return ports;

  for (const line of portLines) {
    const match = line.match(/(\d+):(\d+)/);
    if (match) {
      ports.push({ host: match[1], container: match[2] });
    }
  }

  return ports;
}

/**
 * Parse image name from a service block.
 */
function parseImage(serviceBlock: string): string {
  const match = serviceBlock.match(/^\s+image:\s*(.+)$/m);
  return match ? match[1].trim() : '';
}

/**
 * Parse top-level named networks from compose content.
 */
function parseNetworks(content: string): Array<{ key: string; name: string }> {
  const results: Array<{ key: string; name: string }> = [];

  const networksMatch = content.match(/^networks:\s*\n((?:[ \t]+.*\n?)*)/m);
  if (!networksMatch) return results;

  const networksBlock = networksMatch[1];
  const keyRegex = /^ {2}(\w[\w-]*):\s*\n((?:\s{4}.*\n?)*)/gm;
  let keyMatch;

  while ((keyMatch = keyRegex.exec(networksBlock)) !== null) {
    const key = keyMatch[1];
    const body = keyMatch[2];
    const nameMatch = body.match(/^\s+name:\s*(.+)/m);
    if (nameMatch) {
      const name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
      results.push({ key, name });
    }
  }

  return results;
}

/**
 * Generate a description for a service based on its image name.
 * Ported from init.sh svc_auto_description().
 */
function autoDescribeService(name: string, image: string): string {
  if (image.includes('postgres')) return 'PostgreSQL database';
  if (image.includes('mysql')) return 'MySQL database';
  if (image.includes('redis')) return 'Redis cache/store';
  if (image.includes('mongo')) return 'MongoDB database';
  if (image.includes('nginx')) return 'Nginx web server';
  if (image.includes('rabbitmq')) return 'RabbitMQ message broker';
  if (image.includes('elasticsearch') || image.includes('opensearch')) return 'Search engine';
  if (!image) return 'Application service';
  return `Service (${image})`;
}

/**
 * Build PORT_MAP string from analyzed services.
 * Format: service:host_port:container_port:index (comma-separated)
 */
export function buildPortMap(services: ServiceAnalysis[]): string {
  const entries: string[] = [];
  for (const svc of services) {
    svc.ports.forEach((port, idx) => {
      entries.push(`${svc.name}:${port.host}:${port.container}:${idx}`);
    });
  }
  return entries.join(',');
}

/**
 * Generate the .sandstorm/docker-compose.yml content.
 * Ported from init.sh lines 329-423.
 */
export function generateComposeYaml(analysis: ComposeAnalysis): string {
  const lines: string[] = [
    '# Sandstorm stack override — adds Claude workspace + remaps ports.',
    '#',
    '# All project services run untouched from the project\'s docker-compose.yml.',
    '# Bind mounts resolve to the workspace clone (not the host project).',
    '# Port mappings are offset by stack ID to avoid conflicts.',
    '#',
    '# Image names are pinned to sandstorm-<project>-<service> so all stacks',
    '# share the same images. Rebuild once, all stacks inherit the update.',
    '#',
    '# Do not run standalone. Sandstorm chains it automatically.',
    '',
    'services:',
  ];

  for (const svc of analysis.services) {
    lines.push(`  ${svc.name}:`);

    // Pin image name for built services
    if (svc.hasBuilt) {
      lines.push(`    image: sandstorm-${analysis.projectName}-${svc.name}`);
    }

    // Remap ports using environment variables
    if (svc.ports.length > 0) {
      lines.push('    ports: !override');
      svc.ports.forEach((port, idx) => {
        lines.push(`      - "\${SANDSTORM_PORT_${svc.name}_${idx}}:${port.container}"`);
      });
    }

    // Service description label
    const safeDesc = svc.description.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push('    labels:');
    lines.push(`      sandstorm.description: "${safeDesc}"`);
  }

  // Claude workspace service
  lines.push(`  claude:`);
  lines.push(`    image: sandstorm-${analysis.projectName}-claude`);
  lines.push('    build:');
  lines.push('      context: ${SANDSTORM_DIR}');
  lines.push('      dockerfile: docker/Dockerfile');
  lines.push('      args:');
  lines.push('        SANDSTORM_APP_VERSION: ${SANDSTORM_APP_VERSION:-unknown}');
  lines.push('    environment:');
  lines.push('      - GIT_USER_NAME');
  lines.push('      - GIT_USER_EMAIL');
  lines.push('      - SANDSTORM_PROJECT');
  lines.push('      - SANDSTORM_STACK_ID');
  lines.push('    volumes:');
  lines.push('      - ${SANDSTORM_WORKSPACE}:/app');
  lines.push('      - ${SANDSTORM_CONTEXT}:/sandstorm-context:ro');
  lines.push('      - /var/run/docker.sock:/var/run/docker.sock');
  lines.push('    healthcheck:');
  lines.push('      test: ["CMD", "test", "-f", "/app/.sandstorm-ready"]');
  lines.push('      interval: 3s');
  lines.push('      timeout: 2s');
  lines.push('      retries: 60');
  lines.push('    tty: true');
  lines.push('    stdin_open: true');

  // Network isolation
  if (analysis.namedNetworks.length > 0) {
    lines.push('');
    lines.push('networks:');
    for (const net of analysis.namedNetworks) {
      lines.push(`  ${net.key}:`);
      lines.push(`    name: \${SANDSTORM_PROJECT}-${net.key}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate the .sandstorm/config content.
 * Ported from init.sh lines 300-324.
 */
export function generateConfig(analysis: ComposeAnalysis): string {
  const portMap = buildPortMap(analysis.services);

  return [
    '# Sandstorm project configuration',
    `# Generated from: ${analysis.composeFile}`,
    '',
    `# Project name (used in stack naming: sandstorm-<project>-<id>)`,
    `PROJECT_NAME=${analysis.projectName}`,
    '',
    `# Project's docker-compose file`,
    `COMPOSE_FILE=${analysis.composeFile}`,
    '',
    '# Port mappings — service:host_port:container_port:index (comma-separated)',
    '# Host ports are remapped by adding (stack_id * PORT_OFFSET) at runtime',
    `PORT_MAP=${portMap}`,
    '',
    '# Port offset multiplier per stack (default: 10)',
    '# Stack 1 gets +10, stack 2 gets +20, etc.',
    'PORT_OFFSET=10',
    '',
    '# Optional: ticket prefix for branch safety checks (e.g., PROJ)',
    '# TICKET_PREFIX=',
    '',
  ].join('\n');
}

/**
 * Full compose generation: parse project compose → generate sandstorm compose + config.
 */
export function generateSandstormCompose(projectDir: string, composeFile: string): GenerateComposeResult {
  const analysis = parseProjectCompose(projectDir, composeFile);
  const yaml = generateComposeYaml(analysis);
  const config = generateConfig(analysis);
  return { yaml, config, analysis };
}

/**
 * Check the initialization state of a project.
 * Returns: 'uninitialized' | 'partial' | 'full'
 */
export function checkInitState(projectDir: string): 'uninitialized' | 'partial' | 'full' {
  const sandstormDir = path.join(projectDir, '.sandstorm');
  const configPath = path.join(sandstormDir, 'config');
  const composePath = path.join(sandstormDir, 'docker-compose.yml');

  if (!fs.existsSync(configPath)) {
    return 'uninitialized';
  }

  if (!fs.existsSync(composePath)) {
    return 'partial';
  }

  return 'full';
}

/**
 * Save generated compose and config to disk.
 */
export function saveComposeSetup(
  projectDir: string,
  composeYaml: string,
  updateConfig: boolean,
  composeFile?: string,
): { success: boolean; error?: string } {
  try {
    const sandstormDir = path.join(projectDir, '.sandstorm');
    fs.mkdirSync(path.join(sandstormDir, 'stacks'), { recursive: true });

    // Write the sandstorm docker-compose.yml
    const composePath = path.join(sandstormDir, 'docker-compose.yml');
    fs.writeFileSync(composePath, composeYaml);

    // Update config to point COMPOSE_FILE at the project's compose file if needed
    if (updateConfig && composeFile) {
      const configPath = path.join(sandstormDir, 'config');
      if (fs.existsSync(configPath)) {
        let configContent = fs.readFileSync(configPath, 'utf-8');
        // Update COMPOSE_FILE line
        if (/^COMPOSE_FILE=/m.test(configContent)) {
          configContent = configContent.replace(/^COMPOSE_FILE=.*$/m, `COMPOSE_FILE=${composeFile}`);
        } else {
          configContent += `\nCOMPOSE_FILE=${composeFile}\n`;
        }
        fs.writeFileSync(configPath, configContent);
      }
    }

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Validate that a string is valid YAML (basic validation).
 * Checks for common structural issues without a full YAML parser.
 */
export function validateComposeYaml(yaml: string): { valid: boolean; error?: string } {
  if (!yaml.trim()) {
    return { valid: false, error: 'YAML content is empty' };
  }

  // Check for tab characters (YAML doesn't allow tabs for indentation)
  if (/^\t/m.test(yaml)) {
    return { valid: false, error: 'YAML must not use tabs for indentation' };
  }

  // Must have a services: key
  if (!/^services:\s*$/m.test(yaml)) {
    return { valid: false, error: 'Missing required "services:" key' };
  }

  // Check for obvious syntax errors: lines with just a colon
  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments and empty lines
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;

    // Check for unbalanced quotes
    const singleQuotes = (line.match(/'/g) || []).length;
    const doubleQuotes = (line.match(/"/g) || []).length;
    if (singleQuotes % 2 !== 0) {
      return { valid: false, error: `Unbalanced single quotes on line ${i + 1}` };
    }
    if (doubleQuotes % 2 !== 0) {
      return { valid: false, error: `Unbalanced double quotes on line ${i + 1}` };
    }
  }

  return { valid: true };
}
