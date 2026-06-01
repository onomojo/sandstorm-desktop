import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);
import {
  registry,
  stackManager,
  dockerRuntime,
  podmanRuntime,
  cliDir,
  agentBackend,
  dockerConnectionManager,
  sessionMonitor,
} from './index';
import {
  createSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  isCronRunning,
  removeProjectFromCrontab,
} from './scheduler';
import type { ScheduleAction } from './scheduler/types';
import { BUILT_IN_ACTIONS } from './scheduler/built-in-actions';
import { validateProjectDir } from './validation';
import { SandstormError, ErrorCode } from './errors';
import { syncAllProjectsCrontab, projectIdFromDir } from './scheduler/scheduler-manager';
import { StackManager } from './control-plane/stack-manager';
import { CreateStackOpts } from './control-plane/stack-manager';
import { fetchAccountUsage } from './control-plane/account-usage';
import {
  getCustomContext,
  saveCustomInstructions,
  listCustomSkills,
  getCustomSkill,
  saveCustomSkill,
  deleteCustomSkill,
  getCustomSettings,
  saveCustomSettings,
} from './custom-context';
import { migrateNetworkOverrides } from './network-migration';
import {
  checkInitState,
  findProjectComposeFile,
  readComposeFileFromConfig,
  generateSandstormCompose,
  saveComposeSetup,
  validateComposeYaml,
  hasLegacyPortMappings,
  cleanupLegacyPorts,
} from './compose-generator';
import { getDefaultReviewPrompt } from './review-prompt';
import {
  defaultSpecGateDeps,
  fetchTicketForRenderer,
  runSpecCheck,
  runSpecRefine,
  extractQuestions,
  extractGateSummary,
  shortBodyHash,
  type SpecGateReport,
  type SpecGateResult,
} from './control-plane/ticket-spec';
import {
  loadRefinements,
  persistRefinement,
  deleteRefinement,
  type RefinementSession,
} from './control-plane/refinement-store';
import { randomUUID } from 'crypto';
import {
  draftPullRequest,
  workspacePathFor,
  createPullRequest,
} from './control-plane/pr-creator';
import { showNotification } from './tray';
import { createTicketWithConfig } from './control-plane/ticket-config';
import type { ProjectTicketConfig } from './control-plane/registry';
import type { EphemeralStreamEvent } from './agent/types';
import { handleToolCall, spawnSpecCheck, spawnSpecRefine } from './claude/tools';
import { listTicketsWithConfig } from './control-plane/ticket-lister';
import { listTicketComments, postComment } from './control-plane/ticket-comments';
import { getLatestUserAnswers, ANSWER_COMMENT_MARKER } from './scheduler/refine-to-comments';
import { KANBAN_COLUMNS } from '../shared/kanban';

// Set __sandstorm at module-load time so app.evaluate() works immediately
// after electron.launch() resolves — which happens during createWindow(),
// before registerIpcHandlers() is called.  The getter defers reading
// `registry` until first access so circular-import init order doesn't matter.
if (process.env.PLAYWRIGHT_TEST) {
  Object.defineProperty(globalThis, '__sandstorm', {
    get: () => ({ registry, ipcMain }),
    configurable: true,
    enumerable: true,
  });
}

/**
 * Copy bundled sandstorm skill files into a project's .claude/skills/ directory.
 * Skips if skills are already present and up to date.
 */
function syncSkillsToProject(projectDir: string, sandstormCliDir: string): void {
  try {
  const skillsSrc = path.join(sandstormCliDir, 'skills');
  const skillsDest = path.join(projectDir, '.claude', 'skills');

  if (!fs.existsSync(skillsSrc)) return;

  const srcFiles = fs.readdirSync(skillsSrc).filter((f) => f.startsWith('sandstorm-') && f.endsWith('.md'));
  if (srcFiles.length === 0) return;

  // Check if any skills are missing or outdated
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


/**
 * Auto-detect verify script content based on project files.
 * Shared by projects:initialize fallback and projects:autoDetectVerify.
 */
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
    } catch { /* ignore parse errors */ }
  }

  if (fs.existsSync(path.join(directory, 'Gemfile'))) {
    if (fs.existsSync(path.join(directory, 'bin', 'rails'))) {
      lines.push("# sandstorm-exec api bash -c 'cd /rails && bin/rails test'");
    }
  }

  if (fs.existsSync(path.join(directory, 'requirements.txt')) || fs.existsSync(path.join(directory, 'pyproject.toml'))) {
    lines.push('# sandstorm-exec app pytest');
  }

  if (fs.existsSync(path.join(directory, 'go.mod'))) {
    lines.push('# sandstorm-exec app go test ./...');
  }

  return lines;
}

