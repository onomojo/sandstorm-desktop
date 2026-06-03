import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

// Structural + gate-enforcement tests for sandstorm-dispatch.sh (#312).
// We stub `curl`, `gh`, and `fetch-ticket.sh` via a temp PATH dir.
// No real HTTP server — stubbing curl keeps the tests hermetic and fast.

const repoRoot = resolve(__dirname, '../..');
const script = resolve(repoRoot, 'sandstorm-cli/skills/sandstorm-dispatch/scripts/dispatch.sh');
const skillMd = resolve(repoRoot, 'sandstorm-cli/skills/sandstorm-dispatch/SKILL.md');

describe('sandstorm-dispatch.sh structural invariants (#312)', () => {
  it('SKILL.md exists with required frontmatter and documents the strict gate', () => {
    expect(existsSync(skillMd)).toBe(true);
    const content = readFileSync(skillMd, 'utf-8');
    expect(content).toMatch(/^---/);
    expect(content).toMatch(/name:\s*sandstorm-dispatch\b/);
    expect(content.toLowerCase()).toMatch(/spec-ready/);
    expect(content.toLowerCase()).toMatch(/strictly gated|no bypass|refuses/);
  });

  it('script exists, is executable, has valid bash syntax', () => {
    expect(existsSync(script)).toBe(true);
    // eslint-disable-next-line no-bitwise
    expect(statSync(script).mode & 0o111).not.toBe(0);
    const check = spawnSync('bash', ['-n', script]);
    expect(check.status, check.stderr?.toString()).toBe(0);
  });

  it('script does NOT parse a --force / --bypass flag', () => {
    const body = readFileSync(script, 'utf-8');
    expect(body).not.toMatch(/^\s*--force\)/m);
    expect(body).not.toMatch(/^\s*--bypass\)/m);
    const flowLines = body.split('\n').filter((l) => !l.trim().startsWith('#'));
    const flowBody = flowLines.join('\n');
    expect(flowBody).not.toMatch(/force_bypass|FORCE_BYPASS/);
  });

  it('returns a JSON error on missing ticket id', () => {
    const out = execFileSync('bash', [script], {
      env: {
        ...process.env,
        SANDSTORM_BRIDGE_URL: 'http://127.0.0.1:1',
        SANDSTORM_BRIDGE_TOKEN: 'dummy',
      },
      encoding: 'utf-8',
    });
    const parsed = JSON.parse(out);
    expect(parsed.error).toBe('missing_arg');
  });

  it('refuses to run without bridge env vars', () => {
    const result = spawnSync('bash', [script, '138'], {
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/bridge/i);
  });

  it('rejects unknown flags with a JSON error', () => {
    const out = execFileSync('bash', [script, '138', '--force'], {
      env: {
        ...process.env,
        SANDSTORM_BRIDGE_URL: 'http://127.0.0.1:1',
        SANDSTORM_BRIDGE_TOKEN: 'dummy',
      },
      encoding: 'utf-8',
    });
    const parsed = JSON.parse(out);
    expect(parsed.error).toBe('unknown_arg');
    expect(parsed.got).toBe('--force');
  });
});

