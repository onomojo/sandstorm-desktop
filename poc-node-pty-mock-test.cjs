/**
 * POC: Proves node-pty can inject /usage and capture output from a Claude-like session.
 * Uses a mock Claude CLI to test the full pipeline end-to-end.
 *
 * Run: NODE_PATH=/tmp/node_modules node poc-node-pty-mock-test.cjs
 */

const pty = (() => {
  try { return require('node-pty'); } catch {
    return require('/tmp/node_modules/node-pty');
  }
})();

const READY_MARKER = 'for shortcuts';
const USAGE_MARKERS = ['Current session', 'Extra usage'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function parseUsageBlock(output, label) {
  const re = new RegExp(
    label + '[^\\n]*\\n[^\\n]*?\\s(\\d+)%\\s*used[^\\n]*\\n[^\\n]*Resets ([^\\n]+)'
  );
  const m = output.match(re);
  if (!m) return null;
  const resetsAt = m[2].replace(/[\s│╯╰╮╭─]+$/u, '');
  return { percent: Number(m[1]), resetsAt };
}

function parseUsageOutput(output) {
  const session = parseUsageBlock(output, 'Current session');
  const weekAll = parseUsageBlock(output, 'Current week \\(all models\\)');
  const weekSonnet = parseUsageBlock(output, 'Current week \\(Sonnet only\\)');
  const extraUsageEnabled = !/Extra usage not enabled/.test(output);
  return {
    session, weekAll, weekSonnet,
    extraUsage: { enabled: extraUsageEnabled },
    capturedAt: new Date().toISOString(),
    status: session ? (session.percent >= 95 ? 'at_limit' : 'ok') : 'parse_error',
  };
}

async function main() {
  console.log('=== node-pty Mock Test: Proving inject-and-capture mechanism ===\n');

  // Spawn mock claude in a PTY
  console.log('[1] Spawning mock Claude in PTY...');
  const proc = pty.spawn('node', ['poc-mock-claude.cjs'], {
    name: 'xterm-256color',
    cols: 220,
    rows: 60,
    cwd: '/app',
  });

  let allOutput = '';
  proc.onData((data) => {
    allOutput += data;
  });

  try {
    // Wait for ready
    console.log('[2] Waiting for prompt...');
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      const clean = stripAnsi(allOutput);
      if (clean.includes(READY_MARKER)) {
        console.log('[3] Prompt detected!');
        break;
      }
    }

    // Inject /usage
    await sleep(300);
    console.log('[4] Injecting /usage command...');
    proc.write('/usage\r');

    // Wait for usage output
    let usageFound = false;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      const clean = stripAnsi(allOutput);
      if (clean.includes('Current session')) {
        usageFound = true;
        console.log('[5] Usage output captured!');
        await sleep(500);
        break;
      }
    }

    if (!usageFound) {
      console.log('[!] Usage output not found');
      console.log(stripAnsi(allOutput));
      proc.kill();
      process.exit(1);
    }

    // Parse the output
    const cleanOutput = stripAnsi(allOutput);
    const snapshot = parseUsageOutput(cleanOutput);

    console.log('\n--- PARSED RESULT ---');
    console.log(JSON.stringify(snapshot, null, 2));
    console.log('--- END ---\n');

    // Validate
    let success = true;
    const checks = [
      ['Status is ok', snapshot.status === 'ok'],
      ['Session percent parsed', snapshot.session?.percent === 47],
      ['Session reset time parsed', snapshot.session?.resetsAt === '6pm (America/New_York)'],
      ['Week all parsed', snapshot.weekAll?.percent === 22],
      ['Week Sonnet parsed', snapshot.weekSonnet?.percent === 8],
      ['Extra usage detected as disabled', snapshot.extraUsage.enabled === false],
    ];

    for (const [name, pass] of checks) {
      console.log(`  ${pass ? 'PASS' : 'FAIL'}: ${name}`);
      if (!pass) success = false;
    }

    console.log(`\n${success ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`);

    // Clean exit
    proc.write('/exit\r');
    await sleep(500);

    process.exit(success ? 0 : 1);

  } catch (err) {
    console.error('Error:', err.message);
    proc.kill();
    process.exit(1);
  }
}

main();
