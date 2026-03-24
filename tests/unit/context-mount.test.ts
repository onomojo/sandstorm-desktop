import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
/**
 * Tests for the context mount feature (GitHub issue #17).
 *
 * Verifies that:
 * 1. `sandstorm init` generates a docker-compose.yml with the SANDSTORM_CONTEXT volume mount
 * 2. The entrypoint script appends .sandstorm/context/*.md to the inner Claude's CLAUDE.md
 */

describe('context mount in generated docker-compose.yml', () => {
  it('includes SANDSTORM_CONTEXT volume mount for claude service', () => {
    // Read the init.sh script and look for the volume mount in the heredoc
    const initScript = fs.readFileSync(
      path.join(__dirname, '../../sandstorm-cli/lib/init.sh'),
      'utf-8'
    );

    // The generated compose should mount SANDSTORM_CONTEXT as read-only
    expect(initScript).toContain('${SANDSTORM_CONTEXT}:/sandstorm-context:ro');
  });

  it('mounts SANDSTORM_CONTEXT between workspace and docker socket volumes', () => {
    const initScript = fs.readFileSync(
      path.join(__dirname, '../../sandstorm-cli/lib/init.sh'),
      'utf-8'
    );

    // Find the volumes section for the claude service
    const lines = initScript.split('\n');
    const volumeLines: string[] = [];
    let inClaudeVolumes = false;

    for (const line of lines) {
      if (line.includes('SANDSTORM_WORKSPACE') && line.includes('/app')) {
        inClaudeVolumes = true;
      }
      if (inClaudeVolumes) {
        volumeLines.push(line.trim());
        if (line.includes('docker.sock')) {
          break;
        }
      }
    }

    // Should have 3 volume entries: workspace, context, docker socket
    const volumeEntries = volumeLines.filter((l) => l.startsWith('- '));
    expect(volumeEntries).toHaveLength(3);
    expect(volumeEntries[0]).toContain('SANDSTORM_WORKSPACE');
    expect(volumeEntries[1]).toContain('SANDSTORM_CONTEXT');
    expect(volumeEntries[2]).toContain('docker.sock');
  });
});

describe('entrypoint context injection', () => {
  it('entrypoint script reads from /sandstorm-context directory', () => {
    const entrypoint = fs.readFileSync(
      path.join(__dirname, '../../sandstorm-cli/docker/entrypoint.sh'),
      'utf-8'
    );

    // Should check for /sandstorm-context directory
    expect(entrypoint).toContain('/sandstorm-context');
    // Should look for .md files
    expect(entrypoint).toContain('/sandstorm-context/*.md');
    // Should append to CLAUDE.md
    expect(entrypoint).toContain('/home/claude/.claude/CLAUDE.md');
  });

  it('entrypoint appends per-project context header before context files', () => {
    const entrypoint = fs.readFileSync(
      path.join(__dirname, '../../sandstorm-cli/docker/entrypoint.sh'),
      'utf-8'
    );

    // Should add a "Per-Project Context" header
    expect(entrypoint).toContain('# Per-Project Context');
  });

  it('entrypoint iterates over all .md files in context directory', () => {
    const entrypoint = fs.readFileSync(
      path.join(__dirname, '../../sandstorm-cli/docker/entrypoint.sh'),
      'utf-8'
    );

    // Should loop over all .md files and cat them into CLAUDE.md
    expect(entrypoint).toMatch(/for ctx in \/sandstorm-context\/\*\.md/);
    expect(entrypoint).toMatch(/cat "\$ctx"/);
  });
});

describe('run_compose sets SANDSTORM_CONTEXT env var', () => {
  it('stack.sh run_compose function exports SANDSTORM_CONTEXT', () => {
    const stackScript = fs.readFileSync(
      path.join(__dirname, '../../sandstorm-cli/lib/stack.sh'),
      'utf-8'
    );

    // run_compose should set SANDSTORM_CONTEXT pointing to .sandstorm/context
    expect(stackScript).toContain('SANDSTORM_CONTEXT=');
    expect(stackScript).toContain('.sandstorm/context');
  });

  it('stack.sh ensures context directory exists before compose', () => {
    const stackScript = fs.readFileSync(
      path.join(__dirname, '../../sandstorm-cli/lib/stack.sh'),
      'utf-8'
    );

    // run_compose should mkdir the context dir (compose volume mount requires it)
    expect(stackScript).toContain('mkdir -p "$context_dir"');
  });
});

describe('custom-context module', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandstorm-customctx-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saveCustomInstructions creates instructions.md in .sandstorm/context/', async () => {
    const { saveCustomInstructions } = await import('../../src/main/custom-context');

    // Create the .sandstorm directory (ensureGitignored requires it)
    fs.mkdirSync(path.join(tmpDir, '.sandstorm'), { recursive: true });

    saveCustomInstructions(tmpDir, 'Always write tests first.');

    const filePath = path.join(tmpDir, '.sandstorm', 'context', 'instructions.md');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('Always write tests first.');
  });

  it('getCustomContext returns empty instructions when no file exists', async () => {
    const { getCustomContext } = await import('../../src/main/custom-context');

    const ctx = getCustomContext(tmpDir);
    expect(ctx.instructions).toBe('');
  });

  it('getCustomContext returns instructions when file exists', async () => {
    const { saveCustomInstructions, getCustomContext } = await import('../../src/main/custom-context');

    fs.mkdirSync(path.join(tmpDir, '.sandstorm'), { recursive: true });
    saveCustomInstructions(tmpDir, 'Use TypeScript strict mode.');

    const ctx = getCustomContext(tmpDir);
    expect(ctx.instructions).toBe('Use TypeScript strict mode.');
  });
});
