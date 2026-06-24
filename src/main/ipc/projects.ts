import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { INVOKE_CHANNELS } from '../ipc-channels';
import type { IpcContext } from './types';
import { StackManager } from '../control-plane/stack-manager';
import {
  checkInitState,
  findProjectComposeFile,
  readComposeFileFromConfig,
  generateSandstormCompose,
  saveComposeSetup,
  validateComposeYaml,
  hasLegacyPortMappings,
  cleanupLegacyPorts,
} from '../compose-generator';
import { migrateNetworkOverrides } from '../network-migration';
import { fetchProviderCatalog } from '../control-plane/provider-catalog';
import { removeProjectFromCrontab } from '../scheduler';
import { projectIdFromDir } from '../scheduler/scheduler-manager';
import type { ProjectTicketConfig } from '../control-plane/registry';

function syncSkillsToProject(projectDir: string, sandstormCliDir: string): void {
  try {
    const skillsSrc = path.join(sandstormCliDir, 'skills');
    const skillsDest = path.join(projectDir, '.claude', 'skills');

    if (!fs.existsSync(skillsSrc)) return;

    const srcFiles = fs
      .readdirSync(skillsSrc)
      .filter((f) => f.startsWith('sandstorm-') && f.endsWith('.md'));
    if (srcFiles.length === 0) return;

    let needsSync = false;
    for (const file of srcFiles) {
      const destFile = path.join(skillsDest, file);
      if (!fs.existsSync(destFile)) {
        needsSync = true;
        break;
      }
      const srcStat = fs.statSync(path.join(skillsSrc, file));
      const destStat = fs.statSync(destFile);
      if (srcStat.mtimeMs > destStat.mtimeMs) {
        needsSync = true;
        break;
      }
    }

    if (!needsSync) return;

    fs.mkdirSync(skillsDest, { recursive: true });
    for (const file of srcFiles) {
      fs.copyFileSync(path.join(skillsSrc, file), path.join(skillsDest, file));
    }
  } catch {
    // Skill sync is non-critical — dont crash or trigger permission prompts
  }
}

function autoDetectVerifyLines(directory: string): string[] {
  const lines: string[] = [
    '#!/bin/bash',
    '#',
    '# Sandstorm verify script — commands run during the verification step.',
    '# Each command runs in sequence. If any fails, verification fails.',
    '#',
    "# Use 'sandstorm-exec <service> <command>' to run on service containers.",
    "# Edit this file to match your project's test/lint/build commands.",
    '#',
    'set -e',
    '',
  ];

  const pkgJsonPath = path.join(directory, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      const scripts = pkg.scripts || {};
      if (scripts.test) lines.push('npm test');
      if (scripts.typecheck) {
        lines.push('npm run typecheck');
      } else if (fs.existsSync(path.join(directory, 'tsconfig.json'))) {
        lines.push('npx tsc --noEmit');
      }
      if (scripts.build) lines.push('npm run build');
    } catch {
      /* ignore parse errors */
    }
  }

  if (fs.existsSync(path.join(directory, 'Gemfile'))) {
    if (fs.existsSync(path.join(directory, 'bin', 'rails'))) {
      lines.push("# sandstorm-exec api bash -c 'cd /rails && bin/rails test'");
    }
  }

  if (
    fs.existsSync(path.join(directory, 'requirements.txt')) ||
    fs.existsSync(path.join(directory, 'pyproject.toml'))
  ) {
    lines.push('# sandstorm-exec app pytest');
  }

  if (fs.existsSync(path.join(directory, 'go.mod'))) {
    lines.push('# sandstorm-exec app go test ./...');
  }

  return lines;
}

function getBackendServerUrl(ctx: IpcContext): string | null {
  try {
    const router = ctx.agentBackend as unknown as { getOpenCodeServerUrl?: () => string | null };
    return router.getOpenCodeServerUrl?.() ?? null;
  } catch {
    return null;
  }
}

