import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalRuntime } from '../../../src/main/runtime/local';
import {
  assertExecReturnsStdout,
  assertExecCapturesStderr,
  assertExecNonZeroExit,
  assertExecInputRoundtrip,
  assertInspectImageUnknown,
} from '../../helpers/runtime-conformance-helpers';

describe('LocalRuntime — conformance', () => {
  let runtime: LocalRuntime;
  const CONTAINER_ID = 'test-container';

  beforeEach(() => {
    runtime = new LocalRuntime();
    runtime.registerContainer(CONTAINER_ID, { name: 'test-container', image: 'test-image' });
  });

  afterEach(() => {
    runtime.destroy();
  });

  it('has name "local"', () => {
    expect(runtime.name).toBe('local');
  });

  it('isAvailable always returns true', async () => {
    expect(await runtime.isAvailable()).toBe(true);
  });

  it('version returns "local"', async () => {
    expect(await runtime.version()).toBe('local');
  });

  it('exec runs a command and returns stdout', async () => {
    await assertExecReturnsStdout(runtime, CONTAINER_ID);
  });

  it('exec captures non-zero exit codes', async () => {
    await assertExecNonZeroExit(runtime, CONTAINER_ID);
  });

  it('exec captures stderr separately', async () => {
    await assertExecCapturesStderr(runtime, CONTAINER_ID);
  });

  it('exec pipes opts.input to stdin', async () => {
    await assertExecInputRoundtrip(runtime, CONTAINER_ID);
  });

  it('exec without input does not pipe stdin', async () => {
    const result = await runtime.exec(CONTAINER_ID, ['echo', 'no-stdin']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('no-stdin');
  });

  it('exec honors opts.workdir', async () => {
    const result = await runtime.exec(CONTAINER_ID, ['pwd'], { workdir: '/tmp' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('/tmp');
  });

  it('exec honors opts.env', async () => {
    const result = await runtime.exec(CONTAINER_ID, ['sh', '-c', 'echo $MY_VAR'], {
      env: ['MY_VAR=sandstorm-test'],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('sandstorm-test');
  });

  it('listContainers returns registered containers', async () => {
    const containers = await runtime.listContainers();
    expect(containers).toHaveLength(1);
    expect(containers[0].id).toBe(CONTAINER_ID);
    expect(containers[0].name).toBe('test-container');
    expect(containers[0].status).toBe('running');
  });

  it('listContainers filters by name', async () => {
    runtime.registerContainer('other-id', { name: 'other-name', image: 'img' });
    const results = await runtime.listContainers({ name: 'test' });
    expect(results.every((c) => c.name.includes('test'))).toBe(true);
  });

  it('inspect returns container info', async () => {
    const info = await runtime.inspect(CONTAINER_ID);
    expect(info.id).toBe(CONTAINER_ID);
    expect(info.state.running).toBe(true);
    expect(info.state.status).toBe('running');
  });

  it('inspect throws for unknown container', async () => {
    await expect(runtime.inspect('nonexistent')).rejects.toThrow();
  });

  it('containerStats returns zeros', async () => {
    const stats = await runtime.containerStats(CONTAINER_ID);
    expect(stats.memoryUsage).toBe(0);
    expect(stats.memoryLimit).toBe(0);
    expect(stats.cpuPercent).toBe(0);
  });

  it('logs yields nothing', async () => {
    const chunks: string[] = [];
    for await (const chunk of runtime.logs(CONTAINER_ID)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(0);
  });

  it('inspectImage returns null for unregistered image', async () => {
    await assertInspectImageUnknown(runtime);
  });

  it('inspectImage returns labels for registered image', async () => {
    runtime.registerImage('my-image:latest', { 'sandstorm.app-version': '1.2.3' });
    const result = await runtime.inspectImage('my-image:latest');
    expect(result).not.toBeNull();
    expect(result!.labels['sandstorm.app-version']).toBe('1.2.3');
  });

  it('inspectImage returns empty labels when image registered with no labels', async () => {
    runtime.registerImage('bare-image', {});
    const result = await runtime.inspectImage('bare-image');
    expect(result).not.toBeNull();
    expect(result!.labels).toEqual({});
  });

  it('exec rejects or returns non-zero for nonexistent container id', async () => {
    const result = await runtime.exec('no-such-id', ['echo', 'x']);
    expect(result.exitCode).not.toBe(0);
  });

  it('two registered containers use isolated tmpdirs', async () => {
    const CONTAINER_B = 'test-container-b';
    runtime.registerContainer(CONTAINER_B, { name: 'test-container-b', image: 'test-image' });

    const resultA = await runtime.exec(CONTAINER_ID, ['pwd']);
    const resultB = await runtime.exec(CONTAINER_B, ['pwd']);

    expect(resultA.exitCode).toBe(0);
    expect(resultB.exitCode).toBe(0);
    expect(resultA.stdout.trim()).not.toBe(resultB.stdout.trim());
  });

  it('composeUp registers a container visible via listContainers', async () => {
    await runtime.composeUp('/tmp', { projectName: 'my-project', composeFiles: [] });
    const containers = await runtime.listContainers({ name: 'my-project' });
    expect(containers).toHaveLength(1);
    expect(containers[0].name).toBe('my-project');
    expect(containers[0].status).toBe('running');
  });

  it('composeDown removes the container registered by composeUp', async () => {
    await runtime.composeUp('/tmp', { projectName: 'rm-project', composeFiles: [] });
    const before = await runtime.listContainers({ name: 'rm-project' });
    expect(before).toHaveLength(1);
    await runtime.composeDown('/tmp', { projectName: 'rm-project', composeFiles: [] });
    const after = await runtime.listContainers({ name: 'rm-project' });
    expect(after).toHaveLength(0);
  });

  it('listContainers filters by label key=value', async () => {
    runtime.registerContainer('labeled-a', { name: 'container-a', image: 'img', labels: { env: 'prod' } });
    runtime.registerContainer('labeled-b', { name: 'container-b', image: 'img', labels: { env: 'staging' } });
    const results = await runtime.listContainers({ label: 'env=prod' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('labeled-a');
  });

  it('destroy cleans up owned tmpdirs', () => {
    const fs = require('fs');
    const newRuntime = new LocalRuntime();
    const tmpdir = newRuntime.registerContainer('c1', { name: 'c1', image: 'img' });
    expect(fs.existsSync(tmpdir)).toBe(true);
    newRuntime.destroy();
    expect(fs.existsSync(tmpdir)).toBe(false);
  });
});
