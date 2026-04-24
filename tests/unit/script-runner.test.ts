import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveScheduledScriptPath,
  runScheduledScript,
  _clearDirectivesForTesting,
  registerDirective,
} from '../../src/main/scheduler/script-runner';

let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-runner-'));
  fs.mkdirSync(path.join(projectDir, '.sandstorm', 'scripts', 'scheduled'), { recursive: true });
  _clearDirectivesForTesting();
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
  _clearDirectivesForTesting();
});

function writeScript(name: string, body: string): string {
  const p = path.join(projectDir, '.sandstorm', 'scripts', 'scheduled', name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

describe('resolveScheduledScriptPath', () => {
  it('resolves a script inside .sandstorm/scripts/scheduled/', () => {
    const result = resolveScheduledScriptPath(projectDir, 'hello.sh');
    expect(result).toEqual({
      ok: true,
      path: path.join(projectDir, '.sandstorm', 'scripts', 'scheduled', 'hello.sh'),
    });
  });

  it('appends .sh when missing', () => {
    const result = resolveScheduledScriptPath(projectDir, 'hello');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path.endsWith('hello.sh')).toBe(true);
  });

  it('rejects absolute paths', () => {
    const result = resolveScheduledScriptPath(projectDir, '/etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/relative/);
  });

  it('rejects path traversal with ..', () => {
    const result = resolveScheduledScriptPath(projectDir, '../../../etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/escapes/);
  });

  it('rejects empty name', () => {
    const result = resolveScheduledScriptPath(projectDir, '   ');
    expect(result.ok).toBe(false);
  });
});

describe('runScheduledScript', () => {
  const request = { scheduleId: 'sch_test', firedAt: '2026-01-01T00:00:00Z' };

  it('rejects when script is missing', async () => {
    const res = await runScheduledScript(projectDir, 'missing.sh', request);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/not found/);
  });

  it('rejects when script is not executable', async () => {
    const p = path.join(projectDir, '.sandstorm', 'scripts', 'scheduled', 'noexec.sh');
    fs.writeFileSync(p, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o644 });
    const res = await runScheduledScript(projectDir, 'noexec.sh', request);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/not executable/);
  });

  it('passes SANDSTORM_* env vars to the script', async () => {
    const envOut = path.join(projectDir, 'env.out');
    writeScript('env.sh', `#!/usr/bin/env bash
set -e
{
  echo "PROJECT_DIR=$SANDSTORM_PROJECT_DIR"
  echo "SCHEDULE_ID=$SANDSTORM_SCHEDULE_ID"
  echo "FIRED_AT=$SANDSTORM_FIRED_AT"
  echo "DISPATCH_ID=$SANDSTORM_DISPATCH_ID"
} > "${envOut}"
`);
    const res = await runScheduledScript(projectDir, 'env.sh', request);
    expect(res.ok).toBe(true);
    const contents = fs.readFileSync(envOut, 'utf-8');
    expect(contents).toContain(`PROJECT_DIR=${projectDir}`);
    expect(contents).toContain('SCHEDULE_ID=sch_test');
    expect(contents).toContain('FIRED_AT=2026-01-01T00:00:00Z');
    expect(contents).toMatch(/DISPATCH_ID=dispatch_/);
  });

  it('returns stderr tail when script exits non-zero', async () => {
    writeScript('fail.sh', `#!/usr/bin/env bash
echo "bad things happened" 1>&2
exit 3
`);
    const res = await runScheduledScript(projectDir, 'fail.sh', request);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toMatch(/exited with code 3/);
      expect(res.message).toMatch(/bad things happened/);
    }
  });

  it('dispatches registered JSON directives from stdout', async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    registerDirective('ping', async (d) => {
      calls.push({ cmd: d.cmd, args: { ...d } });
    });
    writeScript('ping.sh', `#!/usr/bin/env bash
echo '{"cmd":"ping","payload":"hello"}'
echo '{"cmd":"ping","payload":"world"}'
echo 'plain diagnostic line'
exit 0
`);
    const res = await runScheduledScript(projectDir, 'ping.sh', request);
    expect(res.ok).toBe(true);
    // allow a brief tick for line handlers to run after close
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(2);
    expect(calls[0].args.payload).toBe('hello');
    expect(calls[1].args.payload).toBe('world');
  });

  it('ignores JSON directives without a registered handler', async () => {
    writeScript('unknown-cmd.sh', `#!/usr/bin/env bash
echo '{"cmd":"no-such-handler","x":1}'
exit 0
`);
    const res = await runScheduledScript(projectDir, 'unknown-cmd.sh', request);
    expect(res.ok).toBe(true); // unhandled directives don't fail the run
  });

  it('tolerates non-JSON stdout without blowing up', async () => {
    writeScript('chatty.sh', `#!/usr/bin/env bash
echo "starting"
echo "{not-valid-json"
echo "finishing"
exit 0
`);
    const res = await runScheduledScript(projectDir, 'chatty.sh', request);
    expect(res.ok).toBe(true);
  });

  it('rejects when scriptName attempts path traversal', async () => {
    const res = await runScheduledScript(projectDir, '../../../etc/passwd', request);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/escapes/);
  });
});
