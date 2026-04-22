import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

// Structural + behavior tests for the refactored sandstorm-spec.sh (#312).
// We stub `curl`, `gh`, and `fetch-ticket.sh` via a temp PATH dir. No real
// Claude invocation; the tests verify the SHELL SCRIPT'S output shape.

const repoRoot = resolve(__dirname, '../..');
const script = resolve(repoRoot, 'sandstorm-cli/skills/sandstorm-spec/scripts/sandstorm-spec.sh');
const skillMd = resolve(repoRoot, 'sandstorm-cli/skills/sandstorm-spec/SKILL.md');

describe('sandstorm-spec.sh structural invariants (#312)', () => {
  it('SKILL.md has required frontmatter and documents trim + idempotency', () => {
    expect(existsSync(skillMd)).toBe(true);
    const content = readFileSync(skillMd, 'utf-8');
    expect(content).toMatch(/^---/);
    expect(content).toMatch(/name:\s*sandstorm-spec\b/);
    expect(content.toLowerCase()).toMatch(/trim|trimmed/);
    expect(content.toLowerCase()).toMatch(/idempotency|cached/);
    expect(content.toLowerCase()).toMatch(/spec-ready/);
  });

  it('script exists, is executable, and has valid bash syntax', () => {
    expect(existsSync(script)).toBe(true);
    // eslint-disable-next-line no-bitwise
    expect(statSync(script).mode & 0o111).not.toBe(0);
    const check = spawnSync('bash', ['-n', script]);
    expect(check.status, check.stderr?.toString()).toBe(0);
  });

  it('emit_trimmed function does NOT include "report" or "updatedBody" fields', () => {
    const body = readFileSync(script, 'utf-8');
    const emitFn = body.match(/emit_trimmed[\s\S]*?^\}/m)?.[0] ?? '';
    expect(emitFn.length).toBeGreaterThan(0);
    expect(emitFn).not.toMatch(/"report"/);
    expect(emitFn).not.toMatch(/"updatedBody"/);
  });

  it('returns a JSON error on missing args', () => {
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

  it('refuses to run without bridge env', () => {
    const result = spawnSync('bash', [script, 'check', '1'], {
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf-8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/bridge/i);
  });

  it('rejects unknown subcommands', () => {
    const out = execFileSync('bash', [script, 'bogus', '1'], {
      env: {
        ...process.env,
        SANDSTORM_BRIDGE_URL: 'http://127.0.0.1:1',
        SANDSTORM_BRIDGE_TOKEN: 'dummy',
      },
      encoding: 'utf-8',
    });
    const parsed = JSON.parse(out);
    expect(parsed.error).toBe('unknown_subcommand');
    expect(parsed.got).toBe('bogus');
  });
});

describe('sandstorm-spec.sh check — output trim (stubbed curl/gh)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'spec-trim-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeStubs(opts: {
    labels: string[];
    bridgeResponse?: string;
  }): { projectDir: string; binDir: string } {
    const binDir = join(tmpDir, 'bin');
    spawnSync('mkdir', ['-p', binDir]);

    const labelsJson = opts.labels.map((n) => `{"name":"${n}"}`).join(',');
    // gh calls: \`gh issue view <id> --json <field> [-q ...]\`; $3 is the id.
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

    // Bridge response: include a large "report" field that the script must trim.
    const bigReport = '## Spec Quality Gate: PASS\\n\\n' + 'x'.repeat(10000);
    const defaultResp = `{"result":{"passed":true,"report":"${bigReport}"}}`;
    const curlStub = `#!/usr/bin/env bash
cat <<'EOF'
${opts.bridgeResponse ?? defaultResp}
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

    return { projectDir, binDir };
  }

  it('strips the large "report" field from bridge response (output < 2 KB)', () => {
    const { projectDir, binDir } = makeStubs({ labels: [] });
    const out = execFileSync('bash', [script, 'check', '138'], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        SANDSTORM_BRIDGE_URL: 'http://stubbed',
        SANDSTORM_BRIDGE_TOKEN: 'dummy',
      },
      cwd: projectDir,
      encoding: 'utf-8',
    });

    expect(out.length).toBeLessThan(2048);
    const parsed = JSON.parse(out);
    expect(parsed.passed).toBe(true);
    expect(parsed.gate_summary).toMatch(/PASS/);
    // No "report" or "updatedBody", no 10 KB payload.
    expect(parsed.report).toBeUndefined();
    expect(parsed.updatedBody).toBeUndefined();
    expect(out).not.toContain('x'.repeat(500));
  });

  it('short-circuits with cached:true when spec-ready:sha-<hash> label matches body hash', () => {
    // Compute the 12-char hash the shell script would compute for the stub body.
    const sampleBody = '# Ticket 138\nBody for ticket 138\n';
    const hash = spawnSync('bash', ['-c', `printf "%s" "${sampleBody}" | sha256sum | cut -c1-12`])
      .stdout.toString().trim();
    expect(hash).toHaveLength(12);

    const { projectDir, binDir } = makeStubs({
      labels: [`spec-ready:sha-${hash}`],
    });
    const out = execFileSync('bash', [script, 'check', '138'], {
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
    expect(parsed.passed).toBe(true);
    expect(parsed.cached).toBe(true);
    expect(parsed.gate_summary).toMatch(/cached/i);
  });
});
