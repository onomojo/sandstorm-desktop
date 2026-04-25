/**
 * Schedule service — CRUD operations for per-project schedules.
 * Stores schedules in `.sandstorm/schedules.json` with atomic writes.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Schedule, ScheduleStore, ScheduleAction } from './types';
import { validateCronExpression } from './cron-validator';

function generateScheduleId(): string {
  // sch_ prefix + 12 random hex chars for uniqueness
  return `sch_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function schedulesPath(projectDir: string): string {
  return path.join(projectDir, '.sandstorm', 'schedules.json');
}

const SCHEDULE_ID_PATTERN = /^sch_[0-9a-f]{12}$/;

function isValidAction(a: unknown): a is ScheduleAction {
  if (!a || typeof a !== 'object') return false;
  const obj = a as Record<string, unknown>;
  if (obj.kind === 'run-script') {
    return typeof obj.scriptName === 'string' && obj.scriptName.trim().length > 0;
  }
  return false;
}

function isValidSchedule(s: unknown): s is Schedule {
  if (!s || typeof s !== 'object') return false;
  const obj = s as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    SCHEDULE_ID_PATTERN.test(obj.id) &&
    typeof obj.cronExpression === 'string' &&
    validateCronExpression(obj.cronExpression) === null &&
    isValidAction(obj.action) &&
    typeof obj.enabled === 'boolean' &&
    typeof obj.createdAt === 'string' &&
    typeof obj.updatedAt === 'string'
  );
}

function readStore(projectDir: string): ScheduleStore {
  const filePath = schedulesPath(projectDir);
  if (!fs.existsSync(filePath)) {
    return { version: 1, schedules: [] };
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse schedules.json: file is corrupted or contains invalid JSON`);
  }
  if (data.version !== 1) {
    throw new Error(`Unsupported schedules.json version: ${data.version}`);
  }
  // Validate + drop malformed entries. Legacy entries with a flat `prompt`
  // field (pre-#250 reshape) are invalid under the new schema and get dropped
  // here with a warning — pre-release, no install base to preserve.
  const rawList = Array.isArray(data.schedules) ? data.schedules : [];
  const schedules: Schedule[] = [];
  for (const s of rawList) {
    if (isValidSchedule(s)) {
      schedules.push(s);
      continue;
    }
    if (s && typeof s === 'object' && 'prompt' in (s as Record<string, unknown>)) {
      console.warn(
        `[scheduler] Dropping legacy schedule with freeform prompt (id=${(s as { id?: string }).id ?? 'unknown'}). ` +
        `Recreate it with an action kind — schedules no longer dispatch to the outer Claude chat.`,
      );
    }
  }
  return { version: 1, schedules };
}

function writeStore(projectDir: string, store: ScheduleStore): void {
  const filePath = schedulesPath(projectDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Atomic write: write to temp file, then rename
  const tmpPath = filePath + `.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

export interface CreateScheduleInput {
  projectDir: string;
  label?: string;
  cronExpression: string;
  action: ScheduleAction;
  enabled?: boolean;
}

export interface UpdateSchedulePatch {
  label?: string;
  cronExpression?: string;
  action?: ScheduleAction;
  enabled?: boolean;
}

export function createSchedule(input: CreateScheduleInput): Schedule {
  const { projectDir, label, cronExpression, action, enabled } = input;

  const cronError = validateCronExpression(cronExpression);
  if (cronError) {
    throw new Error(`Invalid cron expression: ${cronError}`);
  }

  if (!isValidAction(action)) {
    throw new Error('Invalid schedule action: expected { kind: "run-script", scriptName: string }');
  }

  const now = new Date().toISOString();
  const schedule: Schedule = {
    id: generateScheduleId(),
    label: label?.trim() || undefined,
    cronExpression: cronExpression.trim(),
    action,
    enabled: enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };

  const store = readStore(projectDir);
  store.schedules.push(schedule);
  writeStore(projectDir, store);

  return schedule;
}

export function listSchedules(projectDir: string): Schedule[] {
  return readStore(projectDir).schedules;
}

export function getSchedule(projectDir: string, id: string): Schedule | null {
  const store = readStore(projectDir);
  return store.schedules.find((s) => s.id === id) ?? null;
}

export function updateSchedule(
  projectDir: string,
  id: string,
  patch: UpdateSchedulePatch
): Schedule {
  const store = readStore(projectDir);
  const idx = store.schedules.findIndex((s) => s.id === id);
  if (idx === -1) {
    throw new Error(`Schedule not found: ${id}`);
  }

  if (patch.cronExpression !== undefined) {
    const cronError = validateCronExpression(patch.cronExpression);
    if (cronError) {
      throw new Error(`Invalid cron expression: ${cronError}`);
    }
    store.schedules[idx].cronExpression = patch.cronExpression.trim();
  }

  if (patch.label !== undefined) {
    store.schedules[idx].label = patch.label.trim() || undefined;
  }

  if (patch.action !== undefined) {
    if (!isValidAction(patch.action)) {
      throw new Error('Invalid schedule action: expected { kind: "run-script", scriptName: string }');
    }
    store.schedules[idx].action = patch.action;
  }

  if (patch.enabled !== undefined) {
    store.schedules[idx].enabled = patch.enabled;
  }

  store.schedules[idx].updatedAt = new Date().toISOString();
  writeStore(projectDir, store);

  return store.schedules[idx];
}

export function deleteSchedule(projectDir: string, id: string): void {
  const store = readStore(projectDir);
  const idx = store.schedules.findIndex((s) => s.id === id);
  if (idx === -1) {
    throw new Error(`Schedule not found: ${id}`);
  }

  store.schedules.splice(idx, 1);
  writeStore(projectDir, store);
}

/**
 * Get all schedules across multiple project directories.
 * Used by the crontab writer to build the full crontab section.
 */
export function getAllSchedulesForProjects(
  projectDirs: string[]
): Array<{ projectDir: string; schedule: Schedule }> {
  const result: Array<{ projectDir: string; schedule: Schedule }> = [];
  for (const projectDir of projectDirs) {
    try {
      const schedules = listSchedules(projectDir);
      for (const schedule of schedules) {
        result.push({ projectDir, schedule });
      }
    } catch {
      // Skip projects with invalid schedule files
    }
  }
  return result;
}
