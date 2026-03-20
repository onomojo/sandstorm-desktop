import { ipcMain } from 'electron';
import {
  registry,
  stackManager,
  dockerRuntime,
  podmanRuntime,
} from './index';
import { CreateStackOpts } from './control-plane/stack-manager';

export function registerIpcHandlers(): void {
  // --- Stacks ---

  ipcMain.handle('stacks:list', async () => {
    return stackManager.listStacksWithServices();
  });

  ipcMain.handle('stacks:get', async (_event, stackId: string) => {
    return stackManager.getStackWithServices(stackId);
  });

  ipcMain.handle('stacks:create', async (_event, opts: CreateStackOpts) => {
    return stackManager.createStack(opts);
  });

  ipcMain.handle('stacks:teardown', async (_event, stackId: string) => {
    await stackManager.teardownStack(stackId);
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

  // --- Runtime ---

  ipcMain.handle('runtime:available', async () => {
    const [dockerAvail, podmanAvail] = await Promise.all([
      dockerRuntime.isAvailable(),
      podmanRuntime.isAvailable(),
    ]);
    return { docker: dockerAvail, podman: podmanAvail };
  });
}
