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
  darkFactoryOrchestrator,
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
import { fetchProviderCatalog } from './control-plane/provider-catalog';
import { initEpicRunner, getEpicRunner } from './control-plane/epic-runner';
import {
  defaultSpecGateDeps,
  fetchTicketForRenderer,
  runSpecCheck,
  runSpecRefine,
  finalizeSpecGatePass,
  extractQuestions,
  extractGateSummary,
  shortBodyHash,
  capReportText,
  type SpecGateReport,
  type SpecGateResult,
} from './control-plane/ticket-spec';
import {
  loadRefinements,
  persistRefinement,
  deleteRefinement,
  filterSessionsByBoardState,
  type RefinementSession,
} from './control-plane/refinement-store';
import { randomUUID } from 'crypto';
import {
  draftPullRequest,
  workspacePathFor,
  createPullRequest,
} from './control-plane/pr-creator';
import { showNotification } from './tray';
import { createTicketWithConfig, updateTicketWithConfig, fetchRawBodyWithConfig, testJiraConnection, closeTicketWithConfig, markTicketDoneWithConfig, fetchTicketWithConfig } from './control-plane/ticket-config';
import { withRetry } from './control-plane/retry-with-backoff';
import type { TicketListError } from './control-plane/ticket-config';
import type { ProjectTicketConfig } from './control-plane/registry';
import { getAvailableModels } from './control-plane/routing';
import type { RoutingAssignment, PresetId } from './control-plane/routing';
import type { EphemeralStreamEvent } from './agent/types';
import { handleToolCall, spawnSpecCheck, spawnSpecRefine, makeContractGateDeps } from './claude/tools';
import { listTicketsWithConfig } from './control-plane/ticket-lister';
import { listTicketComments, postComment } from './control-plane/ticket-comments';
import { getLatestUserAnswers, ANSWER_COMMENT_MARKER, GATE_FAIL_REPORT_MARKER } from './scheduler/refine-to-comments';
import { KANBAN_COLUMNS } from '../shared/kanban';
import { INVOKE_CHANNELS, EVENT_CHANNELS } from './ipc-channels';
import os from 'os';
import { createUsageEngine, clearUsageCache } from './telemetry/usage-engine';
import type { DateRange, ByTicketEntry, ByEpicEntry } from './telemetry/usage-engine';
import { readEphemeralTimingRecords } from './agent/ephemeral-timing';
import { ORCHESTRATOR_TICKET_ID } from './telemetry/types';
import { TicketRollupStore } from './telemetry/rollup-store';

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

function getBackendServerUrl(): string | null {
  try {
    const router = agentBackend as unknown as { getOpenCodeServerUrl?: () => string | null };
    return router.getOpenCodeServerUrl?.() ?? null;
  } catch {
    return null;
  }
}

