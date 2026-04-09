/**
 * Mock Claude CLI that simulates the interactive session.
 * Used to prove node-pty can inject /usage and capture the output.
 */

const readline = require('readline');

// Simulate Claude startup
setTimeout(() => {
  process.stdout.write('\n  Welcome to Claude Code v2.1.92\n\n');
  process.stdout.write('  Type ? for shortcuts, / for commands\n\n');
  process.stdout.write('> ');

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const cmd = line.trim();

    if (cmd === '/usage') {
      // Simulate usage dialog output
      process.stdout.write('\n');
      process.stdout.write('╭─────────────────────────────────────────────────╮\n');
      process.stdout.write('│ Usage                                           │\n');
      process.stdout.write('│                                                 │\n');
      process.stdout.write('│ Current session                                           │\n');
      process.stdout.write('│   ███████████████████████▌                 47% used       │\n');
      process.stdout.write('│   Resets 6pm (America/New_York)                           │\n');
      process.stdout.write('│                                                           │\n');
      process.stdout.write('│ Current week (all models)                                 │\n');
      process.stdout.write('│   ██████████▌                              22% used       │\n');
      process.stdout.write('│   Resets Monday 12am (America/New_York)                   │\n');
      process.stdout.write('│                                                           │\n');
      process.stdout.write('│ Current week (Sonnet only)                                │\n');
      process.stdout.write('│   ████▌                                    8% used        │\n');
      process.stdout.write('│   Resets Monday 12am (America/New_York)                   │\n');
      process.stdout.write('│                                                           │\n');
      process.stdout.write('│ Extra usage not enabled                                   │\n');
      process.stdout.write('╰─────────────────────────────────────────────────╯\n');
      process.stdout.write('\n> ');
    } else if (cmd === '/exit') {
      process.stdout.write('\nBye!\n');
      process.exit(0);
    } else {
      process.stdout.write(`Echo: ${cmd}\n> `);
    }
  });
}, 1000);
