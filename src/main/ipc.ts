import { ipcMain, dialog, BrowserWindow } from 'electron';
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
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('projects:checkInit', async (_event, directory: string) => {
    const configPath = path.join(directory, '.sandstorm', 'config');
    const isInitialized = fs.existsSync(configPath);

    // Auto-sync skills if project is initialized but skills are missing
    if (isInitialized) {
      syncSkillsToProject(directory, cliDir);
    }

    return isInitialized;
  });

  ipcMain.handle('projects:initialize', async (_event, directory: string) => {
    // Try CLI init first (full scaffolding with compose parsing)
    const cliBin = path.join(cliDir, 'bin', 'sandstorm');
    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn('bash', [cliBin, 'init', '-y'], {
          cwd: directory,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.on('close', (code) => resolve(code ?? 1));
        child.on('error', reject);
      });
      if (exitCode === 0) return true;
    } catch {
      // CLI init failed — fall back to minimal scaffolding
    }

    // Fallback: create minimal .sandstorm/config if CLI isn't available
    const sandstormDir = path.join(directory, '.sandstorm');
    fs.mkdirSync(sandstormDir, { recursive: true });
    const configPath = path.join(sandstormDir, 'config');
    fs.writeFileSync(configPath, `# Sandstorm config for ${path.basename(directory)}\n`);
    return true;
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
}
