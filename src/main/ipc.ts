import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  registry,
  stackManager,
  dockerRuntime,
  podmanRuntime,
  cliDir,
  claudeSessionManager,
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


interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  expired: boolean;
  expiresAt?: number;
}

function getClaudeBin(): string {
  return process.env.HOME
    ? path.join(process.env.HOME, '.local', 'bin', 'claude')
    : 'claude';
}

function getClaudeEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    PATH: [
      `${process.env.HOME}/.local/bin`,
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/local/sbin',
      process.env.PATH,
    ].join(':'),
  };
}

async function getAuthStatus(): Promise<AuthStatus> {
  const credsPath = path.join(process.env.HOME || '', '.claude', '.credentials.json');
  let expired = false;
  let expiresAt: number | undefined;

  try {
    const raw = fs.readFileSync(credsPath, 'utf-8');
    const creds = JSON.parse(raw);
    const oauthData = creds.claudeAiOauth;
    if (oauthData?.expiresAt) {
      expiresAt = oauthData.expiresAt;
      expired = Date.now() > oauthData.expiresAt;
    }
  } catch {
    return { loggedIn: false, expired: false };
  }

  try {
    const result = await new Promise<{ stdout: string; exitCode: number }>((resolve) => {
      const child = spawn(getClaudeBin(), ['auth', 'status', '--output', 'json'], {
        env: getClaudeEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.on('close', (code) => resolve({ stdout, exitCode: code ?? 1 }));
      child.on('error', () => resolve({ stdout: '', exitCode: 1 }));
    });

    if (result.exitCode === 0 && result.stdout.trim()) {
      const status = JSON.parse(result.stdout.trim());
      return {
        loggedIn: status.loggedIn ?? false,
        email: status.email,
        expired,
        expiresAt,
      };
    }
  } catch {
    // Fall through
  }

  return { loggedIn: true, expired, expiresAt };
}

async function runAuthLogin(
  mainWindow?: BrowserWindow
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(getClaudeBin(), ['auth', 'login'], {
      env: getClaudeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let urlOpened = false;

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      const urlMatch = stdout.match(/(https:\/\/[^\s]+)/);
      if (urlMatch && !urlOpened) {
        urlOpened = true;
        shell.openExternal(urlMatch[1]);
        mainWindow?.webContents.send('auth:url-opened', urlMatch[1]);
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    setTimeout(() => {
      try { child.stdin.write('\n'); } catch { /* Process may have exited */ }
    }, 1000);

    child.on('close', async (code) => {
      if (code === 0) {
        await syncCredsToRunningStacks();
        mainWindow?.webContents.send('auth:completed', true);
        resolve({ success: true });
      } else {
        mainWindow?.webContents.send('auth:completed', false);
        resolve({ success: false, error: stderr.trim() || 'Auth login failed' });
      }
    });

    child.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ success: false, error: 'Auth login timed out' });
    }, 5 * 60 * 1000);
  });
}

async function syncCredsToRunningStacks(): Promise<void> {
  const credsPath = path.join(process.env.HOME || '', '.claude', '.credentials.json');
  let creds: string;
  try {
    creds = fs.readFileSync(credsPath, 'utf-8');
  } catch {
    return;
  }

  try {
    const stacks = await stackManager.listStacksWithServices();
    for (const stack of stacks) {
      if (stack.status !== 'running' && stack.status !== 'up') continue;
      const claudeService = stack.services?.find(
        (s: { name: string }) => s.name === 'claude'
      );
      if (!claudeService?.containerId) continue;

      try {
        const child = spawn('docker', [
          'exec', '-i', '-u', 'claude', claudeService.containerId,
          'bash', '-c', 'mkdir -p ~/.claude && cat > ~/.claude/.credentials.json',
        ], { stdio: ['pipe', 'ignore', 'ignore'] });
        child.stdin.write(creds);
        child.stdin.end();
        await new Promise<void>((resolve) => child.on('close', () => resolve()));
      } catch {
        // Best effort per container
      }
    }
  } catch {
    // Best effort
  }
}

export function registerIpcHandlers(mainWindow?: BrowserWindow): void {
  // Wire up stack update notifications to the renderer
  stackManager.setOnStackUpdate(() => {
    mainWindow?.webContents.send('stacks:updated');
  });

  // --- Claude Sessions ---

  ipcMain.handle(
    'claude:send',
    (_event, tabId: string, message: string, projectDir?: string) => {
      claudeSessionManager.sendMessage(tabId, message, projectDir);
    }
  );

  ipcMain.handle('claude:cancel', (_event, tabId: string) => {
    claudeSessionManager.cancelSession(tabId);
  });

  ipcMain.handle('claude:reset', (_event, tabId: string) => {
    claudeSessionManager.resetSession(tabId);
  });

  ipcMain.handle('claude:history', (_event, tabId: string) => {
    return claudeSessionManager.getHistory(tabId);
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
    async (_event, stackId: string, prompt: string) => {
      return stackManager.dispatchTask(stackId, prompt);
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
  // --- Auth ---

  ipcMain.handle('auth:status', async () => {
    return getAuthStatus();
  });

  ipcMain.handle('auth:login', async () => {
    return runAuthLogin(mainWindow);
  });

}
