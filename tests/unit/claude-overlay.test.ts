import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const OVERLAY_PATH = path.join(__dirname, '../../sandstorm-cli/compose/claude-overlay.yml');
const STACK_SH_PATH = path.join(__dirname, '../../sandstorm-cli/lib/stack.sh');

describe('claude-overlay.yml', () => {
  it('exists at sandstorm-cli/compose/claude-overlay.yml', () => {
    expect(fs.existsSync(OVERLAY_PATH)).toBe(true);
  });

  it('contains the usage mount for per-ticket telemetry (regression for #582)', () => {
    const content = fs.readFileSync(OVERLAY_PATH, 'utf-8');
    expect(content).toContain(
      '${SANDSTORM_USAGE_DIR}/${SANDSTORM_STACK_ID}:/home/claude/.claude/projects'
    );
  });

  it('contains the workspace mount', () => {
    const content = fs.readFileSync(OVERLAY_PATH, 'utf-8');
    expect(content).toContain('${SANDSTORM_WORKSPACE}:/app');
  });

  it('contains the context mount as read-only', () => {
    const content = fs.readFileSync(OVERLAY_PATH, 'utf-8');
    expect(content).toContain('${SANDSTORM_CONTEXT}:/sandstorm-context:ro');
  });

  it('contains the docker.sock mount', () => {
    const content = fs.readFileSync(OVERLAY_PATH, 'utf-8');
    expect(content).toContain('/var/run/docker.sock:/var/run/docker.sock');
  });

  it('contains the healthcheck', () => {
    const content = fs.readFileSync(OVERLAY_PATH, 'utf-8');
    expect(content).toContain('test: ["CMD", "test", "-f", "/tmp/.sandstorm-ready"]');
  });

  it('uses :? guard on SANDSTORM_PROJECT_NAME to fail fast on missing variable', () => {
    const content = fs.readFileSync(OVERLAY_PATH, 'utf-8');
    expect(content).toContain('${SANDSTORM_PROJECT_NAME:?');
  });
});

describe('stack.sh overlay wiring', () => {
  it('defines CLAUDE_OVERLAY pointing at compose/claude-overlay.yml under $SANDSTORM_DIR', () => {
    const stackSh = fs.readFileSync(STACK_SH_PATH, 'utf-8');
    expect(stackSh).toContain('CLAUDE_OVERLAY="$SANDSTORM_DIR/compose/claude-overlay.yml"');
  });

  it('exports SANDSTORM_PROJECT_NAME in run_compose', () => {
    const stackSh = fs.readFileSync(STACK_SH_PATH, 'utf-8');
    expect(stackSh).toContain('SANDSTORM_PROJECT_NAME=');
  });

  it('chains -f "$CLAUDE_OVERLAY" after -f "$SANDSTORM_COMPOSE" in run_compose', () => {
    const stackSh = fs.readFileSync(STACK_SH_PATH, 'utf-8');
    const sandstormPos = stackSh.indexOf('-f "$SANDSTORM_COMPOSE"');
    const overlayPos = stackSh.indexOf('-f "$CLAUDE_OVERLAY"');
    expect(sandstormPos).toBeGreaterThan(-1);
    expect(overlayPos).toBeGreaterThan(-1);
    expect(overlayPos).toBeGreaterThan(sandstormPos);
  });
});
