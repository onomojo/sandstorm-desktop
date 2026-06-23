import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DockerRuntime } from '../../src/main/runtime/docker';
import { skipIfInStackOrNoDocker } from '../helpers/docker-smoke-helpers';

// Unique project name prevents collisions in concurrent CI runs.
// Combine pid + a random suffix since multiple runners may share a host.
const PROJECT_NAME = `sandstorm-smoke-${process.pid}-${Math.floor(Math.random() * 100_000)}`;

// Label docker-compose stamps on every container in the project.
const PROJECT_LABEL = `com.docker.compose.project=${PROJECT_NAME}`;

describe('Real Docker Smoke (host/CI only)', () => {
  let runtime: DockerRuntime;
  let tmpDir: string;
  let shouldSkip: boolean;

  beforeAll(async () => {
    runtime = new DockerRuntime();
    shouldSkip = await skipIfInStackOrNoDocker(runtime);
    if (shouldSkip) return;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-smoke-'));

    // Minimal compose fixture: alpine keeps running for the duration of the test.
    // alpine:3.19 is small (~7 MB) and always available on Docker Hub.
    const compose = [
      'services:',
      '  smoke:',
      '    image: alpine:3.19',
      '    command: ["sleep", "300"]',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), compose);
  });

  afterAll(async () => {
    if (shouldSkip || !tmpDir) return;

    // Always attempt teardown so a failed assertion never leaks containers.
    try {
      await runtime.composeDown(tmpDir, {
        projectName: PROJECT_NAME,
        composeFiles: ['docker-compose.yml'],
      });
    } catch {
      // Best-effort — container may already be gone if test was interrupted.
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips cleanly when SANDSTORM_STACK_ID is set or Docker is unavailable', () => {
    if (!shouldSkip) return;
    // We are inside a stack or have no Docker — all subsequent tests will
    // short-circuit via the same flag. No containers should be started.
    expect(shouldSkip).toBe(true);
  });

  it('composeUp starts the smoke container', async () => {
    if (shouldSkip) return;

    await expect(
      runtime.composeUp(tmpDir, {
        projectName: PROJECT_NAME,
        composeFiles: ['docker-compose.yml'],
      })
    ).resolves.toBeUndefined();
  });

  it('listContainers shows the smoke container with correct image', async () => {
    if (shouldSkip) return;

    const containers = await runtime.listContainers({ label: PROJECT_LABEL });
    expect(containers.length).toBeGreaterThan(0);

    const smoke = containers.find((c) => c.image.includes('alpine'));
    expect(smoke).toBeDefined();
    expect(smoke!.status).toBe('running');
  });

  it('exec returns expected stdout and exit code 0', async () => {
    if (shouldSkip) return;

    const running = await runtime.listContainers({
      label: PROJECT_LABEL,
      status: 'running',
    });
    expect(running.length).toBeGreaterThan(0);

    const result = await runtime.exec(running[0].id, ['echo', 'hello-smoke']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello-smoke');
  });

  it('composeDown removes running containers', async () => {
    if (shouldSkip) return;

    await expect(
      runtime.composeDown(tmpDir, {
        projectName: PROJECT_NAME,
        composeFiles: ['docker-compose.yml'],
      })
    ).resolves.toBeUndefined();

    const remaining = await runtime.listContainers({ label: PROJECT_LABEL });
    const stillRunning = remaining.filter((c) => c.status === 'running');
    expect(stillRunning.length).toBe(0);
  });
});
