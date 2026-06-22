import { ContainerRuntime } from '../runtime/types';

export interface BringUpOpts {
  projectName: string;
  composeFiles: string[];
  env?: Record<string, string>;
  build?: boolean;
}

export interface DeliverTaskInputs {
  prompt: string;
  model?: string;
  modelsJson?: string;
  resume?: string;
  backend?: string;
  backendModel?: string;
  phaseRoutingJson?: string;
}

/**
 * Bring a stack up by delegating to runtime.composeUp.
 * For LocalRuntime this registers a fake container and starts the local loop.
 * For DockerRuntime this runs `docker compose up -d` with the supplied files.
 */
export async function bringUp(
  runtime: ContainerRuntime,
  projectDir: string,
  opts: BringUpOpts
): Promise<void> {
  await runtime.composeUp(projectDir, {
    projectName: opts.projectName,
    composeFiles: opts.composeFiles,
    env: opts.env,
    build: opts.build,
  });
}

async function writeToContainer(
  runtime: ContainerRuntime,
  containerId: string,
  filePath: string,
  content: string
): Promise<void> {
  const result = await runtime.exec(
    containerId,
    ['bash', '-c', `cat > ${filePath}`],
    { input: content, user: 'claude' }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `deliverTask: failed to write ${filePath}: ${result.stderr || result.stdout}`
    );
  }
}

/**
 * Deliver a task to a running container by writing state files via runtime.exec.
 *
 * Matches the file-write sequence performed by `sandstorm task` in stack.sh:
 *   - prompt and label written first
 *   - optional files written only when the input is present
 *   - trigger touched last (B1: large prompts go via stdin, never argv)
 */
export async function deliverTask(
  runtime: ContainerRuntime,
  containerId: string,
  inputs: DeliverTaskInputs
): Promise<void> {
  // Label = first line of prompt, max 80 chars (mirrors: head -1 | cut -c1-80)
  const label = (inputs.prompt.split('\n')[0] ?? '').slice(0, 80);

  await writeToContainer(runtime, containerId, '/tmp/claude-task-prompt.txt', inputs.prompt);
  await writeToContainer(runtime, containerId, '/tmp/claude-task-label.txt', label);

  if (inputs.model != null) {
    await writeToContainer(runtime, containerId, '/tmp/claude-task-model.txt', inputs.model);
  }
  if (inputs.modelsJson != null) {
    await writeToContainer(runtime, containerId, '/tmp/claude-task-models.json', inputs.modelsJson);
  }
  if (inputs.resume != null) {
    await writeToContainer(runtime, containerId, '/tmp/claude-task-resume.txt', inputs.resume);
  }
  if (inputs.backend != null) {
    await writeToContainer(runtime, containerId, '/tmp/claude-task-backend.txt', inputs.backend);
  }
  if (inputs.backendModel != null) {
    await writeToContainer(runtime, containerId, '/tmp/claude-task-backend-model.txt', inputs.backendModel);
  }
  if (inputs.phaseRoutingJson != null) {
    await writeToContainer(runtime, containerId, '/tmp/claude-task-phase-routing.json', inputs.phaseRoutingJson);
  }

  // Touch trigger LAST — inputs must all exist before the loop sees the trigger
  const triggerResult = await runtime.exec(
    containerId,
    ['bash', '-c', 'touch /tmp/claude-task-trigger'],
    { user: 'claude' }
  );
  if (triggerResult.exitCode !== 0) {
    throw new Error(
      `deliverTask: failed to set trigger: ${triggerResult.stderr || triggerResult.stdout}`
    );
  }
}