export function registerIpcHandlers(mainWindow?: BrowserWindow): void {
  // Wire up stack update notifications to the renderer
  stackManager.setOnStackUpdate(() => {
    mainWindow?.webContents.send('stacks:updated');
  });

  // --- Agent Sessions (backend-agnostic) ---

  ipcMain.handle(
    'agent:send',
    (_event, tabId: string, message: string, projectDir?: string) => {
      agentBackend.sendMessage(tabId, message, projectDir);
    }
  );

  ipcMain.handle('agent:cancel', (_event, tabId: string) => {
    agentBackend.cancelSession(tabId);
  });

  ipcMain.handle('agent:reset', (_event, tabId: string) => {
    agentBackend.resetSession(tabId);
  });

  ipcMain.handle('agent:history', (_event, tabId: string) => {
    return agentBackend.getHistory(tabId);
  });

  ipcMain.handle('agent:tokenUsage', (_event, tabId: string) => {
    return agentBackend.getSessionTokens(tabId);
  });
  // --- Projects ---

  ipcMain.handle('projects:list', async () => {
    return registry.listProjects();
  });

  ipcMain.handle('projects:add', async (_event, directory: string) => {
    return registry.addProject(directory);
  });

  ipcMain.handle('projects:remove', async (_event, id: number) => {
    // Look up project directory before removal so we can clean up crontab entries
    const project = registry.getProject(id);
    registry.removeProject(id);
    if (project) {
      try {
        removeProjectFromCrontab(projectIdFromDir(project.directory));
      } catch (err) {
        console.warn('[scheduler] Failed to remove crontab entries for project:', err);
      }
    }
  });

  ipcMain.handle('projects:browse', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory'],
      title: 'Open Project Directory',
      defaultPath: app.getPath('home'),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('projects:checkInit', async (_event, directory: string) => {
    try {
      const state = checkInitState(directory);

      // Auto-sync skills if project is at least partially initialized
      if (state !== 'uninitialized') {
        syncSkillsToProject(directory, cliDir);
      }

      return { state };
    } catch {
      // Directory not accessible - treat as uninitialized
      return { state: 'uninitialized' as const };
    }
  });

  ipcMain.handle('projects:initialize', async (_event, directory: string) => {
    // Try CLI init first (full scaffolding with compose parsing)
    const cliBin = path.join(cliDir, 'bin', 'sandstorm');
    let cliError = '';
    try {
      const { exitCode, stderr, stdout } = await new Promise<{
        exitCode: number;
        stderr: string;
        stdout: string;
      }>((resolve, reject) => {
        const errChunks: Buffer[] = [];
        const outChunks: Buffer[] = [];
        // Ensure Docker CLI is on PATH — Electron may not inherit the full shell PATH
        const env = { ...process.env };
        const extraPaths = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin'];
        const currentPath = env.PATH || '';
        env.PATH = [...extraPaths, currentPath].join(':');
        // Pass app version so init-generated compose includes the build arg
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

    // Check if the project has a docker-compose.yml — if it does, the CLI
    // should have worked and the error is worth surfacing (e.g. Docker not running).
    const hasCompose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
      .some((f) => fs.existsSync(path.join(directory, f)));

    if (hasCompose) {
      // The project has a compose file but CLI init failed — don't silently
      // fall back, surface the error so the user can fix it.
      return {
        success: false,
        error: cliError || 'CLI init failed for unknown reason. Is Docker running?',
      };
    }

    // Fallback: create minimal .sandstorm scaffolding for projects without
    // their own docker-compose.yml (e.g. pure JS projects, libraries).
    // Generates a config + compose that only runs the Claude workspace container.
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

      // Generate verify.sh based on project files (shared auto-detection)
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

  // --- Migration Detection ---

  ipcMain.handle('projects:checkMigration', async (_event, directory: string) => {
    try {
      const sandstormDir = path.join(directory, '.sandstorm');
      if (!fs.existsSync(path.join(sandstormDir, 'config'))) {
        return { needsMigration: false }; // not initialized at all
      }

      const hasVerifyScript = fs.existsSync(path.join(sandstormDir, 'verify.sh'));

      let hasServiceLabels = false;
      const composePath = path.join(sandstormDir, 'docker-compose.yml');
      if (fs.existsSync(composePath)) {
        const content = fs.readFileSync(composePath, 'utf-8');
        hasServiceLabels = content.includes('sandstorm.description');
      }

      // Auto-migrate network overrides (no user interaction needed)
      let networksMigrated = false;
      try {
        networksMigrated = migrateNetworkOverrides(directory);
      } catch {
        // Non-critical — don't block migration check
      }

      // Delete the 5 obsolete ticket scripts that are now built into sandstorm-desktop.
      // These were previously copied per-project from templates. This deletion is
      // idempotent — missing files are silently skipped, and scheduled/ is never touched.
      const scriptsDir = path.join(sandstormDir, 'scripts');
      const obsoleteScripts = [
        'fetch-ticket.sh',
        'update-ticket.sh',
        'create-ticket.sh',
        'start-ticket.sh',
        'create-pr.sh',
      ];
      for (const scriptName of obsoleteScripts) {
        try { fs.unlinkSync(path.join(scriptsDir, scriptName)); } catch { /* missing = no-op */ }
      }

      const legacyPortMappings = hasLegacyPortMappings(directory);
      const ticketProviderUnconfigured = registry.getProjectTicketConfig(directory) === null;

      return {
        needsMigration:
          !hasVerifyScript ||
          !hasServiceLabels ||
          legacyPortMappings ||
          ticketProviderUnconfigured,
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

  // --- Project Ticket Config ---

  ipcMain.handle('projectTicketConfig:get', (_event, projectDir: string) => {
    return registry.getProjectTicketConfig(projectDir);
  });

  ipcMain.handle('projectTicketConfig:set', (_event, projectDir: string, config: ProjectTicketConfig) => {
    registry.setProjectTicketConfig(projectDir, config);
  });

  ipcMain.handle('projects:autoDetectVerify', async (_event, directory: string) => {
    try {
      const lines = autoDetectVerifyLines(directory);

      // Also detect service labels from existing compose
      const serviceDescriptions: Record<string, string> = {};
      const composePath = path.join(directory, '.sandstorm', 'docker-compose.yml');
      if (fs.existsSync(composePath)) {
        const content = fs.readFileSync(composePath, 'utf-8');
        // Simple YAML parsing for service names (lines matching "  <name>:")
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
    } catch (err) {
      return { verifyScript: '#!/bin/bash\nset -e\n', serviceDescriptions: {} };
    }
  });

  ipcMain.handle(
    'projects:saveMigration',
    async (
      _event,
      directory: string,
      verifyScript: string,
      serviceDescriptions: Record<string, string>,
    ) => {
      try {
        const sandstormDir = path.join(directory, '.sandstorm');

        // Save verify.sh — only write if it doesn't already exist; the migration
        // UI shows auto-detected content, not the existing file, so overwriting
        // here would silently destroy user customizations.
        const verifyPath = path.join(sandstormDir, 'verify.sh');
        if (!fs.existsSync(verifyPath)) {
          fs.writeFileSync(verifyPath, verifyScript, { mode: 0o755 });
        }

        // Update compose file with service labels if needed
        const composePath = path.join(sandstormDir, 'docker-compose.yml');
        if (fs.existsSync(composePath) && Object.keys(serviceDescriptions).length > 0) {
          let content = fs.readFileSync(composePath, 'utf-8');

          // Only add labels if they don't already exist
          if (!content.includes('sandstorm.description')) {
            for (const [svcName, desc] of Object.entries(serviceDescriptions)) {
              // Find the service block and add labels after the service name line
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

  // --- Compose Setup ---

  ipcMain.handle('projects:generateCompose', async (_event, directory: string) => {
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

      const result = generateSandstormCompose(directory, composeFile);
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
    'projects:saveComposeSetup',
    async (_event, directory: string, composeYaml: string, composeFile: string) => {
      const validation = validateComposeYaml(composeYaml);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
      return saveComposeSetup(directory, composeYaml, true, composeFile);
    },
  );

  // --- Stacks ---

  ipcMain.handle('stacks:list', async () => {
    return stackManager.listStacksWithServices();
  });

  ipcMain.handle('stacks:get', async (_event, stackId: string) => {
    return stackManager.getStackWithServices(stackId);
  });

  ipcMain.handle('stacks:create', (_event, opts: CreateStackOpts) => {
    return stackManager.createStack(opts);
  });

  ipcMain.handle('stacks:teardown', async (_event, stackId: string) => {
    await stackManager.teardownStack(stackId);
  });

  ipcMain.handle('stacks:stop', (_event, stackId: string) => {
    stackManager.stopStack(stackId);
  });

  ipcMain.handle('stacks:start', (_event, stackId: string) => {
    stackManager.startStack(stackId);
  });

  ipcMain.handle('stacks:history', async () => {
    return stackManager.listStackHistory();
  });

  // --- Tasks ---

  ipcMain.handle(
    'tasks:dispatch',
    async (
      _event,
      stackId: string,
      prompt: string,
      model?: string,
      opts?: { gateApproved?: boolean; forceBypass?: boolean }
    ) => {
      return stackManager.dispatchTask(stackId, prompt, model, opts);
    }
  );

  ipcMain.handle('tasks:list', async (_event, stackId: string) => {
    return stackManager.getTasksForStack(stackId);
  });

  ipcMain.handle('tasks:tokenSteps', async (_event, taskId: number) => {
    return registry.getTaskTokenSteps(taskId);
  });

  ipcMain.handle('tasks:workflowProgress', async (_event, stackId: string) => {
    return stackManager.getWorkflowProgress(stackId);
  });

  // --- Diff ---

  ipcMain.handle('diff:get', async (_event, stackId: string) => {
    return stackManager.getDiff(stackId);
  });

  // --- Push ---

  ipcMain.handle(
    'push:execute',
    async (_event, stackId: string, message?: string) => {
      await stackManager.push(stackId, message);
    }
  );

  ipcMain.handle(
    'stacks:setPr',
    (_event, stackId: string, prUrl: string, prNumber: number) => {
      stackManager.setPullRequest(stackId, prUrl, prNumber);
    }
  );

  // --- Ports ---

  ipcMain.handle('ports:get', async (_event, stackId: string) => {
    return registry.getPorts(stackId);
  });

  ipcMain.handle(
    'stack:expose-port',
    async (_event, stackId: string, service: string, containerPort: number) => {
      return stackManager.exposePort(stackId, service, containerPort);
    }
  );

  ipcMain.handle(
    'stack:unexpose-port',
    async (_event, stackId: string, service: string, containerPort: number) => {
      await stackManager.unexposePort(stackId, service, containerPort);
    }
  );

  ipcMain.handle('ports:cleanupLegacy', async (_event, directory: string) => {
    return cleanupLegacyPorts(directory);
  });

  // --- Logs ---

  ipcMain.handle(
    'logs:stream',
    async (_event, containerId: string, runtime: 'docker' | 'podman') => {
      const rt = runtime === 'podman' ? podmanRuntime : dockerRuntime;
      const lines: string[] = [];
      for await (const line of rt.logs(containerId, { tail: 200 })) {
        lines.push(line);
      }
      return lines.join('');
    }
  );

  // --- Stats ---

  ipcMain.handle('stats:stack-memory', async (_event, stackId: string) => {
    return stackManager.getStackMemoryUsage(stackId);
  });

  ipcMain.handle('stats:stack-detailed', async (_event, stackId: string) => {
    return stackManager.getStackDetailedStats(stackId);
  });

  ipcMain.handle('stats:task-metrics', async (_event, stackId: string) => {
    return stackManager.getStackTaskMetrics(stackId);
  });

  ipcMain.handle('stats:token-usage', async (_event, stackId: string) => {
    return stackManager.getStackTokenUsage(stackId);
  });

  ipcMain.handle('stats:global-token-usage', async () => {
    return stackManager.getGlobalTokenUsage();
  });

  ipcMain.handle('stats:rate-limit', async () => {
    return stackManager.getRateLimitState();
  });

  ipcMain.handle('stats:account-usage', async () => {
    return fetchAccountUsage();
  });

  // --- Custom Context ---

  ipcMain.handle('context:get', async (_event, projectDir: string) => {
    return getCustomContext(projectDir);
  });

  ipcMain.handle(
    'context:saveInstructions',
    async (_event, projectDir: string, content: string) => {
      saveCustomInstructions(projectDir, content);
    }
  );

  ipcMain.handle('context:listSkills', async (_event, projectDir: string) => {
    return listCustomSkills(projectDir);
  });

  ipcMain.handle(
    'context:getSkill',
    async (_event, projectDir: string, name: string) => {
      return getCustomSkill(projectDir, name);
    }
  );

  ipcMain.handle(
    'context:saveSkill',
    async (_event, projectDir: string, name: string, content: string) => {
      saveCustomSkill(projectDir, name, content);
    }
  );

  ipcMain.handle(
    'context:deleteSkill',
    async (_event, projectDir: string, name: string) => {
      deleteCustomSkill(projectDir, name);
    }
  );

  ipcMain.handle('context:getSettings', async (_event, projectDir: string) => {
    return getCustomSettings(projectDir);
  });

  ipcMain.handle(
    'context:saveSettings',
    async (_event, projectDir: string, content: string) => {
      saveCustomSettings(projectDir, content);
    }
  );

  // --- Review Prompt ---

  ipcMain.handle('reviewPrompt:getDefault', async () => {
    return getDefaultReviewPrompt();
  });

  // --- Stale Workspace Detection & Cleanup ---

  ipcMain.handle('stacks:detectStale', async () => {
    return stackManager.detectStaleWorkspaces();
  });

  ipcMain.handle('stacks:cleanupStale', async (_event, workspacePaths: string[]) => {
    return stackManager.cleanupStaleWorkspaces(workspacePaths);
  });

  // --- Runtime ---

  ipcMain.handle('runtime:available', async () => {
    const [dockerAvail, podmanAvail] = await Promise.all([
      dockerRuntime.isAvailable(),
      podmanRuntime.isAvailable(),
    ]);
    return { docker: dockerAvail, podman: podmanAvail };
  });

  // --- Model Settings ---

  ipcMain.handle('modelSettings:getGlobal', () => {
    return registry.getGlobalModelSettings();
  });

  ipcMain.handle('modelSettings:setGlobal', (_event, settings: { inner_model?: string; outer_model?: string }) => {
    registry.setGlobalModelSettings(settings);
  });

  ipcMain.handle('modelSettings:getProject', (_event, projectDir: string) => {
    return registry.getProjectModelSettings(projectDir);
  });

  ipcMain.handle('modelSettings:setProject', (_event, projectDir: string, settings: { inner_model?: string; outer_model?: string }) => {
    registry.setProjectModelSettings(projectDir, settings);
  });

  ipcMain.handle('modelSettings:removeProject', (_event, projectDir: string) => {
    registry.removeProjectModelSettings(projectDir);
  });

  ipcMain.handle('modelSettings:getEffective', (_event, projectDir: string) => {
    return registry.getEffectiveModels(projectDir);
  });

  // --- Session Monitor ---

  ipcMain.handle('session:getState', () => {
    return sessionMonitor.getState();
  });

  ipcMain.handle('session:getSettings', () => {
    return registry.getSessionMonitorSettings();
  });

  ipcMain.handle('session:updateSettings', (_event, settings: Record<string, unknown>) => {
    registry.setSessionMonitorSettings(settings as Partial<{
      warningThreshold: number;
      criticalThreshold: number;
      autoHaltThreshold: number;
      autoHaltEnabled: boolean;
      autoResumeAfterReset: boolean;
      pollIntervalMs: number;
      idleTimeoutMs: number;
      pollingDisabled: boolean;
    }>);
    sessionMonitor.updateSettings(registry.getSessionMonitorSettings());
  });

  ipcMain.handle('session:acknowledgeCritical', () => {
    sessionMonitor.acknowledgeCritical();
  });

  ipcMain.handle('session:haltAll', () => {
    return stackManager.sessionPauseAllStacks();
  });

  ipcMain.handle('session:resumeAll', () => {
    sessionMonitor.markResumed();
    return stackManager.sessionResumeAllStacks();
  });

  ipcMain.handle('session:resumeStack', (_event, stackId: string) => {
    stackManager.sessionResumeStack(stackId);
  });

  ipcMain.handle('session:resumeStackWithContinuation', async (_event, stackId: string, manual: boolean = false) => {
    try {
      const result = await stackManager.resumeStackWithContinuation(
        stackId,
        () => sessionMonitor.getState().halted,
        manual
      );
      return { halted: false, ...result };
    } catch (err) {
      if (err instanceof SandstormError && err.code === ErrorCode.SESSION_HALTED) {
        const resetAt = sessionMonitor.getState().usage?.session?.resetsAt ?? null;
        return { halted: true, resetAt };
      }
      throw err;
    }
  });

  ipcMain.handle('session:forcePoll', async () => {
    return sessionMonitor.forcePoll();
  });

  ipcMain.on('session:activity', () => {
    sessionMonitor.reportActivity();
  });

  ipcMain.handle('docker:status', () => {
    return {
      connected: dockerConnectionManager?.isConnected ?? false,
    };
  });

  // --- Auth (delegated to agent backend) ---

  ipcMain.handle('auth:status', async () => {
    return agentBackend.getAuthStatus();
  });

  ipcMain.handle('auth:login', async () => {
    const result = await agentBackend.login(mainWindow ?? undefined);
    if (result.success) {
      // Sync credentials to running stacks after successful login
      const stacks = await stackManager.listStacksWithServices();
      await agentBackend.syncCredentials(stacks);
    }
    return result;
  });

  // --- Schedules ---

  ipcMain.handle('schedules:list', async (_event, projectDir: string) => {
    const dirError = validateProjectDir(projectDir);
    if (dirError) throw new Error(dirError.error);
    return listSchedules(projectDir);
  });

  ipcMain.handle(
    'schedules:create',
    async (_event, projectDir: string, data: { label?: string; cronExpression: string; action: ScheduleAction; enabled?: boolean }) => {
      const dirError = validateProjectDir(projectDir);
      if (dirError) throw new Error(dirError.error);
      const schedule = createSchedule({
        projectDir,
        label: data.label,
        cronExpression: data.cronExpression,
        action: data.action,
        enabled: data.enabled,
      });
      try {
        await syncAllProjectsCrontab(registry);
      } catch (err) {
        console.warn('[scheduler] Crontab sync failed (non-fatal):', err);
      }
      return schedule;
    }
  );

  ipcMain.handle(
    'schedules:update',
    async (_event, projectDir: string, id: string, patch: { label?: string; cronExpression?: string; action?: ScheduleAction; enabled?: boolean }) => {
      const dirError = validateProjectDir(projectDir);
      if (dirError) throw new Error(dirError.error);
      const schedule = updateSchedule(projectDir, id, patch);
      try {
        await syncAllProjectsCrontab(registry);
      } catch (err) {
        console.warn('[scheduler] Crontab sync failed (non-fatal):', err);
      }
      return schedule;
    }
  );

  ipcMain.handle(
    'schedules:delete',
    async (_event, projectDir: string, id: string) => {
      const dirError = validateProjectDir(projectDir);
      if (dirError) throw new Error(dirError.error);
      deleteSchedule(projectDir, id);
      try {
        await syncAllProjectsCrontab(registry);
      } catch (err) {
        console.warn('[scheduler] Crontab sync failed (non-fatal):', err);
      }
    }
  );

  ipcMain.handle('schedules:cronHealth', async () => {
    return { running: isCronRunning() };
  });

  ipcMain.handle('scheduler:listBuiltInActions', async () => {
    return BUILT_IN_ACTIONS;
  });

  ipcMain.handle('schedules:listScripts', async (_event, projectDir: string) => {
    const dirError = validateProjectDir(projectDir);
    if (dirError) throw new Error(dirError.error);
    const scriptsDir = path.join(projectDir, '.sandstorm', 'scripts', 'scheduled');
    try {
      const entries = await fs.promises.readdir(scriptsDir);
      return entries.filter((f) => f.endsWith('.sh')).sort();
    } catch {
      return [];
    }
  });


  // --- Tickets (deterministic UI for refine workflow, #310) ---
  // These IPC handlers route the renderer straight to the same ticket-fetcher
  // and spec-gate primitives that the `sandstorm-spec` skill uses, but in
  // process — no orchestrator round-trip, no skill catalog.

  const specDeps = defaultSpecGateDeps(
    (ticketId, projectDir) =>
      handleToolCall('spec_check', { ticketId, projectDir }) as Promise<SpecGateReport>,
    (ticketId, projectDir, userAnswers) =>
      handleToolCall('spec_refine', { ticketId, projectDir, userAnswers }) as Promise<SpecGateReport>,
    (projectDir) => registry.getProjectTicketConfig(projectDir),
  );

  // In-memory map of active refinement sessions (id → session + cancel handle).
  // Persisted sessions (interrupted/ready/errored) survive restarts via disk.
  const activeRefinements = new Map<string, { session: RefinementSession; cancel: (() => void) | null }>();

  /** Emit a refinement session update to the renderer. */
  function emitRefinementUpdate(session: RefinementSession): void {
    mainWindow?.webContents.send('refinement:update', session);
  }

  // On startup, load any persisted sessions (running → interrupted) and
  // broadcast them to the renderer once the window is ready.
  const persistedSessions = loadRefinements();
  for (const s of persistedSessions) {
    activeRefinements.set(s.id, { session: s, cancel: null });
    persistRefinement(s);
  }
  // Delay the broadcast slightly so the renderer has time to mount.
  setTimeout(() => {
    for (const { session } of activeRefinements.values()) {
      emitRefinementUpdate(session);
    }
  }, 500);

  function startRefinementAsync(
    ticketId: string,
    projectDir: string,
    existingSessionId: string | null,
    phase: 'check' | 'refine',
    userAnswers?: string,
  ): string {
    const id = existingSessionId ?? randomUUID();
    const session: RefinementSession = {
      id,
      ticketId,
      projectDir,
      status: 'running',
      phase,
      startedAt: Date.now(),
    };
    persistRefinement(session);
    emitRefinementUpdate(session);

    const onChunk = (event: EphemeralStreamEvent): void => {
      const delta = event.kind === 'tool_use'
        ? `→ ${event.summary}\n`
        : event.delta;
      mainWindow?.webContents.send('refinement:progress', { sessionId: id, delta });
    };

    const { promise, cancel } = phase === 'check'
      ? spawnSpecCheck(ticketId, projectDir, onChunk)
      : spawnSpecRefine(ticketId, projectDir, userAnswers, onChunk);

    activeRefinements.set(id, { session, cancel });

    promise
      .then(async (rawReport) => {
        const entry = activeRefinements.get(id);
        if (!entry) return; // was cancelled

        // Convert the raw SpecGateReport to the renderer-facing SpecGateResult.
        const url = await specDeps.readTicketUrl(ticketId);
        const passed = !!rawReport.passed;
        const reportText = (rawReport as unknown as SpecGateReport).report || '';
        const rawError = (rawReport as unknown as SpecGateReport & { error?: string }).error;

        if (passed && phase === 'check') {
          // Mark spec-ready on GitHub (best-effort, same as the sync path).
          const body = await specDeps.fetchTicket(ticketId, projectDir);
          if (body) await specDeps.markSpecReady(ticketId, shortBodyHash(body));
        }

        const result: SpecGateResult = rawError
          ? { passed: false, questions: [], gateSummary: '', ticketUrl: url || null, cached: false, error: rawError }
          : {
              passed,
              questions: passed ? [] : extractQuestions(reportText),
              gateSummary: extractGateSummary(reportText),
              ticketUrl: url || null,
              cached: false,
            };

        const done: RefinementSession = { ...session, status: 'ready', result };
        activeRefinements.set(id, { session: done, cancel: null });
        persistRefinement(done);
        emitRefinementUpdate(done);
      })
      .catch((err: unknown) => {
        const entry = activeRefinements.get(id);
        if (!entry) return; // was cancelled
        const msg = err instanceof Error ? err.message : String(err);
        const failed: RefinementSession = { ...session, status: 'errored', error: msg };
        activeRefinements.set(id, { session: failed, cancel: null });
        persistRefinement(failed);
        emitRefinementUpdate(failed);
      });

    return id;
  }

  ipcMain.handle('tickets:fetch', async (_event, ticketId: string, projectDir: string) => {
    const config = registry.getProjectTicketConfig(projectDir);
    return fetchTicketForRenderer(ticketId, config, projectDir);
  });

  ipcMain.handle('tickets:specCheck', async (_event, ticketId: string, projectDir: string) => {
    return runSpecCheck(ticketId, projectDir, specDeps);
  });

  ipcMain.handle(
    'tickets:specRefine',
    async (_event, ticketId: string, projectDir: string, userAnswers: string) => {
      return runSpecRefine(ticketId, projectDir, userAnswers, specDeps);
    },
  );

  // Async (non-blocking) variants — return a session ID immediately and
  // emit 'refinement:update' events as the operation progresses.
  ipcMain.handle(
    'tickets:specCheckAsync',
    (_event, ticketId: string, projectDir: string) => {
      const sessionId = startRefinementAsync(ticketId, projectDir, null, 'check');
      return { sessionId };
    },
  );

  ipcMain.handle(
    'tickets:specRefineAsync',
    (_event, sessionId: string, ticketId: string, projectDir: string, userAnswers: string) => {
      startRefinementAsync(ticketId, projectDir, sessionId, 'refine', userAnswers);
    },
  );

  ipcMain.handle('tickets:cancelRefinement', (_event, id: string) => {
    const entry = activeRefinements.get(id);
    if (entry) {
      entry.cancel?.();
      activeRefinements.delete(id);
      deleteRefinement(id);
      mainWindow?.webContents.send('refinement:update', { id, status: 'cancelled' });
    }
  });

  ipcMain.handle('tickets:listRefinements', () => {
    return Array.from(activeRefinements.values()).map((e) => e.session);
  });

  ipcMain.handle(
    'tickets:retryRefinementAsync',
    async (_event, sessionId: string, ticketId: string, projectDir: string) => {
      // Read the existing session to determine phase before cancelling it.
      const existingEntry = sessionId ? activeRefinements.get(sessionId) : undefined;
      const existingSession = existingEntry?.session;

      // Cancel the existing session internally (without sending a cancelled event
      // to the renderer, since we are immediately replacing it).
      if (existingEntry) {
        existingEntry.cancel?.();
        activeRefinements.delete(sessionId);
        deleteRefinement(sessionId);
      }

      // Determine whether to resume from refine phase or restart from check.
      let phase: 'check' | 'refine' = 'check';
      let userAnswers: string | undefined;

      if (existingSession?.phase === 'refine') {
        try {
          const comments = await listTicketComments(ticketId, projectDir);
          const answers = getLatestUserAnswers(comments);
          if (answers) {
            phase = 'refine';
            userAnswers = answers;
          }
        } catch {
          // fall through to check
        }
      }

      const newSessionId = startRefinementAsync(ticketId, projectDir, null, phase, userAnswers);
      return { sessionId: newSessionId };
    },
  );

  ipcMain.handle(
    'tickets:postAnswers',
    async (_event, ticketId: string, projectDir: string, answersBody: string) => {
      if (!answersBody.trim()) return;
      const body = `${ANSWER_COMMENT_MARKER}\n\n${answersBody}`;
      await postComment(ticketId, projectDir, body);
    },
  );

  ipcMain.handle(
    'tickets:create',
    async (_event, projectDir: string, title: string, body: string) => {
      const config = registry.getProjectTicketConfig(projectDir);
      if (!config) {
        throw new Error('No ticket provider configured for this project. Configure GitHub or Jira in Project Settings.');
      }
      const result = await createTicketWithConfig({ title, body, config, cwd: projectDir });
      registry.seedBoardTicket(result.ticketId, path.resolve(projectDir), title);
      return result;
    },
  );

  // --- Ticket board (kanban column persistence, #369) ---

  const VALID_KANBAN_COLUMNS: readonly string[] = KANBAN_COLUMNS;

  ipcMain.handle('tickets:list', async (_event, projectDir: string) => {
    const dirError = validateProjectDir(projectDir);
    if (dirError) throw new Error(dirError.error);
    const normalizedDir = path.resolve(projectDir);

    // Fetch from the project's configured ticket provider (built-in, no per-project
    // script). When no provider is configured, skip and return existing board rows.
    const config = registry.getProjectTicketConfig(normalizedDir);
    if (config) {
      try {
        const result = await listTicketsWithConfig(config, normalizedDir);
        if (result.ok) {
          for (const ticket of result.tickets) {
            registry.seedBoardTicket(ticket.id, normalizedDir, ticket.title);
          }
          const openIds = result.tickets.map(t => t.id);
          const deletedCount = registry.deleteClosedEarlyColumnTickets(normalizedDir, openIds);
          if (deletedCount > 0) {
            console.log(`[tickets:list] Removed ${deletedCount} closed early-column ticket(s) from board for project: ${normalizedDir}`);
          }
        }
      } catch (err) {
        console.error('[tickets:list] Failed to fetch tickets from provider:', err);
      }
    }

    return registry.listBoardTickets(normalizedDir);
  });

  ipcMain.handle('ticket-board:set-column', async (_event, ticketId: string, projectDir: string, column: string) => {
    if (!ticketId?.trim()) throw new Error('ticketId is required');
    const dirError = validateProjectDir(projectDir);
    if (dirError) throw new Error(dirError.error);
    if (!VALID_KANBAN_COLUMNS.includes(column)) throw new Error(`Invalid kanban column: "${column}"`);
    registry.setBoardTicketColumn(ticketId, path.resolve(projectDir), column);
  });

  // --- PR creation (deterministic UI for make-PR workflow, #310) ---

  ipcMain.handle('pr:draftBody', async (_event, stackId: string) => {
    const stack = await stackManager.getStackWithServices(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);
    return draftPullRequest(
      {
        stackId,
        workspace: workspacePathFor(stack.project_dir, stackId),
        ticket: stack.ticket,
      },
      {
        runEphemeral: (prompt, projectDir, timeoutMs) =>
          agentBackend.runEphemeralAgent(prompt, projectDir, timeoutMs),
        fetchTaskTail: (id) => stackManager.getTaskOutput(id, 50).catch(() => ''),
      },
    );
  });

  ipcMain.handle(
    'pr:create',
    async (_event, stackId: string, title: string, body: string) => {
      const stack = await stackManager.getStackWithServices(stackId);
      if (!stack) throw new Error(`Stack "${stackId}" not found`);

      const workspace = workspacePathFor(stack.project_dir, stackId);
      if (!fs.existsSync(workspace)) {
        throw new Error(`Stack workspace not found at ${workspace}`);
      }

      return createPullRequest(
        { stackId, title, body },
        {
          workspace,
          runGitPush: async (commitMsg) => {
            await stackManager.push(stackId, commitMsg);
          },
          createPROnHost: async (prTitle, bodyFilePath, head, base) => {
            const { stdout } = await execFileAsync(
              'gh',
              ['pr', 'create', '--title', prTitle, '--body-file', bodyFilePath, '--base', base, '--head', head],
              { cwd: workspace, timeout: 60000, maxBuffer: 1024 * 1024 },
            );
            return stdout;
          },
          checkoutBranch: (branch) =>
            stackManager.execInContainer(stackId, ['git', 'checkout', '-b', branch]),
          setPullRequest: (url, num) => stackManager.setPullRequest(stackId, url, num),
        },
      );
    },
  );

  ipcMain.handle('pr:merge', async (_event, stackId: string, prNumber: number) => {
    const stack = await stackManager.getStackWithServices(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);
    const workspace = workspacePathFor(stack.project_dir, stackId);
    try {
      await execFileAsync(
        'gh',
        ['pr', 'merge', String(prNumber), '--merge'],
        { cwd: workspace, timeout: 60000, maxBuffer: 1024 * 1024 },
      );
    } catch (err) {
      // An already-merged PR is the desired end state, not a failure: swallow it so the
      // caller still proceeds to tear down the stack and advance the card. gh reports this
      // on stderr (e.g. "GraphQL: Pull request is already merged"); the generic execFile
      // error message may instead read "Command failed: …", so check both.
      const detail = err as { stderr?: unknown; message?: unknown };
      const text = `${String(detail?.stderr ?? '')} ${String(detail?.message ?? '')}`;
      if (!/already merged/i.test(text)) throw err;
    }
  });

  ipcMain.handle('pr:createAuto', async (_event, stackId: string) => {
    const stack = await stackManager.getStackWithServices(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);

    const workspace = workspacePathFor(stack.project_dir, stackId);

    let draft: { title: string; body: string };
    try {
      draft = await draftPullRequest(
        { stackId, workspace, ticket: stack.ticket },
        {
          runEphemeral: (prompt, projectDir, timeoutMs) =>
            agentBackend.runEphemeralAgent(prompt, projectDir, timeoutMs),
          fetchTaskTail: (id) => stackManager.getTaskOutput(id, 50).catch(() => ''),
        },
      );
    } catch {
      return { status: 'draft_failed' as const };
    }

    if (!fs.existsSync(workspace)) {
      return { status: 'create_failed' as const, draft, error: 'Workspace directory not found' };
    }

    try {
      const result = await createPullRequest(
        { stackId, title: draft.title, body: draft.body },
        {
          workspace,
          runGitPush: async (commitMsg) => { await stackManager.push(stackId, commitMsg); },
          createPROnHost: async (prTitle, bodyFilePath, head, base) => {
            const { stdout } = await execFileAsync(
              'gh',
              ['pr', 'create', '--title', prTitle, '--body-file', bodyFilePath, '--base', base, '--head', head],
              { cwd: workspace, timeout: 60000, maxBuffer: 1024 * 1024 },
            );
            return stdout;
          },
          checkoutBranch: (branch) =>
            stackManager.execInContainer(stackId, ['git', 'checkout', '-b', branch]),
          setPullRequest: (url, num) => stackManager.setPullRequest(stackId, url, num),
        },
      );
      showNotification('PR created', result.url);
      return { status: 'created' as const, url: result.url, number: result.number };
    } catch (err) {
      return {
        status: 'create_failed' as const,
        draft,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

}
