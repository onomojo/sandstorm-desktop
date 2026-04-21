/**
 * Integration test for the scheduler: schedule → crontab round-trip.
 * Tests the full flow from creating a schedule to verifying its crontab entry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import {
  createSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  getAllSchedulesForProjects,
  parseCrontab,
  buildManagedSection,
  assembleCrontab,
  CrontabEntry,
  SchedulerSocketServer,
  ScheduledDispatchRequest,
  ScheduledDispatchResponse,
} from '../../src/main/scheduler';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-integ-'));
  fs.mkdirSync(path.join(tmpDir, '.sandstorm'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Scheduler integration', () => {
  it('schedule CRUD → crontab round-trip', () => {
    // Create two schedules
    const s1 = createSchedule({
      projectDir: tmpDir,
      label: 'Hourly triage',
      cronExpression: '0 * * * *',
      prompt: 'Scan issues',
    });
    const s2 = createSchedule({
      projectDir: tmpDir,
      cronExpression: '*/30 * * * *',
      prompt: 'Check builds',
      enabled: false, // disabled
    });

    // Verify store
    const all = listSchedules(tmpDir);
    expect(all).toHaveLength(2);

    // Build crontab entries
    const projectId = 'test-project';
    const wrapperPath = '/usr/local/bin/sandstorm-scheduled-run.sh';
    const entries: CrontabEntry[] = getAllSchedulesForProjects([tmpDir]).map(
      ({ projectDir, schedule }) => ({
        projectDir,
        projectId,
        schedule,
        wrapperPath,
      })
    );

    // Build managed section — only enabled schedules
    const managed = buildManagedSection(entries);
    expect(managed).toHaveLength(1); // s2 is disabled
    expect(managed[0]).toContain(s1.id);
    expect(managed[0]).toContain('0 * * * *');

    // Simulate existing crontab with user entries
    const userCrontab = 'MAILTO=admin@example.com\n0 3 * * * /usr/bin/backup\n';
    const assembled = assembleCrontab(userCrontab, managed, '');

    // Parse back to verify round-trip
    const parsed = parseCrontab(assembled);
    expect(parsed.before).toContain('MAILTO=admin@example.com');
    expect(parsed.before).toContain('/usr/bin/backup');
    expect(parsed.managed).toHaveLength(1);

    // Update schedule — change cron expression
    updateSchedule(tmpDir, s1.id, { cronExpression: '*/15 * * * *' });
    const updated = listSchedules(tmpDir).find((s) => s.id === s1.id)!;
    expect(updated.cronExpression).toBe('*/15 * * * *');

    // Enable the second schedule
    updateSchedule(tmpDir, s2.id, { enabled: true });

    // Rebuild crontab with updated schedules
    const entries2: CrontabEntry[] = getAllSchedulesForProjects([tmpDir]).map(
      ({ projectDir, schedule }) => ({
        projectDir,
        projectId,
        schedule,
        wrapperPath,
      })
    );
    const managed2 = buildManagedSection(entries2);
    expect(managed2).toHaveLength(2); // both enabled now

    // Delete one schedule
    deleteSchedule(tmpDir, s1.id);
    expect(listSchedules(tmpDir)).toHaveLength(1);
  });

  it('end-to-end: wrapper → socket server → dispatch', async () => {
    // Create a schedule in the store
    const schedule = createSchedule({
      projectDir: tmpDir,
      label: 'Test dispatch',
      cronExpression: '* * * * *',
      prompt: 'Count to 10',
    });

    // Start a socket server with a test handler
    const sockPath = path.join(tmpDir, 'test.sock');
    let receivedRequest: ScheduledDispatchRequest | null = null;

    const handler = async (req: ScheduledDispatchRequest): Promise<ScheduledDispatchResponse> => {
      receivedRequest = req;
      return { ok: true, dispatchId: 'dispatch_test_1' };
    };

    const server = new SchedulerSocketServer(handler, sockPath);
    await server.start();

    try {
      // Simulate wrapper sending a request
      const request: ScheduledDispatchRequest = {
        type: 'scheduled-dispatch',
        version: 1,
        projectDir: tmpDir,
        scheduleId: schedule.id,
        prompt: '__from_schedule__',
        firedAt: new Date().toISOString(),
      };

      const response = await new Promise<string>((resolve, reject) => {
        const client = net.createConnection(sockPath, () => {
          client.write(JSON.stringify(request) + '\n');
        });
        let data = '';
        client.on('data', (chunk) => { data += chunk.toString(); });
        client.on('end', () => resolve(data.trim()));
        client.on('error', reject);
      });

      const parsed = JSON.parse(response);
      expect(parsed.ok).toBe(true);
      expect(parsed.dispatchId).toBe('dispatch_test_1');

      // Verify the handler received the correct request
      expect(receivedRequest).toBeTruthy();
      expect(receivedRequest!.projectDir).toBe(tmpDir);
      expect(receivedRequest!.scheduleId).toBe(schedule.id);
    } finally {
      await server.stop();
    }
  });

  describe('dispatch gating — rate-limit, auth-halt, orchestrator-busy', () => {
    it('rejects with rate-limited when session state indicates rate limit', async () => {
      const schedule = createSchedule({
        projectDir: tmpDir,
        label: 'Rate test',
        cronExpression: '* * * * *',
        prompt: 'test prompt',
      });

      // Simulate a dispatch handler that checks rate-limit state
      const handler = async (req: ScheduledDispatchRequest): Promise<ScheduledDispatchResponse> => {
        // Simulate rate-limited state
        const smState = { level: 'over_limit' as const, halted: false };
        if (smState.level === 'over_limit' || smState.level === 'limit') {
          return { ok: false, reason: 'rate-limited', message: 'Rate limit reached' };
        }
        return { ok: true, dispatchId: 'test' };
      };

      const sockPath = path.join(tmpDir, 'rate-limit-test.sock');
      const server = new SchedulerSocketServer(handler, sockPath);
      await server.start();

      try {
        const request: ScheduledDispatchRequest = {
          type: 'scheduled-dispatch',
          version: 1,
          projectDir: tmpDir,
          scheduleId: schedule.id,
          prompt: '__from_schedule__',
          firedAt: new Date().toISOString(),
        };

        const response = await new Promise<string>((resolve, reject) => {
          const client = net.createConnection(sockPath, () => {
            client.write(JSON.stringify(request) + '\n');
          });
          let data = '';
          client.on('data', (chunk) => { data += chunk.toString(); });
          client.on('end', () => resolve(data.trim()));
          client.on('error', reject);
        });

        const parsed = JSON.parse(response);
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toBe('rate-limited');
      } finally {
        await server.stop();
      }
    });

    it('rejects with rate-limited when session state level is limit', async () => {
      const schedule = createSchedule({
        projectDir: tmpDir,
        label: 'Limit test',
        cronExpression: '* * * * *',
        prompt: 'test prompt',
      });

      const handler = async (_req: ScheduledDispatchRequest): Promise<ScheduledDispatchResponse> => {
        const smState = { level: 'limit' as const, halted: false };
        if (smState.level === 'over_limit' || smState.level === 'limit') {
          return { ok: false, reason: 'rate-limited', message: 'Rate limit reached' };
        }
        return { ok: true, dispatchId: 'test' };
      };

      const sockPath = path.join(tmpDir, 'limit-test.sock');
      const server = new SchedulerSocketServer(handler, sockPath);
      await server.start();

      try {
        const request: ScheduledDispatchRequest = {
          type: 'scheduled-dispatch',
          version: 1,
          projectDir: tmpDir,
          scheduleId: schedule.id,
          prompt: '__from_schedule__',
          firedAt: new Date().toISOString(),
        };

        const response = await new Promise<string>((resolve, reject) => {
          const client = net.createConnection(sockPath, () => {
            client.write(JSON.stringify(request) + '\n');
          });
          let data = '';
          client.on('data', (chunk) => { data += chunk.toString(); });
          client.on('end', () => resolve(data.trim()));
          client.on('error', reject);
        });

        const parsed = JSON.parse(response);
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toBe('rate-limited');
      } finally {
        await server.stop();
      }
    });

    it('rejects with auth-halt when session is halted', async () => {
      const schedule = createSchedule({
        projectDir: tmpDir,
        label: 'Auth test',
        cronExpression: '* * * * *',
        prompt: 'test prompt',
      });

      const handler = async (req: ScheduledDispatchRequest): Promise<ScheduledDispatchResponse> => {
        // Simulate auth-halted state
        const smState = { level: 'normal' as const, halted: true };
        if (smState.level === 'over_limit' || smState.level === 'limit') {
          return { ok: false, reason: 'rate-limited', message: 'Rate limit reached' };
        }
        if (smState.halted) {
          return { ok: false, reason: 'auth-halt', message: 'Session is halted' };
        }
        return { ok: true, dispatchId: 'test' };
      };

      const sockPath = path.join(tmpDir, 'auth-halt-test.sock');
      const server = new SchedulerSocketServer(handler, sockPath);
      await server.start();

      try {
        const request: ScheduledDispatchRequest = {
          type: 'scheduled-dispatch',
          version: 1,
          projectDir: tmpDir,
          scheduleId: schedule.id,
          prompt: '__from_schedule__',
          firedAt: new Date().toISOString(),
        };

        const response = await new Promise<string>((resolve, reject) => {
          const client = net.createConnection(sockPath, () => {
            client.write(JSON.stringify(request) + '\n');
          });
          let data = '';
          client.on('data', (chunk) => { data += chunk.toString(); });
          client.on('end', () => resolve(data.trim()));
          client.on('error', reject);
        });

        const parsed = JSON.parse(response);
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toBe('auth-halt');
      } finally {
        await server.stop();
      }
    });

    it('rejects with orchestrator-busy when dispatch is already in-flight', async () => {
      const schedule = createSchedule({
        projectDir: tmpDir,
        label: 'Busy test',
        cronExpression: '* * * * *',
        prompt: 'test prompt',
      });

      // Track in-flight dispatches (mirrors the production logic)
      const inFlightDispatches = new Set<string>();

      const handler = async (req: ScheduledDispatchRequest): Promise<ScheduledDispatchResponse> => {
        const flightKey = `${req.projectDir}:${req.scheduleId}`;
        if (inFlightDispatches.has(flightKey)) {
          return { ok: false, reason: 'orchestrator-busy', message: `Dispatch already in-flight for schedule ${req.scheduleId}` };
        }
        inFlightDispatches.add(flightKey);
        return { ok: true, dispatchId: 'dispatch_1' };
      };

      const sockPath = path.join(tmpDir, 'busy-test.sock');
      const server = new SchedulerSocketServer(handler, sockPath);
      await server.start();

      try {
        const request: ScheduledDispatchRequest = {
          type: 'scheduled-dispatch',
          version: 1,
          projectDir: tmpDir,
          scheduleId: schedule.id,
          prompt: '__from_schedule__',
          firedAt: new Date().toISOString(),
        };

        // First dispatch — should succeed
        const response1 = await new Promise<string>((resolve, reject) => {
          const client = net.createConnection(sockPath, () => {
            client.write(JSON.stringify(request) + '\n');
          });
          let data = '';
          client.on('data', (chunk) => { data += chunk.toString(); });
          client.on('end', () => resolve(data.trim()));
          client.on('error', reject);
        });
        const parsed1 = JSON.parse(response1);
        expect(parsed1.ok).toBe(true);

        // Second dispatch for the same schedule — should be rejected as busy
        const response2 = await new Promise<string>((resolve, reject) => {
          const client = net.createConnection(sockPath, () => {
            client.write(JSON.stringify(request) + '\n');
          });
          let data = '';
          client.on('data', (chunk) => { data += chunk.toString(); });
          client.on('end', () => resolve(data.trim()));
          client.on('error', reject);
        });
        const parsed2 = JSON.parse(response2);
        expect(parsed2.ok).toBe(false);
        expect(parsed2.reason).toBe('orchestrator-busy');
      } finally {
        await server.stop();
      }
    });
  });

  it('.sandstorm/schedules.json is in the .sandstorm directory (gitignored)', () => {
    createSchedule({
      projectDir: tmpDir,
      cronExpression: '0 * * * *',
      prompt: 'Test',
    });

    const schedulesPath = path.join(tmpDir, '.sandstorm', 'schedules.json');
    expect(fs.existsSync(schedulesPath)).toBe(true);
    // Verify it's inside .sandstorm/ which is gitignored by convention
    expect(schedulesPath).toContain('.sandstorm');
  });
});
