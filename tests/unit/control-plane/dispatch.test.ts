import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { LocalRuntime } from '../../../src/main/runtime/local';
import { bringUp, deliverTask } from '../../../src/main/control-plane/dispatch';

const PROJECT_DIR = '/tmp/sandstorm-dispatch-test';

describe('bringUp', () => {
  let runtime: LocalRuntime;

  afterEach(() => runtime?.destroy());

  it('registers a container and starts the local loop', async () => {
    runtime = new LocalRuntime();
    await bringUp(runtime, PROJECT_DIR, {
      projectName: 'sandstorm-test-42',
      composeFiles: [],
    });
    const containerId = runtime.getProjectContainerId('sandstorm-test-42');
    expect(containerId).toBeDefined();
    const tmpdir = runtime.getContainerTmpdir(containerId!);
    expect(tmpdir).toBeDefined();
    expect(fs.existsSync(path.join(tmpdir!, 'claude-ready'))).toBe(true);
  });

  it('passes env and build options through to runtime.composeUp', async () => {
    runtime = new LocalRuntime();
    // LocalRuntime ignores env/build but must not throw
    await expect(
      bringUp(runtime, PROJECT_DIR, {
        projectName: 'sandstorm-test-env',
        composeFiles: [],
        env: { SANDSTORM_APP_VERSION: '1.2.3' },
        build: true,
      })
    ).resolves.toBeUndefined();
    const containerId = runtime.getProjectContainerId('sandstorm-test-env');
    expect(containerId).toBeDefined();
  });

  it('makes the container available via getProjectContainerId', async () => {
    runtime = new LocalRuntime();
    await bringUp(runtime, PROJECT_DIR, {
      projectName: 'sandstorm-lookup-test',
      composeFiles: [],
    });
    const id = runtime.getProjectContainerId('sandstorm-lookup-test');
    const containers = await runtime.listContainers({ name: 'sandstorm-lookup-test' });
    expect(containers.length).toBeGreaterThan(0);
    expect(containers[0].id).toBe(id);
  });
});