export function registerProjectHandlers(ctx: IpcContext): void {
  ipcMain.handle(INVOKE_CHANNELS.PROJECTS_LIST, async () => {
    return ctx.registry.listProjects();
  });

  ipcMain.handle(INVOKE_CHANNELS.PROJECTS_ADD, async (_event, directory: string) => {
    return ctx.registry.addProject(directory);
  });

  ipcMain.handle(INVOKE_CHANNELS.PROJECTS_REMOVE, async (_event, id: number) => {
    const project = ctx.registry.getProject(id);
    ctx.registry.removeProject(id);
    if (project) {
      try {
        removeProjectFromCrontab(projectIdFromDir(project.directory));
      } catch (err) {
        console.warn('[scheduler] Failed to remove crontab entries for project:', err);
      }
    }
  });

  ipcMain.handle(INVOKE_CHANNELS.PROJECTS_BROWSE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory'],
      title: 'Open Project Directory',
      defaultPath: app.getPath('home'),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(INVOKE_CHANNELS.PROJECTS_CHECK_INIT, async (_event, directory: string) => {
    try {
      const state = checkInitState(directory);
      if (state !== 'uninitialized') {
        syncSkillsToProject(directory, ctx.cliDir);
      }
      return { state };
    } catch {
      return { state: 'uninitialized' as const };
    }
  });

  ipcMain.handle(INVOKE_CHANNELS.PROJECTS_INITIALIZE, async (_event, directory: string) => {
    const cliBin = path.join(ctx.cliDir, 'bin', 'sandstorm');
    let cliError = '';
    try {
      const { exitCode, stderr, stdout } = await new Promise<{
        exitCode: number;
        stderr: string;
        stdout: string;
      }>((resolve, reject) => {
        const errChunks: Buffer[] = [];
        const outChunks: Buffer[] = [];
        const env = { ...process.env };
        const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin'];
        const currentPath = env.PATH || '';
        env.PATH = [...extraPaths, currentPath].join(':');
        env.SANDSTORM_APP_VERSION = StackManager.resolveAppVersion();

        const child = spawn('bash', [cliBin, 'init', '-y'], {
          cwd: directory,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.on('data', (chunk: Buffer) => outChunks.push(chunk));
        child.stderr?.on('data', (chunk: Buffer) => errChunks.push(chunk));
        child.on('close', (code) =>
          resolve({
            exitCode: code ?? 1,
            stderr: Buffer.concat(errChunks).toString(),
            stdout: Buffer.concat(outChunks).toString(),
          }),
        );
        child.on('error', reject);
      });
      if (exitCode === 0) return { success: true };
      cliError = stderr || stdout || `CLI init exited with code ${exitCode}`;
      console.error(`[init] CLI init failed (exit ${exitCode}): ${cliError}`);
    } catch (err) {
      cliError = err instanceof Error ? err.message : String(err);
      console.error('[init] CLI init error:', err);
    }

    const hasCompose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'].some(
      (f) => fs.existsSync(path.join(directory, f)),
    );

    if (hasCompose) {
      return {
        success: false,
        error: cliError || 'CLI init failed for unknown reason. Is Docker running?',
      };
    }

    try {
      const sandstormDir = path.join(directory, '.sandstorm');
      fs.mkdirSync(path.join(sandstormDir, 'stacks'), { recursive: true });

      const projectName = path.basename(directory).toLowerCase().replace(/[^a-z0-9]/g, '-');
      const configPath = path.join(sandstormDir, 'config');
      fs.writeFileSync(
        configPath,
        [
          '# Sandstorm project configuration',
          `# Generated by Sandstorm Desktop (no project compose file found)`,
          '',
          `PROJECT_NAME=${projectName}`,
          '',
          '# No project compose file — Claude-only stacks',
          'COMPOSE_FILE=',
          '',
          '# No port mappings for project services',
          'PORT_MAP=',
          '',
          'PORT_OFFSET=10',
          '',
        ].join('\n'),
      );

      const composePath = path.join(sandstormDir, 'docker-compose.yml');
      const skippedFiles: string[] = [];
      if (fs.existsSync(composePath)) {
        console.info('[projects:initialize] docker-compose.yml already exists — not overwriting');
        skippedFiles.push('docker-compose.yml');
      } else {
        fs.writeFileSync(
          composePath,
          [
            '# Sandstorm stack override — Claude workspace only.',
            '# This project has no docker-compose services of its own.',
            '#',
            '# Do not run standalone. Sandstorm chains it automatically.',
            '',
            'services:',
            '  claude:',
            `    image: sandstorm-${projectName}-claude`,
            '    build:',
            '      context: ${SANDSTORM_DIR}',
            '      dockerfile: docker/Dockerfile',
            '      args:',
            '        SANDSTORM_APP_VERSION: ${SANDSTORM_APP_VERSION:-unknown}',
            '    environment:',
            '      - GIT_USER_NAME',
            '      - GIT_USER_EMAIL',
            '      - SANDSTORM_PROJECT',
            '      - SANDSTORM_STACK_ID',
            '    volumes:',
            '      - ${SANDSTORM_WORKSPACE}:/app',
            '      - ${SANDSTORM_USAGE_DIR}/${SANDSTORM_STACK_ID}:/home/claude/.claude/projects',
            '      - /var/run/docker.sock:/var/run/docker.sock',
            '    healthcheck:',
            '      test: ["CMD", "test", "-f", "/tmp/.sandstorm-ready"]',
            '      interval: 3s',
            '      timeout: 2s',
            '      retries: 60',
            '    tty: true',
            '    stdin_open: true',
            '',
          ].join('\n'),
        );
      }

      const verifyLines = autoDetectVerifyLines(directory);
      const verifyPath = path.join(sandstormDir, 'verify.sh');
      if (fs.existsSync(verifyPath)) {
        console.info('[projects:initialize] verify.sh already exists — not overwriting');
        skippedFiles.push('verify.sh');
      } else {
        fs.writeFileSync(verifyPath, verifyLines.join('\n') + '\n', { mode: 0o755 });
      }

      return { success: true, skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to create .sandstorm config: ${msg}` };
    }
  });

  ipcMain.handle(INVOKE_CHANNELS.PROJECTS_CHECK_MIGRATION, async (_event, directory: string) => {
    try {
      const sandstormDir = path.join(directory, '.sandstorm');
      if (!fs.existsSync(path.join(sandstormDir, 'config'))) {
        return { needsMigration: false };
      }

      const hasVerifyScript = fs.existsSync(path.join(sandstormDir, 'verify.sh'));

      let hasServiceLabels = false;
      const composePath = path.join(sandstormDir, 'docker-compose.yml');
      if (fs.existsSync(composePath)) {
        const content = fs.readFileSync(composePath, 'utf-8');
        hasServiceLabels = content.includes('sandstorm.description');
      }

      let networksMigrated = false;
      try {
        networksMigrated = migrateNetworkOverrides(directory);
      } catch {
        // Non-critical
      }

      const scriptsDir = path.join(sandstormDir, 'scripts');
      const obsoleteScripts = [
        'fetch-ticket.sh',
        'update-ticket.sh',
        'create-ticket.sh',
        'start-ticket.sh',
        'create-pr.sh',
      ];
      for (const scriptName of obsoleteScripts) {
        try {
          fs.unlinkSync(path.join(scriptsDir, scriptName));
        } catch {
          /* missing = no-op */
        }
      }

      const legacyPortMappings = hasLegacyPortMappings(directory);
      const ticketProviderUnconfigured = ctx.registry.getProjectTicketConfig(directory) === null;

      return {
        needsMigration:
          !hasVerifyScript || !hasServiceLabels || legacyPortMappings || ticketProviderUnconfigured,
        missingVerifyScript: !hasVerifyScript,
        missingServiceLabels: !hasServiceLabels,
        networksMigrated,
        legacyPortMappings,
        ticketProviderUnconfigured,
      };
    } catch {
      return { needsMigration: false };
    }
  });

  ipcMain.handle(INVOKE_CHANNELS.PROJECT_TICKET_CONFIG_GET, (_event, projectDir: string) => {
    return ctx.registry.getProjectTicketConfig(projectDir);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.PROJECT_TICKET_CONFIG_SET,
    (_event, projectDir: string, config: ProjectTicketConfig) => {
      ctx.registry.setProjectTicketConfig(projectDir, config);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.PROJECTS_AUTO_DETECT_VERIFY, async (_event, directory: string) => {
    try {
      const lines = autoDetectVerifyLines(directory);

      const serviceDescriptions: Record<string, string> = {};
      const composePath = path.join(directory, '.sandstorm', 'docker-compose.yml');
      if (fs.existsSync(composePath)) {
        const content = fs.readFileSync(composePath, 'utf-8');
        const serviceRegex = /^  (\w[\w-]*):\s*$/gm;
        let match;
        while ((match = serviceRegex.exec(content)) !== null) {
          const svcName = match[1];
          if (svcName !== 'claude') {
            serviceDescriptions[svcName] = 'Application service';
          }
        }
      }

      return {
        verifyScript: lines.join('\n') + '\n',
        serviceDescriptions,
      };
    } catch {
      return { verifyScript: '#!/bin/bash\nset -e\n', serviceDescriptions: {} };
    }
  });

  ipcMain.handle(
    INVOKE_CHANNELS.PROJECTS_SAVE_MIGRATION,
    async (
      _event,
      directory: string,
      verifyScript: string,
      serviceDescriptions: Record<string, string>,
    ) => {
      try {
        const sandstormDir = path.join(directory, '.sandstorm');

        const verifyPath = path.join(sandstormDir, 'verify.sh');
        if (!fs.existsSync(verifyPath)) {
          fs.writeFileSync(verifyPath, verifyScript, { mode: 0o755 });
        }

        const composePath = path.join(sandstormDir, 'docker-compose.yml');
        if (fs.existsSync(composePath) && Object.keys(serviceDescriptions).length > 0) {
          let content = fs.readFileSync(composePath, 'utf-8');
          if (!content.includes('sandstorm.description')) {
            for (const [svcName, desc] of Object.entries(serviceDescriptions)) {
              const svcPattern = new RegExp(`(  ${svcName}:\\s*\\n)`, 'g');
              if (svcPattern.test(content)) {
                const safeDesc = desc.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                content = content.replace(
                  new RegExp(`(  ${svcName}:\\s*\\n)`),
                  `$1    labels:\n      sandstorm.description: "${safeDesc}"\n`,
                );
              }
            }
            fs.writeFileSync(composePath, content);
          }
        }

        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg };
      }
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.PROJECTS_GENERATE_COMPOSE, async (_event, directory: string) => {
    try {
      const configComposeFile = readComposeFileFromConfig(directory);
      const composeFile = findProjectComposeFile(directory, configComposeFile);

      if (!composeFile) {
        return {
          success: false,
          error: 'This project requires a docker-compose.yml file. Sandstorm cannot manage stacks without one.',
          noProjectCompose: true,
        };
      }

      const catalog = await fetchProviderCatalog(getBackendServerUrl(ctx));
      const result = generateSandstormCompose(
        directory,
        composeFile,
        (scope) => ctx.registry.getStoredProviderKeys(scope),
        catalog?.all,
      );
      return {
        success: true,
        yaml: result.yaml,
        config: result.config,
        composeFile: result.analysis.composeFile,
        services: result.analysis.services.map((s) => ({
          name: s.name,
          description: s.description,
          ports: s.ports,
        })),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  });

  ipcMain.handle(
    INVOKE_CHANNELS.PROJECTS_SAVE_COMPOSE_SETUP,
    async (_event, directory: string, composeYaml: string, composeFile: string) => {
      const validation = validateComposeYaml(composeYaml);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
      return saveComposeSetup(directory, composeYaml, true, composeFile);
    },
  );
}