describe('sandstorm-dispatch.sh gate enforcement (stubbed curl/gh/fetch)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dispatch-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Build a sandbox with stubbed gh, curl, and fetch-ticket.sh. The curl
  // stub records its input to a log file so tests can assert on bridge
  // calls. Returns (projectDir, binDir, curlLog).
  function makeStubs(opts: { labels: string[]; curlResponse?: string }): { projectDir: string; binDir: string; curlLog: string } {
    const binDir = join(tmpDir, 'bin');
    spawnSync('mkdir', ['-p', binDir]);
    const curlLog = join(tmpDir, 'curl.log');

    // Stub gh — returns the configured labels list + a URL.
    const labelsJson = opts.labels.map((n) => `{"name":"${n}"}`).join(',');
    // gh CLI calls in our scripts: \`gh issue view <id> --json <f> [-q ...]\`
    // So $3 is always the ticket id.
    const ghStub = `#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"--json labels"* ]]; then
  echo '{"labels":[${labelsJson}]}' | jq '.labels[].name' -r
  exit 0
fi
if [[ "$args" == *"--json url"* ]]; then
  echo "https://github.com/test/repo/issues/$3"
  exit 0
fi
exit 0
`;
    writeFileSync(join(binDir, 'gh'), ghStub);
    chmodSync(join(binDir, 'gh'), 0o755);

    // Stub curl — logs stdin/args, writes a configurable response to stdout.
    const defaultResp = '{"result":{"id":"42","name":"test-stack","branch":"feat/42-test"}}';
    const curlStub = `#!/usr/bin/env bash
# Record args and body for test assertions.
echo "ARGS: $*" >> "${curlLog}"
if [[ "$*" == *"-d "* ]]; then
  # Extract the -d payload and log it.
  prev=""
  for a in "$@"; do
    if [[ "$prev" == "-d" ]]; then
      echo "BODY: $a" >> "${curlLog}"
    fi
    prev="$a"
  done
fi
cat <<'EOF'
${opts.curlResponse ?? defaultResp}
EOF
`;
    writeFileSync(join(binDir, 'curl'), curlStub);
    chmodSync(join(binDir, 'curl'), 0o755);

    const projectDir = join(tmpDir, 'project');
    spawnSync('mkdir', ['-p', join(projectDir, '.sandstorm/scripts')]);
    const fetchStub = `#!/usr/bin/env bash
echo "# Ticket $1"
echo "Body for ticket $1"
`;
    writeFileSync(join(projectDir, '.sandstorm/scripts/fetch-ticket.sh'), fetchStub);
    chmodSync(join(projectDir, '.sandstorm/scripts/fetch-ticket.sh'), 0o755);

    return { projectDir, binDir, curlLog };
  }

  it('refuses with NOT_GATE_READY when ticket has no spec-ready label', () => {
    const { projectDir, binDir, curlLog } = makeStubs({ labels: ['bug', 'priority-medium'] });
    const out = execFileSync('bash', [script, '138'], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        SANDSTORM_BRIDGE_URL: 'http://stubbed',
        SANDSTORM_BRIDGE_TOKEN: 'dummy',
      },
      cwd: projectDir,
      encoding: 'utf-8',
    });
    const parsed = JSON.parse(out);
    expect(parsed.error).toBe('NOT_GATE_READY');
    expect(parsed.ticket_url).toContain('/issues/138');
    expect(parsed.hint).toMatch(/sandstorm-spec/);
    // Critical: curl (the bridge) was NEVER called.
    expect(existsSync(curlLog)).toBe(false);
  });

  it('proceeds when plain spec-ready label is present; passes body verbatim', () => {
    const { projectDir, binDir, curlLog } = makeStubs({ labels: ['spec-ready'] });
    const out = execFileSync('bash', [script, '138', '--stack-name', 'my-stack'], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        SANDSTORM_BRIDGE_URL: 'http://stubbed',
        SANDSTORM_BRIDGE_TOKEN: 'dummy',
      },
      cwd: projectDir,
      encoding: 'utf-8',
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.stack_id).toBe('42');

    expect(existsSync(curlLog)).toBe(true);
    const log = readFileSync(curlLog, 'utf-8');
    // Find the BODY line (our bridge payload).
    const bodyLine = log.split('\n').find((l) => l.startsWith('BODY: '));
    expect(bodyLine).toBeTruthy();
    const bridgePayload = JSON.parse(bodyLine!.slice(6));
    expect(bridgePayload.name).toBe('create_stack');
    expect(bridgePayload.input.name).toBe('my-stack');
    expect(bridgePayload.input.ticket).toBe('138');
    expect(bridgePayload.input.gateApproved).toBe(true);
    expect(bridgePayload.input.task).toContain('Body for ticket 138');
  });

  it('proceeds when spec-ready:sha-<hash> label is present', () => {
    const { projectDir, binDir, curlLog } = makeStubs({
      labels: ['spec-ready:sha-abcdef123456', 'enhancement'],
    });
    const out = execFileSync('bash', [script, '138'], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        SANDSTORM_BRIDGE_URL: 'http://stubbed',
        SANDSTORM_BRIDGE_TOKEN: 'dummy',
      },
      cwd: projectDir,
      encoding: 'utf-8',
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(existsSync(curlLog)).toBe(true);
  });

  it('auto-generates a stack name when not provided, mentions the ticket id', () => {
    const { projectDir, binDir, curlLog } = makeStubs({ labels: ['spec-ready'] });
    execFileSync('bash', [script, '42'], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        SANDSTORM_BRIDGE_URL: 'http://stubbed',
        SANDSTORM_BRIDGE_TOKEN: 'dummy',
      },
      cwd: projectDir,
      encoding: 'utf-8',
    });
    const log = readFileSync(curlLog, 'utf-8');
    const bodyLine = log.split('\n').find((l) => l.startsWith('BODY: '));
    const bridgePayload = JSON.parse(bodyLine!.slice(6));
    expect(String(bridgePayload.input.name)).toMatch(/42/);
  });
});

describe('spec-and-dispatch.sh thin wrapper (#312)', () => {
  const wrapperScript = resolve(repoRoot, 'sandstorm-cli/skills/spec-and-dispatch/scripts/spec-and-dispatch.sh');

  it('script exists, is executable, has valid bash syntax', () => {
    expect(existsSync(wrapperScript)).toBe(true);
    // eslint-disable-next-line no-bitwise
    expect(statSync(wrapperScript).mode & 0o111).not.toBe(0);
    const check = spawnSync('bash', ['-n', wrapperScript]);
    expect(check.status, check.stderr?.toString()).toBe(0);
  });

  it('delegates to sandstorm-spec.sh and sandstorm-dispatch.sh rather than reimplementing logic', () => {
    const body = readFileSync(wrapperScript, 'utf-8');
    // Must reference the two primitives by path.
    expect(body).toContain('sandstorm-spec/scripts/sandstorm-spec.sh');
    expect(body).toContain('sandstorm-dispatch/scripts/dispatch.sh');
    // Must NOT call the MCP bridge directly — that's the primitive's job.
    expect(body).not.toContain('/tool-call');
    expect(body).not.toMatch(/SANDSTORM_BRIDGE_TOKEN/);
  });
});