describe('deliverTask', () => {
  let runtime: LocalRuntime;
  let containerId: string;
  let tmpdir: string;

  beforeEach(async () => {
    runtime = new LocalRuntime();
    await bringUp(runtime, PROJECT_DIR, {
      projectName: 'sandstorm-deliver-test',
      composeFiles: [],
    });
    containerId = runtime.getProjectContainerId('sandstorm-deliver-test')!;
    tmpdir = runtime.getContainerTmpdir(containerId)!;
  });

  afterEach(() => runtime?.destroy());

  it('writes prompt to claude-task-prompt.txt', async () => {
    await deliverTask(runtime, containerId, { prompt: 'Hello world' });
    expect(fs.readFileSync(path.join(tmpdir, 'claude-task-prompt.txt'), 'utf-8')).toBe('Hello world');
  });

  it('writes label as first line of prompt, max 80 chars', async () => {
    await deliverTask(runtime, containerId, { prompt: 'First line\nSecond line' });
    expect(fs.readFileSync(path.join(tmpdir, 'claude-task-label.txt'), 'utf-8')).toBe('First line');
  });

  it('truncates label to 80 chars', async () => {
    const longLine = 'A'.repeat(120);
    await deliverTask(runtime, containerId, { prompt: longLine });
    const label = fs.readFileSync(path.join(tmpdir, 'claude-task-label.txt'), 'utf-8');
    expect(label).toHaveLength(80);
    expect(label).toBe('A'.repeat(80));
  });

  it('writes trigger file last', async () => {
    await deliverTask(runtime, containerId, { prompt: 'test' });
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-trigger'))).toBe(true);
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-prompt.txt'))).toBe(true);
  });

  it('writes optional model file when provided', async () => {
    await deliverTask(runtime, containerId, { prompt: 'test', model: 'claude-opus-4-8' });
    expect(fs.readFileSync(path.join(tmpdir, 'claude-task-model.txt'), 'utf-8')).toBe('claude-opus-4-8');
  });

  it('omits claude-task-model.txt when model is absent', async () => {
    await deliverTask(runtime, containerId, { prompt: 'test' });
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-model.txt'))).toBe(false);
  });

  it('writes modelsJson to claude-task-models.json', async () => {
    const modelsJson = JSON.stringify({ execution: 'auto', review: 'auto', meta_review: 'auto' });
    await deliverTask(runtime, containerId, { prompt: 'test', modelsJson });
    expect(fs.readFileSync(path.join(tmpdir, 'claude-task-models.json'), 'utf-8')).toBe(modelsJson);
  });

  it('omits claude-task-models.json when modelsJson is absent', async () => {
    await deliverTask(runtime, containerId, { prompt: 'test' });
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-models.json'))).toBe(false);
  });

  it('writes resume to claude-task-resume.txt', async () => {
    await deliverTask(runtime, containerId, { prompt: 'test', resume: 'session-abc-123' });
    expect(fs.readFileSync(path.join(tmpdir, 'claude-task-resume.txt'), 'utf-8')).toBe('session-abc-123');
  });

  it('omits claude-task-resume.txt when resume is absent', async () => {
    await deliverTask(runtime, containerId, { prompt: 'test' });
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-resume.txt'))).toBe(false);
  });

  it('writes backend to claude-task-backend.txt', async () => {
    await deliverTask(runtime, containerId, { prompt: 'test', backend: 'opencode' });
    expect(fs.readFileSync(path.join(tmpdir, 'claude-task-backend.txt'), 'utf-8')).toBe('opencode');
  });

  it('writes backendModel to claude-task-backend-model.txt', async () => {
    await deliverTask(runtime, containerId, { prompt: 'test', backendModel: 'gpt-4o' });
    expect(fs.readFileSync(path.join(tmpdir, 'claude-task-backend-model.txt'), 'utf-8')).toBe('gpt-4o');
  });

  it('writes phaseRoutingJson to claude-task-phase-routing.json', async () => {
    const phaseRoutingJson = JSON.stringify({
      execution: { backend: 'claude', provider: 'anthropic', model: 'auto' },
      review: { backend: 'claude', provider: 'anthropic', model: 'auto' },
      meta_review: { backend: 'claude', provider: 'anthropic', model: 'auto' },
    });
    await deliverTask(runtime, containerId, { prompt: 'test', phaseRoutingJson });
    expect(fs.readFileSync(path.join(tmpdir, 'claude-task-phase-routing.json'), 'utf-8')).toBe(phaseRoutingJson);
  });

  it('omits all conditional files when only prompt is provided', async () => {
    await deliverTask(runtime, containerId, { prompt: 'minimal' });
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-model.txt'))).toBe(false);
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-models.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-resume.txt'))).toBe(false);
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-backend.txt'))).toBe(false);
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-backend-model.txt'))).toBe(false);
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-phase-routing.json'))).toBe(false);
  });

  it('writes all conditional files when all inputs are provided', async () => {
    await deliverTask(runtime, containerId, {
      prompt: 'full task',
      model: 'claude-opus-4-8',
      modelsJson: '{"execution":"auto"}',
      resume: 'session-xyz',
      backend: 'claude',
      backendModel: 'claude-sonnet-4-6',
      phaseRoutingJson: '{"execution":{"backend":"claude"}}',
    });
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-model.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-models.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-resume.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-backend.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-backend-model.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmpdir, 'claude-task-phase-routing.json'))).toBe(true);
  });

  it('preserves multi-line prompt content exactly', async () => {
    const prompt = 'Line 1\nLine 2\nLine 3\n';
    await deliverTask(runtime, containerId, { prompt });
    expect(fs.readFileSync(path.join(tmpdir, 'claude-task-prompt.txt'), 'utf-8')).toBe(prompt);
  });
});
