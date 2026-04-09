/**
 * POC: node-pty based usage collection for Claude Code
 *
 * Replaces tmux by spawning Claude Code in a pseudo-terminal,
 * injecting `/usage`, and parsing the output.
 *
 * Run: node poc-node-pty.cjs
 */

// In production, node-pty is a regular dependency. For POC testing we use the
// copied binary since build tools aren't available on this container.
const pty = (() => {
  try { return require('node-pty'); } catch {
    return require('/tmp/node_modules/node-pty');
  }
})();

const READY_MARKER = 'for shortcuts';
const USAGE_MARKERS = ['Current session', 'Extra usage'];
const READY_TIMEOUT_MS = 30000;
const USAGE_TIMEOUT_MS = 15000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a single usage block from captured output.
 */
function parseUsageBlock(output, label) {
  const re = new RegExp(
    label + '[^\\n]*\\n[^\\n]*?\\s(\\d+)% used[^\\n]*\\n[^\\n]*Resets ([^\\n]+)'
  );
  const m = output.match(re);
  if (!m) return null;
  const resetsAt = m[2].replace(/[\s│╯╰╮╭─]+$/u, '');
  return { percent: Number(m[1]), resetsAt };
}

/**
 * Parse full usage output into a snapshot.
 */
function parseUsageOutput(output) {
  const session = parseUsageBlock(output, 'Current session');
  const weekAll = parseUsageBlock(output, 'Current week \\(all models\\)');
  const weekSonnet = parseUsageBlock(output, 'Current week \\(Sonnet only\\)');
  const extraUsageEnabled = !/Extra usage not enabled/.test(output);

  return {
    session,
    weekAll,
    weekSonnet,
    extraUsage: { enabled: extraUsageEnabled },
    capturedAt: new Date().toISOString(),
    status: session ? (session.percent >= 95 ? 'at_limit' : 'ok') : 'parse_error',
  };
}

/**
 * Collect all PTY output into a buffer, waiting for a marker string.
 */
/** Strip ANSI escape sequences from text */
function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '');
}

function waitForMarker(ptyProcess, markers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      resolve({ found: false, buffer });
    }, timeoutMs);

    const disposable = ptyProcess.onData((data) => {
      buffer += data;
      const clean = stripAnsi(buffer);
      for (const marker of markers) {
        if (clean.includes(marker)) {
          clearTimeout(timer);
          disposable.dispose();
          resolve({ found: true, buffer });
          return;
        }
      }
    });
  });
}

async function main() {
  console.log('=== node-pty POC: Claude Code /usage collection ===\n');

  // Spawn claude in a PTY
  const env = {
    ...process.env,
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  };

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

  try {
    // Handle theme picker if it appears (first-run setup)
    console.log('[2] Waiting for Claude to start (handling theme picker if needed)...');
    const themeOrReady = await waitForMarker(proc, [READY_MARKER, 'Choose', 'theme'], READY_TIMEOUT_MS);

    if (!themeOrReady.found) {
      console.log('[!] Claude did not start within timeout.');
      const cleaned = stripAnsi(allOutput);
      console.log('[DEBUG] Full cleaned output:\n', cleaned);
      proc.kill();
      process.exit(1);
    }

    const cleanedSoFar = stripAnsi(allOutput);
    if (cleanedSoFar.includes('Choose') || cleanedSoFar.includes('theme')) {
      console.log('[2a] Theme picker detected, selecting default...');
      proc.write('\r');  // Select default (option 1)
      await sleep(2000);
    }

    // Now wait for the actual prompt
    console.log('[2b] Waiting for Claude prompt to be ready...');
    const readyResult = await waitForMarker(proc, [READY_MARKER], READY_TIMEOUT_MS);

    if (!readyResult.found) {
      console.log('[!] Claude did not become ready within timeout.');
      const cleaned = stripAnsi(allOutput);
      console.log('[DEBUG] Full cleaned output:\n', cleaned);
      proc.kill();
      process.exit(1);
    }

    console.log('[3] Claude is ready. Sending /usage command...');

    // Small delay to let the prompt fully render
    await sleep(500);

    // Send /usage command
    proc.write('/usage\r');

    // Wait for usage output
    console.log('[4] Waiting for usage output...');
    const usageResult = await waitForMarker(proc, USAGE_MARKERS, USAGE_TIMEOUT_MS);

    if (!usageResult.found) {
      console.log('[!] Usage output not detected within timeout.');
      console.log('[DEBUG] Buffer so far:\n', allOutput.slice(-1000));
    } else {
      // Give it a moment to finish rendering the full dialog
      await sleep(2000);
      console.log('[5] Usage output captured successfully!\n');
    }

    // Strip ANSI escape codes for parsing
    const cleanOutput = allOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b[()][0-9A-Za-z]/g, '');

    console.log('--- RAW OUTPUT (last 2000 chars) ---');
    console.log(cleanOutput.slice(-2000));
    console.log('--- END RAW OUTPUT ---\n');

    // Parse
    const snapshot = parseUsageOutput(cleanOutput);
    console.log('--- PARSED RESULT ---');
    console.log(JSON.stringify(snapshot, null, 2));
    console.log('--- END PARSED RESULT ---\n');

    if (snapshot.status === 'ok' || snapshot.status === 'at_limit') {
      console.log('SUCCESS: node-pty approach works!');
      console.log(`  Session usage: ${snapshot.session?.percent}%`);
      console.log(`  Resets at: ${snapshot.session?.resetsAt}`);
    } else {
      console.log(`PARTIAL: Got status "${snapshot.status}" — may need parser tuning.`);
    }

    // Clean exit
    console.log('\n[6] Sending Escape and /exit...');
    proc.write('\x1b');  // Escape key
    await sleep(500);
    proc.write('/exit\r');
    await sleep(1000);

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    try { proc.kill(); } catch {}
    console.log('\n[Done] PTY process terminated.');
  }
}

main();
