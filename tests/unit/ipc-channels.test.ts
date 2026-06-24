import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  INVOKE_CHANNELS,
  EVENT_CHANNELS,
  AGENT_OUTPUT,
  AGENT_DONE,
  AGENT_ERROR,
  AGENT_QUEUED,
  AGENT_TOKEN_USAGE_EVENT,
  AGENT_USER_MESSAGE,
} from '@main/ipc-channels';

describe('ipc-channels registry', () => {
  it('INVOKE_CHANNELS values are all non-empty strings', () => {
    for (const [key, value] of Object.entries(INVOKE_CHANNELS)) {
      expect(typeof value, `INVOKE_CHANNELS.${key}`).toBe('string');
      expect(value.length, `INVOKE_CHANNELS.${key} is empty`).toBeGreaterThan(0);
    }
  });

  it('EVENT_CHANNELS values are all non-empty strings', () => {
    for (const [key, value] of Object.entries(EVENT_CHANNELS)) {
      expect(typeof value, `EVENT_CHANNELS.${key}`).toBe('string');
      expect(value.length, `EVENT_CHANNELS.${key} is empty`).toBeGreaterThan(0);
    }
  });

  it('INVOKE_CHANNELS has no duplicate values', () => {
    const values = Object.values(INVOKE_CHANNELS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it('EVENT_CHANNELS has no duplicate values', () => {
    const values = Object.values(EVENT_CHANNELS);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  it('INVOKE_CHANNELS and EVENT_CHANNELS have no overlapping values', () => {
    const invokeValues = new Set(Object.values(INVOKE_CHANNELS));
    for (const val of Object.values(EVENT_CHANNELS)) {
      expect(invokeValues.has(val), `'${val}' appears in both INVOKE_CHANNELS and EVENT_CHANNELS`).toBe(false);
    }
  });

  it('agent event builders return correct template literal strings', () => {
    expect(AGENT_OUTPUT('tab-1')).toBe('agent:output:tab-1');
    expect(AGENT_DONE('tab-1')).toBe('agent:done:tab-1');
    expect(AGENT_ERROR('tab-1')).toBe('agent:error:tab-1');
    expect(AGENT_QUEUED('tab-1')).toBe('agent:queued:tab-1');
    expect(AGENT_TOKEN_USAGE_EVENT('tab-1')).toBe('agent:token-usage:tab-1');
    expect(AGENT_USER_MESSAGE('tab-1')).toBe('agent:user-message:tab-1');
  });

  it('all known channels are present in the registry', () => {
    // Spot-check a representative sample from each namespace
    expect(INVOKE_CHANNELS.AGENT_SEND).toBe('agent:send');
    expect(INVOKE_CHANNELS.PROJECTS_LIST).toBe('projects:list');
    expect(INVOKE_CHANNELS.STACKS_CREATE).toBe('stacks:create');
    expect(INVOKE_CHANNELS.TASKS_DISPATCH).toBe('tasks:dispatch');
    expect(INVOKE_CHANNELS.TICKETS_LIST).toBe('tickets:list');
    expect(INVOKE_CHANNELS.PR_CREATE).toBe('pr:create');
    expect(INVOKE_CHANNELS.EPIC_START).toBe('epic:start');
    expect(INVOKE_CHANNELS.SCHEDULES_LIST).toBe('schedules:list');
    expect(INVOKE_CHANNELS.SESSION_ACTIVITY).toBe('session:activity');
    expect(INVOKE_CHANNELS.DARK_FACTORY_GET_ENABLED).toBe('darkFactory:getEnabled');

    expect(EVENT_CHANNELS.STACKS_UPDATED).toBe('stacks:updated');
    expect(EVENT_CHANNELS.TASK_COMPLETED).toBe('task:completed');
    expect(EVENT_CHANNELS.TASK_FAILED).toBe('task:failed');
    expect(EVENT_CHANNELS.DOCKER_CONNECTED).toBe('docker:connected');
    expect(EVENT_CHANNELS.SESSION_THRESHOLD).toBe('session:threshold');
    expect(EVENT_CHANNELS.NAVIGATE_STACK).toBe('navigate:stack');
    expect(EVENT_CHANNELS.AUTH_COMPLETED).toBe('auth:completed');
  });

  it('no raw channel string literals remain in IPC handler and emitter files', () => {
    const root = path.resolve(__dirname, '../..');
    const allChannels = [
      ...Object.values(INVOKE_CHANNELS),
      ...Object.values(EVENT_CHANNELS),
    ];

    const ipcDomainFiles = fs.existsSync(path.join(root, 'src/main/ipc'))
      ? fs.readdirSync(path.join(root, 'src/main/ipc'))
          .filter((f) => f.endsWith('.ts'))
          .map((f) => path.join(root, 'src/main/ipc', f))
      : [];

    const filesToCheck = [
      path.join(root, 'src/main/ipc.ts'),
      path.join(root, 'src/preload/index.ts'),
      path.join(root, 'src/main/index.ts'),
      path.join(root, 'src/main/tray.ts'),
      path.join(root, 'src/main/agent/claude-backend.ts'),
      path.join(root, 'src/main/agent/opencode-backend.ts'),
      ...ipcDomainFiles,
    ];

    for (const file of filesToCheck) {
      const content = fs.readFileSync(file, 'utf-8');
      const basename = path.basename(file);
      for (const channel of allChannels) {
        // Escape regex special chars in the channel string
        const escaped = channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Match the channel as a quoted string literal only
        const pattern = new RegExp(`['"]${escaped}['"]`);
        expect(
          pattern.test(content),
          `${basename} still contains raw literal '${channel}'`
        ).toBe(false);
      }
    }
  });

  it('no raw agent template-literal channels remain in renderer and backend files', () => {
    const root = path.resolve(__dirname, '../..');
    const filesToCheck = [
      path.join(root, 'src/renderer/agentStreamService.ts'),
      path.join(root, 'src/main/agent/claude-backend.ts'),
      path.join(root, 'src/main/agent/opencode-backend.ts'),
    ];
    const agentTemplateLiterals = [
      'agent:output:${tabId}',
      'agent:done:${tabId}',
      'agent:error:${tabId}',
      'agent:queued:${tabId}',
      'agent:token-usage:${tabId}',
      'agent:user-message:${tabId}',
    ];

    for (const file of filesToCheck) {
      const content = fs.readFileSync(file, 'utf-8');
      const basename = path.basename(file);
      for (const literal of agentTemplateLiterals) {
        // Escape for regex: ${tabId} → \$\{tabId\}
        const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`\`${escaped}\``);
        expect(
          pattern.test(content),
          `${basename} still contains raw template literal \`${literal}\``
        ).toBe(false);
      }
    }
  });
});
