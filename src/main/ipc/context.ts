import { ipcMain } from 'electron';
import { INVOKE_CHANNELS } from '../ipc-channels';
import {
  getCustomContext,
  saveCustomInstructions,
  listCustomSkills,
  getCustomSkill,
  saveCustomSkill,
  deleteCustomSkill,
  getCustomSettings,
  saveCustomSettings,
} from '../custom-context';
import { getDefaultReviewPrompt } from '../review-prompt';

export function registerContextHandlers(): void {
  ipcMain.handle(INVOKE_CHANNELS.CONTEXT_GET, async (_event, projectDir: string) => {
    return getCustomContext(projectDir);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.CONTEXT_SAVE_INSTRUCTIONS,
    async (_event, projectDir: string, content: string) => {
      saveCustomInstructions(projectDir, content);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.CONTEXT_LIST_SKILLS, async (_event, projectDir: string) => {
    return listCustomSkills(projectDir);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.CONTEXT_GET_SKILL,
    async (_event, projectDir: string, name: string) => {
      return getCustomSkill(projectDir, name);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.CONTEXT_SAVE_SKILL,
    async (_event, projectDir: string, name: string, content: string) => {
      saveCustomSkill(projectDir, name, content);
    },
  );

  ipcMain.handle(
    INVOKE_CHANNELS.CONTEXT_DELETE_SKILL,
    async (_event, projectDir: string, name: string) => {
      deleteCustomSkill(projectDir, name);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.CONTEXT_GET_SETTINGS, async (_event, projectDir: string) => {
    return getCustomSettings(projectDir);
  });

  ipcMain.handle(
    INVOKE_CHANNELS.CONTEXT_SAVE_SETTINGS,
    async (_event, projectDir: string, content: string) => {
      saveCustomSettings(projectDir, content);
    },
  );

  ipcMain.handle(INVOKE_CHANNELS.REVIEW_PROMPT_GET_DEFAULT, async () => {
    return getDefaultReviewPrompt();
  });
}