export function registerIpcHandlers(mainWindow?: BrowserWindow): void {
  // Initialize the epic runner singleton with live dependencies
  const epicRunner = initEpicRunner({
    listStacks: () => registry.listStacks(),
    getEpicTasks: (epicId) => registry.getEpicTasks(epicId),
    upsertEpicRunState: (epicId, projectDir, status) =>
      registry.upsertEpicRunState(epicId, projectDir, status),
    upsertEpicTask: (epicId, ticketId, opts) =>
      registry.upsertEpicTask(epicId, ticketId, opts),
    setEpicTaskDone: (epicId, ticketId) => registry.setEpicTaskDone(epicId, ticketId),
    getEpicRunState: (epicId) => registry.getEpicRunState(epicId),
    getDarkFactoryEnabled: (projectDir) => registry.getDarkFactoryEnabled(projectDir),
    getEpicMaxParallelStacks: (projectDir) => registry.getEpicMaxParallelStacks(projectDir),
    getProjectTicketConfig: (projectDir) => registry.getProjectTicketConfig(projectDir),
    createStack: (opts) => stackManager.createStack(opts),
    dispatchTask: (stackId, prompt) => stackManager.dispatchTask(stackId, prompt),
    fetchTicketWithConfig,
  });

  epicRunner.setOnStatusUpdate((_epicId, snapshot) => {
    mainWindow?.webContents.send(EVENT_CHANNELS.EPIC_STATUS, snapshot);
  });

  // Wire up stack update notifications to the renderer and advance any running epics
  stackManager.setOnStackUpdate(() => {
    mainWindow?.webContents.send(EVENT_CHANNELS.STACKS_UPDATED);
    getEpicRunner().onAnyStackUpdated().catch((err) => {
      console.warn('[EpicRunner] onAnyStackUpdated error:', err);
    });
  });

  // --- Agent Sessions (backend-agnostic) ---

  ipcMain.handle(
    INVOKE_CHANNELS.AGENT_SEND,
    (_event, tabId: string, message: string, projectDir?: string) => {
      agentBackend.sendMessage(tabId, message, projectDir);
    }
  );

  ipcMain.handle(INVOKE_CHANNELS.AGENT_CANCEL, (_event, tabId: string) => {
    agentBackend.cancelSession(tabId);
  });

  ipcMain.handle(INVOKE_CHANNELS.AGENT_RESET, (_event, tabId: string) => {
    agentBackend.resetSession(tabId);
  });

  ipcMain.handle(INVOKE_CHANNELS.AGENT_HISTORY, (_event, tabId: string) => {
    return agentBackend.getHistory(tabId);
  });

  ipcMain.handle(INVOKE_CHANNELS.AGENT_TOKEN_USAGE, (_event, tabId: string) => {
    return agentBackend.getSessionTokens(tabId);
  });
  // --- Projects ---

  ipcMain.handle(INVOKE_CHANNELS.PROJECTS_LIST, async () => {
    return registry.listProjects();
  });

  ipcMain.handle(INVOKE_CHANNELS.PROJECTS_ADD, async (_event, directory: string) => {
    return registry.addProject(directory);
  });

  ipcMain.handle(INVOKE_CHANNELS.PROJECTS_REMOVE, async (_event, id: number) => {
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

  ipcMain.handle(INVOKE_CHANNELS.PROJECTS_INITIALIZE, async (_event, directory: string) => {
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

  ipcMain.handle(INVOKE_CHANNELS.PROJECTS_CHECK_MIGRATION, async (_event, directory: string) => {
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

  ipcMain.handle(INVOKE_CHANNELS.PROJECT_TICKET_CONFIG_GET, (_event, projectDir: string) => {
    return registry.getProjectTicketConfig(projectDir);
  });

  ipcMain.handle(INVOKE_CHANNELS.PROJECT_TICKET_CONFIG_SET, (_event, projectDir: string, config: ProjectTicketConfig) => {
    registry.setProjectTicketConfig(projectDir, config);
  });

  ipcMain.handle(INVOKE_CHANNELS.PROJECTS_AUTO_DETECT_VERIFY, async (_event, directory: string) => {
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
    INVOKE_CHANNELS.PROJECTS_SAVE_MIGRATION,
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

      const catalog = await fetchProviderCatalog(getBackendServerUrl());
      const result = generateSandstormCompose(
        directory,
        composeFile,
        (scope) => registry.getStoredProviderKeys(scope),
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

  // --- Stacks ---

  ipcMain.handle(INVOKE_CHANNELS.STACKS_LIST, async () => {
    return stackManager.listStacksWithServices();
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_GET, async (_event, stackId: string) => {
    return stackManager.getStackWithServices(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_CREATE, (_event, opts: CreateStackOpts) => {
    return stackManager.createStack(opts);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_TEARDOWN, async (_event, stackId: string) => {
    await stackManager.teardownStack(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_STOP, (_event, stackId: string) => {
    stackManager.stopStack(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_START, (_event, stackId: string) => {
    stackManager.startStack(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_HISTORY, async () => {
    return stackManager.listStackHistory();
  });

  // --- Tasks ---

  ipcMain.handle(
    INVOKE_CHANNELS.TASKS_DISPATCH,
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

  ipcMain.handle(INVOKE_CHANNELS.TASKS_LIST, async (_event, stackId: string) => {
    return stackManager.getTasksForStack(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.TASKS_TOKEN_STEPS, async (_event, taskId: number) => {
    return registry.getTaskTokenSteps(taskId);
  });

  ipcMain.handle(INVOKE_CHANNELS.TASKS_WORKFLOW_PROGRESS, async (_event, stackId: string) => {
    return stackManager.getWorkflowProgress(stackId);
  });

  // --- Diff ---

  ipcMain.handle(INVOKE_CHANNELS.DIFF_GET, async (_event, stackId: string) => {
    return stackManager.getDiff(stackId);
  });

  // --- Push ---

  ipcMain.handle(
    INVOKE_CHANNELS.PUSH_EXECUTE,
    async (_event, stackId: string, message?: string) => {
      await stackManager.push(stackId, message);
    }
  );

  ipcMain.handle(
    INVOKE_CHANNELS.STACKS_SET_PR,
    (_event, stackId: string, prUrl: string, prNumber: number) => {
      stackManager.setPullRequest(stackId, prUrl, prNumber);
    }
  );

  // --- Ports ---

  ipcMain.handle(INVOKE_CHANNELS.PORTS_GET, async (_event, stackId: string) => {
    return registry.getPorts(stackId);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.STACK_EXPOSE_PORT,
    async (_event, stackId: string, service: string, containerPort: number) => {
      return stackManager.exposePort(stackId, service, containerPort);
    }
  );

  ipcMain.handle(
    INVOKE_CHANNELS.STACK_UNEXPOSE_PORT,
    async (_event, stackId: string, service: string, containerPort: number) => {
      await stackManager.unexposePort(stackId, service, containerPort);
    }
  );

  ipcMain.handle(INVOKE_CHANNELS.PORTS_CLEANUP_LEGACY, async (_event, directory: string) => {
    return cleanupLegacyPorts(directory);
  });

  // --- Logs ---

  ipcMain.handle(
    INVOKE_CHANNELS.LOGS_STREAM,
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

  ipcMain.handle(INVOKE_CHANNELS.STATS_STACK_MEMORY, async (_event, stackId: string) => {
    return stackManager.getStackMemoryUsage(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_STACK_DETAILED, async (_event, stackId: string) => {
    return stackManager.getStackDetailedStats(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_TASK_METRICS, async (_event, stackId: string) => {
    return stackManager.getStackTaskMetrics(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_TOKEN_USAGE, async (_event, stackId: string) => {
    return stackManager.getStackTokenUsage(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_GLOBAL_TOKEN_USAGE, async () => {
    return stackManager.getGlobalTokenUsage();
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_RATE_LIMIT, async () => {
    return stackManager.getRateLimitState();
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_ACCOUNT_USAGE, async () => {
    return fetchAccountUsage();
  });

  // --- Telemetry (host orchestrator usage + per-ticket attribution) ---

  const rollupStore = new TicketRollupStore(registry.getDb());

  /** Build the set of transcript roots on each request: host root + all stack usage dirs. */
  function buildTelemetryRoots(): string[] {
    const hostRoot = os.homedir() + '/.claude/projects';
    const stackRoots: string[] = [];
    for (const project of registry.listProjects()) {
      const usageDir = path.join(project.directory, '.sandstorm', 'usage');
      try {
        const entries = fs.readdirSync(usageDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            stackRoots.push(path.join(usageDir, entry.name));
          }
        }
      } catch {
        // usage dir doesn't exist yet — skip
      }
    }
    return [hostRoot, ...stackRoots];
  }

  ipcMain.handle(INVOKE_CHANNELS.STATS_TELEMETRY_SUMMARY, async (_event, range: DateRange) => {
    const engine = createUsageEngine(buildTelemetryRoots());
    const summary = engine.getSummary(range);
    const shipped = rollupStore.ticketsShipped();
    // Numerator: lifetime sum of per-ticket transcript cost excluding orchestrator bucket
    const allByTicket = engine.getByTicket({ since: '2000-01-01', until: '2099-12-31' });
    const totalCost = allByTicket
      .filter((e) => e.ticketId !== ORCHESTRATOR_TICKET_ID)
      .reduce((sum, e) => sum + e.cost, 0);
    return {
      ...summary,
      ticketsShipped: shipped,
      costPerTicket: shipped > 0 ? totalCost / shipped : null,
    };
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_TELEMETRY_DAILY, async (_event, range: DateRange) => {
    return createUsageEngine(buildTelemetryRoots()).getDaily(range);
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_TELEMETRY_BY_MODEL, async (_event, range: DateRange) => {
    return createUsageEngine(buildTelemetryRoots()).getByModel(range);
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_TELEMETRY_SESSION, async (_event, range: DateRange) => {
    return createUsageEngine(buildTelemetryRoots()).getSessions(range);
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_TELEMETRY_BY_TICKET, async (_event, range?: DateRange): Promise<ByTicketEntry[]> => {
    const stepWeights = registry.getStepWeightsByTicket();
    const taskPhaseWeights = registry.getTaskPhaseTokensByTicket();
    const allEphemeral = readEphemeralTimingRecords(agentBackend.getEphemeralTimingPath());
    const ephemeralRecords = allEphemeral
      .filter((r) => r.ticketId != null && r.stage != null)
      .map((r) => ({ ticketId: r.ticketId!, stage: r.stage!, tokens: r.tokens ?? 0 }));
    return createUsageEngine(buildTelemetryRoots(), stepWeights, ephemeralRecords, taskPhaseWeights).getByTicket(range);
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_TELEMETRY_BY_EPIC, async (_event, range?: DateRange): Promise<ByEpicEntry[]> => {
    const stepWeights = registry.getStepWeightsByTicket();
    const taskPhaseWeights = registry.getTaskPhaseTokensByTicket();
    const allEphemeral = readEphemeralTimingRecords(agentBackend.getEphemeralTimingPath());
    const ephemeralRecords = allEphemeral
      .filter((r) => r.ticketId != null && r.stage != null)
      .map((r) => ({ ticketId: r.ticketId!, stage: r.stage!, tokens: r.tokens ?? 0 }));
    const epicTasks = registry.getAllEpicTasks();
    return createUsageEngine(buildTelemetryRoots(), stepWeights, ephemeralRecords, taskPhaseWeights).getByEpic(epicTasks, range);
  });

  ipcMain.handle(INVOKE_CHANNELS.STATS_TELEMETRY_REFRESH, async () => {
    clearUsageCache();
    return { ok: true };
  });

  // --- Custom Context ---

  ipcMain.handle(INVOKE_CHANNELS.CONTEXT_GET, async (_event, projectDir: string) => {
    return getCustomContext(projectDir);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.CONTEXT_SAVE_INSTRUCTIONS,
    async (_event, projectDir: string, content: string) => {
      saveCustomInstructions(projectDir, content);
    }
  );

  ipcMain.handle(INVOKE_CHANNELS.CONTEXT_LIST_SKILLS, async (_event, projectDir: string) => {
    return listCustomSkills(projectDir);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.CONTEXT_GET_SKILL,
    async (_event, projectDir: string, name: string) => {
      return getCustomSkill(projectDir, name);
    }
  );

  ipcMain.handle(
    INVOKE_CHANNELS.CONTEXT_SAVE_SKILL,
    async (_event, projectDir: string, name: string, content: string) => {
      saveCustomSkill(projectDir, name, content);
    }
  );

  ipcMain.handle(
    INVOKE_CHANNELS.CONTEXT_DELETE_SKILL,
    async (_event, projectDir: string, name: string) => {
      deleteCustomSkill(projectDir, name);
    }
  );

  ipcMain.handle(INVOKE_CHANNELS.CONTEXT_GET_SETTINGS, async (_event, projectDir: string) => {
    return getCustomSettings(projectDir);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.CONTEXT_SAVE_SETTINGS,
    async (_event, projectDir: string, content: string) => {
      saveCustomSettings(projectDir, content);
    }
  );

  // --- Review Prompt ---

  ipcMain.handle(INVOKE_CHANNELS.REVIEW_PROMPT_GET_DEFAULT, async () => {
    return getDefaultReviewPrompt();
  });

  // --- Stale Workspace Detection & Cleanup ---

  ipcMain.handle(INVOKE_CHANNELS.STACKS_DETECT_STALE, async () => {
    return stackManager.detectStaleWorkspaces();
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_CLEANUP_STALE, async (_event, workspacePaths: string[]) => {
    return stackManager.cleanupStaleWorkspaces(workspacePaths);
  });

  // --- Runtime ---

  ipcMain.handle(INVOKE_CHANNELS.RUNTIME_AVAILABLE, async () => {
    const [dockerAvail, podmanAvail] = await Promise.all([
      dockerRuntime.isAvailable(),
      podmanRuntime.isAvailable(),
    ]);
    return { docker: dockerAvail, podman: podmanAvail };
  });

  // --- Model Settings ---

  ipcMain.handle(INVOKE_CHANNELS.MODEL_SETTINGS_GET_GLOBAL, () => {
    return registry.getGlobalModelSettings();
  });

  ipcMain.handle(INVOKE_CHANNELS.MODEL_SETTINGS_SET_GLOBAL, (_event, settings: { inner_model?: string; outer_model?: string }) => {
    registry.setGlobalModelSettings(settings);
  });

  ipcMain.handle(INVOKE_CHANNELS.MODEL_SETTINGS_GET_PROJECT, (_event, projectDir: string) => {
    return registry.getProjectModelSettings(projectDir);
  });

  ipcMain.handle(INVOKE_CHANNELS.MODEL_SETTINGS_SET_PROJECT, (_event, projectDir: string, settings: { inner_model?: string; outer_model?: string }) => {
    registry.setProjectModelSettings(projectDir, settings);
  });

  ipcMain.handle(INVOKE_CHANNELS.MODEL_SETTINGS_REMOVE_PROJECT, (_event, projectDir: string) => {
    registry.removeProjectModelSettings(projectDir);
  });

  ipcMain.handle(INVOKE_CHANNELS.MODEL_SETTINGS_GET_EFFECTIVE, (_event, projectDir: string) => {
    return registry.getEffectiveModels(projectDir);
  });

  // --- Backend Settings ---

  ipcMain.handle(INVOKE_CHANNELS.BACKEND_SETTINGS_GET_GLOBAL, () => {
    return registry.getGlobalBackendSettings();
  });

  ipcMain.handle(INVOKE_CHANNELS.BACKEND_SETTINGS_SET_GLOBAL, (_event, settings: { inner_backend?: string; outer_backend?: string; inner_provider?: string | null; inner_model?: string | null; outer_provider?: string | null; outer_model?: string | null }) => {
    registry.setGlobalBackendSettings(settings);
  });

  ipcMain.handle(INVOKE_CHANNELS.BACKEND_SETTINGS_GET_PROJECT, (_event, projectDir: string) => {
    return registry.getProjectBackendSettings(projectDir);
  });

  ipcMain.handle(INVOKE_CHANNELS.BACKEND_SETTINGS_SET_PROJECT, (_event, projectDir: string, settings: { inner_backend?: string; outer_backend?: string; inner_provider?: string | null; inner_model?: string | null; outer_provider?: string | null; outer_model?: string | null }) => {
    registry.setProjectBackendSettings(projectDir, settings);
  });

  ipcMain.handle(INVOKE_CHANNELS.BACKEND_SETTINGS_GET_EFFECTIVE, (_event, projectDir: string, surface: 'inner' | 'outer') => {
    return registry.getEffectiveBackend(projectDir, surface);
  });

  ipcMain.handle(INVOKE_CHANNELS.BACKEND_SETTINGS_SET_SECRET, (_event, scope: string, surface: 'inner' | 'outer', name: string, value: string) => {
    const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
    registry.setBackendSecret(key, surface, name, value);
  });

  ipcMain.handle(INVOKE_CHANNELS.BACKEND_SETTINGS_SECRET_STATUS, (_event, scope: string, surface: 'inner' | 'outer') => {
    const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
    return { set: registry.hasBackendSecret(key, surface) };
  });

  ipcMain.handle(INVOKE_CHANNELS.BACKEND_SETTINGS_SET_SECRET_BUNDLE, (_event, scope: string, surface: 'inner' | 'outer', bundle: Record<string, string>) => {
    const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
    registry.setBackendSecretBundle(key, surface, bundle);
  });

  ipcMain.handle(INVOKE_CHANNELS.BACKEND_SETTINGS_GET_SECRET_BUNDLE, (_event, scope: string, surface: 'inner' | 'outer') => {
    const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
    return registry.getBackendSecretBundle(key, surface);
  });

  // --- Model Routing ---

  ipcMain.handle(INVOKE_CHANNELS.MODEL_ROUTING_GET_EFFECTIVE, (_event, projectDir: string) => {
    return registry.getEffectiveRouting(projectDir);
  });

  ipcMain.handle(INVOKE_CHANNELS.MODEL_ROUTING_GET_PROJECT, (_event, projectDir: string) => {
    return registry.getProjectRouting(projectDir);
  });

  ipcMain.handle(INVOKE_CHANNELS.MODEL_ROUTING_SET_PROJECT, (_event, projectDir: string, config: { assignments?: Partial<Record<string, RoutingAssignment>>; preset?: PresetId | null }) => {
    registry.setProjectRouting(projectDir, config);
  });

  ipcMain.handle(INVOKE_CHANNELS.MODEL_ROUTING_REMOVE_PROJECT, (_event, projectDir: string) => {
    registry.removeProjectRouting(projectDir);
  });

  ipcMain.handle(INVOKE_CHANNELS.MODEL_ROUTING_GET_GLOBAL, () => {
    return registry.getGlobalRouting();
  });

  ipcMain.handle(INVOKE_CHANNELS.MODEL_ROUTING_SET_GLOBAL, (_event, config: { assignments?: Partial<Record<string, RoutingAssignment>>; preset?: PresetId | null }) => {
    registry.setGlobalRouting(config);
  });

  ipcMain.handle(INVOKE_CHANNELS.MODEL_ROUTING_APPLY_PRESET, (_event, projectDir: string, presetId: PresetId) => {
    registry.applyPreset(projectDir, presetId);
  });

  ipcMain.handle(INVOKE_CHANNELS.MODEL_ROUTING_GET_AVAILABLE_MODELS, (_event, projectDir: string) => {
    return getAvailableModels(projectDir, (key, provider) => registry.hasProviderSecret(key, provider));
  });

  ipcMain.handle(INVOKE_CHANNELS.MODEL_ROUTING_GET_AVAILABLE_MODELS_WITH_CATALOG, async (_event, projectDir: string) => {
    const catalog = await fetchProviderCatalog(getBackendServerUrl());
    return getAvailableModels(
      projectDir,
      (key, provider) => registry.hasProviderSecret(key, provider),
      catalog?.all,
    );
  });

  // --- Provider Secrets ---

  ipcMain.handle(INVOKE_CHANNELS.PROVIDER_SECRETS_STATUS, (_event, scope: string, provider: string) => {
    const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
    return { set: registry.hasProviderSecret(key, provider) };
  });

  ipcMain.handle(INVOKE_CHANNELS.PROVIDER_SECRETS_GET, (_event, scope: string, provider: string) => {
    const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
    return registry.getProviderSecretBundle(key, provider);
  });

  ipcMain.handle(INVOKE_CHANNELS.PROVIDER_SECRETS_GET_BUNDLE, (_event, scope: string, provider: string) => {
    const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
    return registry.getProviderSecretBundle(key, provider);
  });

  ipcMain.handle(INVOKE_CHANNELS.PROVIDER_SECRETS_SET, (_event, scope: string, provider: string, bundle: Record<string, string>) => {
    const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
    registry.setProviderSecretBundle(key, provider, bundle);
  });

  ipcMain.handle(INVOKE_CHANNELS.PROVIDER_SECRETS_SET_BUNDLE, (_event, scope: string, provider: string, bundle: Record<string, string>) => {
    const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
    registry.setProviderSecretBundle(key, provider, bundle);
  });

  ipcMain.handle(INVOKE_CHANNELS.PROVIDER_SECRETS_REMOVE, (_event, scope: string, provider: string) => {
    const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
    registry.removeProviderSecret(key, provider);
  });

  // --- Provider Catalog ---

  ipcMain.handle(INVOKE_CHANNELS.PROVIDERS_CATALOG, async () => {
    return fetchProviderCatalog(getBackendServerUrl());
  });

  ipcMain.handle(INVOKE_CHANNELS.PROVIDERS_CONFIGURED, (_event, scope: string) => {
    const key = scope === 'global' ? 'global' : `project:${path.resolve(scope)}`;
    return registry.getStoredProviderKeys(key);
  });

  // --- Session Monitor ---

  ipcMain.handle(INVOKE_CHANNELS.SESSION_GET_STATE, () => {
    return sessionMonitor.getState();
  });

  ipcMain.handle(INVOKE_CHANNELS.SESSION_GET_SETTINGS, () => {
    return registry.getSessionMonitorSettings();
  });

  ipcMain.handle(INVOKE_CHANNELS.SESSION_UPDATE_SETTINGS, (_event, settings: Record<string, unknown>) => {
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

  ipcMain.handle(INVOKE_CHANNELS.SESSION_ACKNOWLEDGE_CRITICAL, () => {
    sessionMonitor.acknowledgeCritical();
  });

  ipcMain.handle(INVOKE_CHANNELS.SESSION_HALT_ALL, () => {
    return stackManager.sessionPauseAllStacks();
  });

  ipcMain.handle(INVOKE_CHANNELS.SESSION_RESUME_ALL, () => {
    sessionMonitor.markResumed();
    return stackManager.sessionResumeAllStacks();
  });

  ipcMain.handle(INVOKE_CHANNELS.SESSION_RESUME_STACK, (_event, stackId: string) => {
    stackManager.sessionResumeStack(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.SESSION_RESUME_STACK_WITH_CONTINUATION, async (_event, stackId: string, manual: boolean = false) => {
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

  ipcMain.handle(INVOKE_CHANNELS.SESSION_FORCE_POLL, async () => {
    return sessionMonitor.forcePoll();
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_GET_NEEDS_HUMAN_QUESTIONS, (_event, stackId: string) => {
    return registry.getNeedsHumanQuestions(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_RESUME_NEEDS_HUMAN, async (_event, stackId: string, answers: string) => {
    await stackManager.resumeNeedsHumanStack(stackId, answers);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_ASK_CLARIFYING_QUESTIONS, async (_event, stackId: string) => {
    await stackManager.askClarifyingQuestions(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_RECHECK_COMPLETED, async (_event, stackId: string) => {
    return stackManager.recheckCompletedStack(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_RECONCILE_STATUS, async (_event, stackId: string) => {
    return stackManager.reconcileStatus(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_SELF_HEAL_CONTINUE, async (_event, stackId: string) => {
    await stackManager.selfHealContinue(stackId);
  });

  ipcMain.handle(INVOKE_CHANNELS.STACKS_RESTART_WITH_FINDINGS, async (_event, stackId: string, findings: string) => {
    return stackManager.restartWithFindings(stackId, findings);
  });

  ipcMain.on(INVOKE_CHANNELS.SESSION_ACTIVITY, () => {
    sessionMonitor.reportActivity();
  });

  ipcMain.handle(INVOKE_CHANNELS.DOCKER_STATUS, () => {
    return {
      connected: dockerConnectionManager?.isConnected ?? false,
    };
  });

  // --- Auth (delegated to agent backend) ---

  ipcMain.handle(INVOKE_CHANNELS.AUTH_STATUS, async () => {
    return agentBackend.getAuthStatus();
  });

  ipcMain.handle(INVOKE_CHANNELS.AUTH_LOGIN, async () => {
    const result = await agentBackend.login(mainWindow ?? undefined);
    if (result.success) {
      // Sync credentials to running stacks after successful login
      const stacks = await stackManager.listStacksWithServices();
      await agentBackend.syncCredentials(stacks);
    }
    return result;
  });

  // --- Schedules ---

  ipcMain.handle(INVOKE_CHANNELS.SCHEDULES_LIST, async (_event, projectDir: string) => {
    const dirError = validateProjectDir(projectDir);
    if (dirError) throw new Error(dirError.error);
    return listSchedules(projectDir);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.SCHEDULES_CREATE,
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
    INVOKE_CHANNELS.SCHEDULES_UPDATE,
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
    INVOKE_CHANNELS.SCHEDULES_DELETE,
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

  ipcMain.handle(INVOKE_CHANNELS.SCHEDULES_CRON_HEALTH, async () => {
    return { running: isCronRunning() };
  });

  ipcMain.handle(INVOKE_CHANNELS.SCHEDULER_LIST_BUILT_IN_ACTIONS, async () => {
    return BUILT_IN_ACTIONS;
  });

  ipcMain.handle(INVOKE_CHANNELS.SCHEDULES_LIST_SCRIPTS, async (_event, projectDir: string) => {
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
    makeContractGateDeps(),
  );

  // In-memory map of active refinement sessions (id → session + cancel handle).
  // Persisted sessions (interrupted/ready/errored) survive restarts via disk.
  const activeRefinements = new Map<string, { session: RefinementSession; cancel: (() => void) | null }>();

  /** Emit a refinement session update to the renderer. */
  function emitRefinementUpdate(session: RefinementSession): void {
    mainWindow?.webContents.send(EVENT_CHANNELS.REFINEMENT_UPDATE, session);
  }

  /** Cancel a refinement session: abort in-flight agent, remove from map, delete from disk, broadcast cancelled. */
  function cancelRefinementSession(id: string, broadcast = true): void {
    const entry = activeRefinements.get(id);
    if (entry) {
      entry.cancel?.();
      activeRefinements.delete(id);
      deleteRefinement(id);
      if (broadcast) {
        mainWindow?.webContents.send(EVENT_CHANNELS.REFINEMENT_UPDATE, { id, status: 'cancelled' });
      }
    }
  }

  // On startup, load any persisted sessions (running → interrupted) and
  // prune sessions whose tickets are no longer in an active refinement column.
  const persistedSessions = loadRefinements();

  // Build a per-project column cache to avoid redundant queries.
  const _startupColumnCache = new Map<string, Map<string, string>>();
  const { keep: sessionsToKeep, prune: sessionsToPrune } = filterSessionsByBoardState(
    persistedSessions,
    (ticketId, projectDir) => {
      if (!_startupColumnCache.has(projectDir)) {
        const rows = registry.listBoardTickets(projectDir);
        _startupColumnCache.set(projectDir, new Map(rows.map((r) => [r.ticket_id, r.column])));
      }
      return _startupColumnCache.get(projectDir)!.get(ticketId) ?? null;
    },
  );

  for (const s of sessionsToPrune) {
    deleteRefinement(s.id);
  }

  for (const s of sessionsToKeep) {
    activeRefinements.set(s.id, { session: s, cancel: null });
    persistRefinement(s);
  }

  // Subscribe to board column changes: cancel any refinement session when a ticket
  // leaves the refinement lifecycle (moves to backlog, in_stack, or merged).
  const REFINEMENT_CLEANUP_COLUMNS = new Set(['backlog', 'in_stack', 'merged']);
  registry.onBoardTicketMoved((ticketId, projectDir, column) => {
    if (!REFINEMENT_CLEANUP_COLUMNS.has(column)) return;
    for (const [id, entry] of activeRefinements) {
      if (entry.session.ticketId === ticketId && entry.session.projectDir === projectDir) {
        cancelRefinementSession(id);
        break;
      }
    }
  });

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
      mainWindow?.webContents.send(EVENT_CHANNELS.REFINEMENT_PROGRESS, { sessionId: id, delta });
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
        let passed = !!rawReport.passed;
        const reportText = (rawReport as unknown as SpecGateReport).report || '';
        const rawError = (rawReport as unknown as SpecGateReport & { error?: string }).error;

        // Atomic post-pass step: generate + store the contract, then mark
        // spec-ready. If it fails, downgrade to NOT passed so the ticket stays
        // in Refining and the existing Retry re-attempts (block-until-contract).
        let contractError: string | undefined;
        if (passed && phase === 'check') {
          const body = await specDeps.fetchTicket(ticketId, projectDir);
          if (body) {
            const fin = await finalizeSpecGatePass(ticketId, projectDir, body, shortBodyHash(body), specDeps);
            if (!fin.ok) {
              passed = false;
              contractError = fin.error;
            }
          } else {
            passed = false;
            contractError = 'Could not fetch ticket body for contract generation';
          }
        }

        const cappedReport = capReportText(reportText);

        const result: SpecGateResult = rawError
          ? { passed: false, questions: [], gateSummary: '', ticketUrl: url || null, cached: false, error: rawError }
          : contractError
            ? {
                passed: false,
                questions: [],
                gateSummary: 'Spec passed; contract generation failed',
                ticketUrl: url || null,
                cached: false,
                contractError,
              }
            : {
                passed,
                questions: passed ? [] : extractQuestions(reportText),
                gateSummary: extractGateSummary(reportText),
                ticketUrl: url || null,
                cached: false,
                reportText: passed ? null : (cappedReport || null),
              };

        const done: RefinementSession = { ...session, status: 'ready', result };
        activeRefinements.set(id, { session: done, cancel: null });
        persistRefinement(done);
        emitRefinementUpdate(done);

        // Best-effort: post FAIL report as a ticket comment so it's visible on GitHub.
        // Skip when the gate itself passed but the contract step failed — that's
        // not a spec FAIL and the report text is the PASS report, not gaps.
        if (!passed && !rawError && !contractError && cappedReport) {
          postComment(ticketId, projectDir, `${GATE_FAIL_REPORT_MARKER}\n\n${cappedReport}`).catch(() => {});
        }
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

  ipcMain.handle(INVOKE_CHANNELS.TICKETS_FETCH, async (_event, ticketId: string, projectDir: string) => {
    const config = registry.getProjectTicketConfig(projectDir);
    return fetchTicketForRenderer(ticketId, config, projectDir);
  });

  ipcMain.handle(INVOKE_CHANNELS.TICKETS_SPEC_CHECK, async (_event, ticketId: string, projectDir: string) => {
    return runSpecCheck(ticketId, projectDir, specDeps);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_SPEC_REFINE,
    async (_event, ticketId: string, projectDir: string, userAnswers: string) => {
      return runSpecRefine(ticketId, projectDir, userAnswers, specDeps);
    },
  );

  // Async (non-blocking) variants — return a session ID immediately and
  // emit EVENT_CHANNELS.REFINEMENT_UPDATE events as the operation progresses.
  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_SPEC_CHECK_ASYNC,
    (_event, ticketId: string, projectDir: string) => {
      const sessionId = startRefinementAsync(ticketId, projectDir, null, 'check');
      return { sessionId };
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_SPEC_REFINE_ASYNC,
    (_event, sessionId: string, ticketId: string, projectDir: string, userAnswers: string) => {
      startRefinementAsync(ticketId, projectDir, sessionId, 'refine', userAnswers);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.TICKETS_CANCEL_REFINEMENT, (_event, id: string) => {
    cancelRefinementSession(id);
  });

  ipcMain.handle(INVOKE_CHANNELS.TICKETS_LIST_REFINEMENTS, () => {
    return Array.from(activeRefinements.values()).map((e) => e.session);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_RETRY_REFINEMENT_ASYNC,
    async (_event, sessionId: string, ticketId: string, projectDir: string) => {
      // Read the existing session to determine phase before cancelling it.
      const existingEntry = sessionId ? activeRefinements.get(sessionId) : undefined;
      const existingSession = existingEntry?.session;

      // Cancel the existing session internally (without sending a cancelled event
      // to the renderer, since we are immediately replacing it).
      if (existingEntry) {
        cancelRefinementSession(sessionId, false);
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
    INVOKE_CHANNELS.TICKETS_POST_ANSWERS,
    async (_event, ticketId: string, projectDir: string, answersBody: string) => {
      if (!answersBody.trim()) return;
      const body = `${ANSWER_COMMENT_MARKER}\n\n${answersBody}`;
      await postComment(ticketId, projectDir, body);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_CREATE,
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

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_FETCH_RAW,
    async (_event, ticketId: string, projectDir: string) => {
      const config = registry.getProjectTicketConfig(projectDir);
      if (!config) {
        throw new Error('No ticket provider configured for this project. Configure GitHub or Jira in Project Settings.');
      }
      return fetchRawBodyWithConfig(ticketId, config, projectDir);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.TICKETS_UPDATE,
    async (_event, projectDir: string, ticketId: string, body: string) => {
      const config = registry.getProjectTicketConfig(projectDir);
      if (!config) {
        throw new Error('No ticket provider configured for this project. Configure GitHub or Jira in Project Settings.');
      }
      await updateTicketWithConfig(ticketId, body, config, projectDir);
    },
  );

  // --- Ticket board (kanban column persistence, #369) ---

  const VALID_KANBAN_COLUMNS: readonly string[] = KANBAN_COLUMNS;

  ipcMain.handle(INVOKE_CHANNELS.TICKETS_LIST, async (_event, projectDir: string) => {
    const dirError = validateProjectDir(projectDir);
    if (dirError) throw new Error(dirError.error);
    const normalizedDir = path.resolve(projectDir);

    // Fetch from the project's configured ticket provider (built-in, no per-project
    // script). When no provider is configured, skip and return existing board rows.
    let listError: TicketListError | null = null;
    let fetchedIds: string[] | null = null;
    const config = registry.getProjectTicketConfig(normalizedDir);
    if (config) {
      try {
        const result = await listTicketsWithConfig(config, normalizedDir);
        if (result.ok) {
          for (const ticket of result.tickets) {
            registry.seedBoardTicket(ticket.id, normalizedDir, ticket.title);
          }
          fetchedIds = result.tickets.map(t => t.id);
          const deletedCount = registry.deleteClosedEarlyColumnTickets(normalizedDir, fetchedIds);
          if (deletedCount > 0) {
            console.log(`[tickets:list] Removed ${deletedCount} closed early-column ticket(s) from board for project: ${normalizedDir}`);
          }
        } else {
          listError = result.error;
          console.error('[tickets:list] Failed to fetch tickets from provider:', result.error);
        }
      } catch (err) {
        console.error('[tickets:list] Failed to fetch tickets from provider:', err);
      }
    }

    const tickets = fetchedIds !== null
      ? registry.listBoardTicketsInOrder(normalizedDir, fetchedIds)
      : registry.listBoardTickets(normalizedDir);
    return { tickets, error: listError };
  });

  ipcMain.handle(INVOKE_CHANNELS.TICKETS_TEST_JIRA_CONNECTION, async (_event, params: {
    jiraUrl: string;
    jiraUsername: string;
    jiraApiToken: string;
    jiraProjectKey?: string | null;
    filterMode?: 'assisted' | 'advanced' | null;
    filterOwnership?: 'created' | 'assigned' | null;
    filterOpenOnly?: boolean | null;
    filterQuery?: string | null;
    label?: string;
  }) => {
    return testJiraConnection(params);
  });

  ipcMain.handle(INVOKE_CHANNELS.TICKET_BOARD_SET_COLUMN, async (_event, ticketId: string, projectDir: string, column: string) => {
    if (!ticketId?.trim()) throw new Error('ticketId is required');
    const dirError = validateProjectDir(projectDir);
    if (dirError) throw new Error(dirError.error);
    if (!VALID_KANBAN_COLUMNS.includes(column)) throw new Error(`Invalid kanban column: "${column}"`);
    registry.setBoardTicketColumn(ticketId, path.resolve(projectDir), column);
    darkFactoryOrchestrator?.handleTicketColumnChanged(ticketId, path.resolve(projectDir), column);
  });

  ipcMain.handle(INVOKE_CHANNELS.TICKET_CLOSE, async (_event, { ticketId, projectDir }: { ticketId: string; projectDir: string }) => {
    if (!ticketId?.trim()) throw new Error('ticketId is required');
    const dirError = validateProjectDir(projectDir);
    if (dirError) throw new Error(dirError.error);
    const config = registry.getProjectTicketConfig(projectDir);
    if (!config) throw new Error(`No ticket provider configured for project: ${projectDir}`);
    await closeTicketWithConfig(ticketId, config, path.resolve(projectDir));
  });

  ipcMain.handle(INVOKE_CHANNELS.TICKET_MARK_DONE, async (_event, { ticketId, projectDir }: { ticketId: string; projectDir: string }) => {
    const resolvedDir = path.resolve(projectDir);
    const config = registry.getProjectTicketConfig(resolvedDir);
    if (!config) return { ok: true }; // no ticket provider configured — skip silently
    try {
      await withRetry(
        () => markTicketDoneWithConfig(ticketId, config, resolvedDir),
        { maxAttempts: 3, baseDelayMs: 1000 },
      );
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(INVOKE_CHANNELS.TICKET_BOARD_DELETE, async (_event, { ticketId, projectDir }: { ticketId: string; projectDir: string }) => {
    if (!ticketId?.trim()) throw new Error('ticketId is required');
    const dirError = validateProjectDir(projectDir);
    if (dirError) throw new Error(dirError.error);
    registry.deleteBoardTicket(ticketId, path.resolve(projectDir));
  });

  // --- PR creation (deterministic UI for make-PR workflow, #310) ---

  ipcMain.handle(INVOKE_CHANNELS.PR_DRAFT_BODY, async (_event, stackId: string) => {
    const stack = await stackManager.getStackWithServices(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);
    const prDescriptor = registry.getEffectiveTouchpointDescriptor(stack.project_dir, 'pr_description');
    if (prDescriptor.backend === 'opencode' && prDescriptor.credentials === null) {
      return { status: 'needs_key' as const, backend: prDescriptor.backend, provider: prDescriptor.provider };
    }
    return draftPullRequest(
      {
        stackId,
        workspace: workspacePathFor(stack.project_dir, stackId),
        ticket: stack.ticket,
      },
      {
        runEphemeral: (prompt, projectDir, timeoutMs) =>
          agentBackend.runEphemeralAgent(prompt, projectDir, timeoutMs, { ticketId: stack.ticket ?? undefined, stage: 'pr' }, undefined, 'pr_description'),
        fetchTaskTail: (id) => stackManager.getTaskOutput(id, 50).catch(() => ''),
      },
    );
  });

  ipcMain.handle(
    INVOKE_CHANNELS.PR_CREATE,
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

  ipcMain.handle(INVOKE_CHANNELS.PR_MERGE, async (_event, stackId: string, prNumber: number) => {
    const stack = await stackManager.getStackWithServices(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);
    const workspace = workspacePathFor(stack.project_dir, stackId);
    try {
      await execFileAsync(
        'gh',
        ['pr', 'merge', String(prNumber), '--squash'],
        { cwd: workspace, timeout: 60000, maxBuffer: 1024 * 1024 },
      );
      return { status: 'merged' } as const;
    } catch (err) {
      // An already-merged PR is the desired end state, not a failure.
      const detail = err as { stderr?: unknown; message?: unknown };
      const text = `${String(detail?.stderr ?? '')} ${String(detail?.message ?? '')}`;
      if (/already merged/i.test(text)) return { status: 'merged' } as const;
      // Re-query mergeability to distinguish conflict failures from other failures.
      const originalError = err instanceof Error ? err.message : String(err);
      try {
        const { stdout } = await execFileAsync(
          'gh',
          ['pr', 'view', String(prNumber), '--json', 'mergeable'],
          { cwd: workspace, timeout: 30000, maxBuffer: 1024 * 1024 },
        );
        const pr = JSON.parse(stdout.trim()) as { mergeable?: string };
        if ((pr.mergeable ?? 'UNKNOWN') === 'CONFLICTING') {
          return { status: 'conflict' } as const;
        }
      } catch {
        // Re-query failed; fall through to return failed with the original error.
      }
      return { status: 'failed', error: originalError } as const;
    }
  });

  ipcMain.handle(INVOKE_CHANNELS.PR_CREATE_AUTO, async (_event, stackId: string) => {
    const stack = await stackManager.getStackWithServices(stackId);
    if (!stack) throw new Error(`Stack "${stackId}" not found`);

    const workspace = workspacePathFor(stack.project_dir, stackId);
    const prDescriptor = registry.getEffectiveTouchpointDescriptor(stack.project_dir, 'pr_description');
    if (prDescriptor.backend === 'opencode' && prDescriptor.credentials === null) {
      return { status: 'needs_key' as const, backend: prDescriptor.backend, provider: prDescriptor.provider };
    }

    let draft: { title: string; body: string };
    try {
      draft = await draftPullRequest(
        { stackId, workspace, ticket: stack.ticket },
        {
          runEphemeral: (prompt, projectDir, timeoutMs) =>
            agentBackend.runEphemeralAgent(prompt, projectDir, timeoutMs, { ticketId: stack.ticket ?? undefined, stage: 'pr' }, undefined, 'pr_description'),
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
      darkFactoryOrchestrator?.handlePrCreated(stackId, result.number);
      return { status: 'created' as const, url: result.url, number: result.number };
    } catch (err) {
      return {
        status: 'create_failed' as const,
        draft,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // --- Dark Factory ---

  ipcMain.handle(INVOKE_CHANNELS.DARK_FACTORY_GET_ENABLED, (_event, projectDir: string) => {
    return registry.getDarkFactoryEnabled(projectDir);
  });

  ipcMain.handle(INVOKE_CHANNELS.DARK_FACTORY_SET_ENABLED, (_event, projectDir: string, enabled: boolean) => {
    const prior = registry.getDarkFactoryEnabled(projectDir);
    registry.setDarkFactoryEnabled(projectDir, enabled);
    if (!prior && enabled) {
      darkFactoryOrchestrator?.handleDarkFactoryEnabled(projectDir).catch((err) => {
        console.warn('[DarkFactory] handleDarkFactoryEnabled failed:', err);
      });
    }
  });

  ipcMain.handle(INVOKE_CHANNELS.DARK_FACTORY_GET_CONFIG, (_event, projectDir: string) => {
    return registry.getDarkFactoryConfig(projectDir);
  });

  ipcMain.handle(INVOKE_CHANNELS.DARK_FACTORY_SET_CONFIG, (_event, projectDir: string, config: { level: string; merge_strategy: string }) => {
    registry.setDarkFactoryConfig(projectDir, config);
  });

  ipcMain.handle(INVOKE_CHANNELS.PR_AUTO_RESOLVE, async (_event, ticketId: string, projectDir: string) => {
    return stackManager.autoResolveConflicts(ticketId, projectDir);
  });

  // --- Epic Runner ---

  ipcMain.handle(INVOKE_CHANNELS.EPIC_START, async (_event, epicId: string, projectDir: string) => {
    return getEpicRunner().startEpic(epicId, projectDir);
  });

  ipcMain.handle(INVOKE_CHANNELS.EPIC_GET_RUN_PLAN, async (_event, epicId: string, projectDir: string) => {
    return getEpicRunner().getRunPlan(epicId, projectDir);
  });

}
