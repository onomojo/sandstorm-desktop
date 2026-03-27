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
} from './index';
import { CreateStackOpts } from './control-plane/stack-manager';
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
      const sandstormDir = path.join(directory, '.sandstorm');
      const configPath = path.join(sandstormDir, 'config');
      const composePath = path.join(sandstormDir, 'docker-compose.yml');
      const isInitialized = fs.existsSync(configPath) && fs.existsSync(composePath);

      // Auto-sync skills if project is initialized but skills are missing
      if (isInitialized) {
        syncSkillsToProject(directory, cliDir);
      }

      return isInitialized;
    } catch {
      // Directory not accessible - treat as uninitialized
      return false;
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
          '    environment:',
          '      - GIT_USER_NAME',
          '      - GIT_USER_EMAIL',
          '      - SANDSTORM_PROJECT',
          '      - SANDSTORM_STACK_ID',
          '    volumes:',
          '      - ${SANDSTORM_WORKSPACE}:/app',
          '      - /var/run/docker.sock:/var/run/docker.sock',
          '    healthcheck:',
          '      test: ["CMD", "test", "-f", "/app/.sandstorm-ready"]',
          '      interval: 3s',
          '      timeout: 2s',
          '      retries: 60',
          '    tty: true',
          '    stdin_open: true',
          '',
        ].join('\n'),
      );

      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to create .sandstorm config: ${msg}` };
    }
  });

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

  ipcMain.handle('stacks:teardown', (_event, stackId: string) => {
    stackManager.teardownStack(stackId);
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
    async (_event, stackId: string, prompt: string, model?: string) => {
      return stackManager.dispatchTask(stackId, prompt, model);
    }
  );

  ipcMain.handle('tasks:list', async (_event, stackId: string) => {
    return stackManager.getTasksForStack(stackId);
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

  // --- Runtime ---

  ipcMain.handle('runtime:available', async () => {
    const [dockerAvail, podmanAvail] = await Promise.all([
      dockerRuntime.isAvailable(),
      podmanRuntime.isAvailable(),
    ]);
    return { docker: dockerAvail, podman: podmanAvail };
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
