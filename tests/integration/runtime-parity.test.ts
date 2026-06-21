import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DockerRuntime } from '../../src/main/runtime/docker';
import { PodmanRuntime } from '../../src/main/runtime/podman';
import { LocalRuntime } from '../../src/main/runtime/local';
import {
  assertInterfaceComplete,
  assertInspectImageUnknown,
  assertListContainersShape,
  assertListContainersLabelFilterEmpty,
  assertExecReturnsStdout,
  assertExecCapturesStderr,
  assertExecNonZeroExit,
  assertExecInputRoundtrip,
} from '../helpers/runtime-conformance-helpers';

describe('Runtime Parity (Integration)', () => {
  let dockerRuntime: DockerRuntime;
  let podmanRuntime: PodmanRuntime;
  let localRuntime: LocalRuntime;
  let dockerAvailable: boolean;
  let podmanAvailable: boolean;
  let localContainerId: string;

  beforeAll(async () => {
    dockerRuntime = new DockerRuntime();
    podmanRuntime = new PodmanRuntime();
    localRuntime = new LocalRuntime();
    dockerAvailable = await dockerRuntime.isAvailable();
    podmanAvailable = await podmanRuntime.isAvailable();

    localContainerId = 'parity-exec-test';
    localRuntime.registerContainer(localContainerId, { name: localContainerId, image: 'local-parity' });
  });

  afterAll(() => {
    localRuntime.destroy();
  });

  it('all runtimes implement the full ContainerRuntime interface', () => {
    assertInterfaceComplete(dockerRuntime);
    assertInterfaceComplete(podmanRuntime);
    assertInterfaceComplete(localRuntime);
  });

  it('all runtimes have a name property', () => {
    expect(dockerRuntime.name).toBe('docker');
    expect(podmanRuntime.name).toBe('podman');
    expect(localRuntime.name).toBe('local');
  });

  it('Docker listContainers returns consistent format', async () => {
    if (!dockerAvailable) return;
    await assertListContainersShape(dockerRuntime);
  });

  it('Podman listContainers returns consistent format', async () => {
    if (!podmanAvailable) return;
    await assertListContainersShape(podmanRuntime);
  });

  it('LocalRuntime listContainers returns consistent format', async () => {
    await assertListContainersShape(localRuntime);
  });

  it('Docker inspectImage returns null for unknown image', async () => {
    if (!dockerAvailable) return;
    await assertInspectImageUnknown(dockerRuntime);
  });

  it('Podman inspectImage returns null for unknown image', async () => {
    if (!podmanAvailable) return;
    await assertInspectImageUnknown(podmanRuntime);
  });

  it('LocalRuntime inspectImage returns null for unknown image', async () => {
    await assertInspectImageUnknown(localRuntime);
  });

  // --- exec behavioral assertions ---

  it('LocalRuntime exec returns stdout', async () => {
    await assertExecReturnsStdout(localRuntime, localContainerId);
  });

  it('LocalRuntime exec captures stderr separately', async () => {
    await assertExecCapturesStderr(localRuntime, localContainerId);
  });

  it('LocalRuntime exec reports non-zero exit codes', async () => {
    await assertExecNonZeroExit(localRuntime, localContainerId);
  });

  it('LocalRuntime exec input roundtrip via stdin', async () => {
    await assertExecInputRoundtrip(localRuntime, localContainerId);
  });

  it('Docker exec returns stdout (skipped when unavailable or no running containers)', async () => {
    if (!dockerAvailable) return;
    const containers = await dockerRuntime.listContainers({ status: 'running' });
    if (containers.length === 0) return;
    await assertExecReturnsStdout(dockerRuntime, containers[0].id);
  });

  it('Podman exec returns stdout (skipped when unavailable or no running containers)', async () => {
    if (!podmanAvailable) return;
    const containers = await podmanRuntime.listContainers({ status: 'running' });
    if (containers.length === 0) return;
    await assertExecReturnsStdout(podmanRuntime, containers[0].id);
  });

  // --- label filter behavioral assertions ---

  it('LocalRuntime listContainers label filter returns empty for non-matching label', async () => {
    await assertListContainersLabelFilterEmpty(localRuntime);
  });

  it('Docker listContainers label filter returns empty for non-matching label', async () => {
    if (!dockerAvailable) return;
    await assertListContainersLabelFilterEmpty(dockerRuntime);
  });

  it('Podman listContainers label filter returns empty for non-matching label', async () => {
    if (!podmanAvailable) return;
    await assertListContainersLabelFilterEmpty(podmanRuntime);
  });
});
