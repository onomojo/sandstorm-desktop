/**
 * POC v2: node-pty based usage collection for Claude Code
 *
 * This version handles the first-run setup wizard (theme picker, login method)
 * and proves the full inject-and-capture mechanism works.
 *
 * Run: NODE_PATH=/tmp/node_modules node poc-node-pty-v2.cjs
 */

const pty = (() => {
  try { return require('node-pty'); } catch {
    return require('/tmp/node_modules/node-pty');
  }
})();

const READY_MARKER = 'for shortcuts';
const USAGE_MARKERS = ['Current session', 'Extra usage'];
const TIMEOUT_MS = 45000;

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
  console.log('=== node-pty POC v2: Claude Code /usage collection ===\n');

  const env = { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' };

  console.log('[1] Spawning claude in PTY...');
  const proc = pty.spawn('claude', [
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', 'user',
  ], {
    name: 'xterm-256color',
    cols: 220,
    rows: 60,
    env,
  });

  let allOutput = '';
  proc.onData((data) => {
    allOutput += data;
  });

  const startTime = Date.now();
  const elapsed = () => `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

  try {
    // Phase 1: Get through any setup wizards to the prompt
    console.log('[2] Navigating through setup...');

    let ready = false;
    while (Date.now() - startTime < TIMEOUT_MS) {
      await sleep(1000);
      const clean = stripAnsi(allOutput);

      // Check if we're at the prompt (space-agnostic)
      if (clean.includes('forshortcuts') || clean.includes('for shortcuts') || clean.includes('?forhelp')) {
        console.log(`[${elapsed()}] Claude prompt detected!`);
        ready = true;
        break;
      }

      // Handle theme picker (spaces may be stripped - use space-agnostic matching)
      if (clean.includes('Choosethetextstyle') || (clean.includes('Choose') && clean.includes('textstyle'))) {
        console.log(`[${elapsed()}] Theme picker detected, sending Enter...`);
        proc.write('\r');
        await sleep(2000);
        continue;
      }

      // Handle login method selector
      if (clean.includes('Selectloginmethod') || clean.includes('loginmethod')) {
        console.log(`[${elapsed()}] Login method selector detected, selecting option 1...`);
        proc.write('\r');
        await sleep(3000);
        continue;
      }

      // Handle any other prompts that need Enter
      if (clean.includes('PressEnter') || clean.includes('pressenter')) {
        console.log(`[${elapsed()}] Press Enter prompt detected...`);
        proc.write('\r');
        await sleep(1000);
        continue;
      }
    }

    if (!ready) {
      console.log(`[!] Claude did not reach prompt within ${TIMEOUT_MS/1000}s.`);
      console.log('[DEBUG] Last 3000 chars of cleaned output:');
      console.log(stripAnsi(allOutput).slice(-3000));
      proc.kill();
      process.exit(1);
    }

    // Phase 2: Inject /usage
    console.log(`[${elapsed()}] Sending /usage command...`);
    await sleep(500);
    proc.write('/usage\r');

    // Phase 3: Wait for usage output
    let usageFound = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const clean = stripAnsi(allOutput);
      if (clean.includes('Currentsession') || clean.includes('Current session') || clean.includes('Extrausage')) {
        usageFound = true;
        console.log(`[${elapsed()}] Usage output detected!`);
        await sleep(2000); // Let it fully render
        break;
      }
    }

    if (!usageFound) {
      console.log(`[${elapsed()}] Usage output not found.`);
      console.log('[DEBUG] Last 2000 chars:');
      console.log(stripAnsi(allOutput).slice(-2000));
    }

    // Phase 4: Parse
    const cleanOutput = stripAnsi(allOutput);

    console.log('\n--- RAW CLEANED OUTPUT (last 3000 chars) ---');
    console.log(cleanOutput.slice(-3000));
    console.log('--- END ---\n');

    const snapshot = parseUsageOutput(cleanOutput);
    console.log('--- PARSED RESULT ---');
    console.log(JSON.stringify(snapshot, null, 2));
    console.log('--- END ---\n');

    if (snapshot.status === 'ok' || snapshot.status === 'at_limit') {
      console.log(`SUCCESS: Session usage: ${snapshot.session?.percent}%, resets: ${snapshot.session?.resetsAt}`);
    } else {
      console.log(`Result status: "${snapshot.status}"`);
    }

    // Clean exit
    proc.write('\x1b'); // Escape
    await sleep(300);
    proc.write('/exit\r');
    await sleep(1000);

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    try { proc.kill(); } catch {}
    console.log(`\n[${elapsed()}] Done.`);
  }
}

main();
