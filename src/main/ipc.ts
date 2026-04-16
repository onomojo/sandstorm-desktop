import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
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
import {
  getSpecQualityGate,
  saveSpecQualityGate,
  isSpecQualityGateMissing,
  ensureSpecQualityGate,
  getDefaultSpecQualityGate,
} from './spec-quality-gate';
import {
  getReviewPrompt,
  saveReviewPrompt,
  getDefaultReviewPrompt,
  ensureReviewPrompt,
  isReviewPromptMissing,
} from './review-prompt';

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
    registry.removeProject(id);
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

      // Generate verify.sh based on project files (shared auto-detection)
      const verifyLines = autoDetectVerifyLines(directory);
      const verifyPath = path.join(sandstormDir, 'verify.sh');
      fs.writeFileSync(verifyPath, verifyLines.join('\n') + '\n', { mode: 0o755 });

      // Generate spec quality gate with default criteria
      saveSpecQualityGate(directory, getDefaultSpecQualityGate());

      return { success: true };
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

      const missingSpecQualityGate = isSpecQualityGateMissing(directory);
      const missingReviewPrompt = isReviewPromptMissing(directory);
      const legacyPortMappings = hasLegacyPortMappings(directory);

      return {
        needsMigration: !hasVerifyScript || !hasServiceLabels || missingSpecQualityGate || missingReviewPrompt || legacyPortMappings,
        missingVerifyScript: !hasVerifyScript,
        missingServiceLabels: !hasServiceLabels,
        missingSpecQualityGate,
        missingReviewPrompt,
        networksMigrated,
        legacyPortMappings,
      };
    } catch {
      return { needsMigration: false };
    }
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

        // Save verify.sh
        const verifyPath = path.join(sandstormDir, 'verify.sh');
        fs.writeFileSync(verifyPath, verifyScript, { mode: 0o755 });

        // Ensure spec quality gate exists
        ensureSpecQualityGate(directory);

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

  // --- Spec Quality Gate ---

  ipcMain.handle('specGate:get', async (_event, projectDir: string) => {
    return getSpecQualityGate(projectDir);
  });

  ipcMain.handle(
    'specGate:save',
    async (_event, projectDir: string, content: string) => {
      saveSpecQualityGate(projectDir, content);
    }
  );

  ipcMain.handle('specGate:getDefault', async () => {
    return getDefaultSpecQualityGate();
  });

  ipcMain.handle('specGate:ensure', async (_event, projectDir: string) => {
    return ensureSpecQualityGate(projectDir);
  });

  // --- Review Prompt ---

  ipcMain.handle('reviewPrompt:get', async (_event, projectDir: string) => {
    return getReviewPrompt(projectDir);
  });

  ipcMain.handle(
    'reviewPrompt:save',
    async (_event, projectDir: string, content: string) => {
      saveReviewPrompt(projectDir, content);
    }
  );

  ipcMain.handle('reviewPrompt:getDefault', async () => {
    return getDefaultReviewPrompt();
  });

  ipcMain.handle('reviewPrompt:ensure', async (_event, projectDir: string) => {
    return ensureReviewPrompt(projectDir);
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

}
