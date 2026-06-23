import { DockerRuntime } from '../../src/main/runtime/docker';

/**
 * Returns true when the calling test should be skipped.
 *
 * Skip conditions:
 *  1. SANDSTORM_STACK_ID is set — we're inside a Sandstorm stack. Docker
 *     socket IS mounted there (isAvailable() returns true), but spinning
 *     nested containers on the shared host daemon during per-ticket verify
 *     is explicitly forbidden.
 *  2. Docker is unavailable on the host (no socket / daemon not running).
 */
export async function skipIfInStackOrNoDocker(runtime: DockerRuntime): Promise<boolean> {
  if (process.env.SANDSTORM_STACK_ID) return true;
  return !(await runtime.isAvailable());
}
