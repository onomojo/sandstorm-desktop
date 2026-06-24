import { ipcMain } from 'electron';
import { INVOKE_CHANNELS } from '../ipc-channels';
import { getEpicRunner } from '../control-plane/epic-runner';

export function registerEpicHandlers(): void {
  ipcMain.handle(
    INVOKE_CHANNELS.EPIC_START,
    async (_event, epicId: string, projectDir: string) => {
      return getEpicRunner().startEpic(epicId, projectDir);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.EPIC_GET_RUN_PLAN,
    async (_event, epicId: string, projectDir: string) => {
      return getEpicRunner().getRunPlan(epicId, projectDir);
    },
  );
}
