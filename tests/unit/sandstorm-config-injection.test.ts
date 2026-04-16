import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('stack.sh .sandstorm/ config injection', () => {
  const stackShPath = resolve(__dirname, '../../sandstorm-cli/lib/stack.sh');
  const stackSh = readFileSync(stackShPath, 'utf-8');

  it('injects verify.sh into workspace .sandstorm/', () => {
    expect(stackSh).toContain('verify.sh');
    expect(stackSh).toContain('SANDSTORM_INJECT_ITEMS');
  });

  it('injects review-prompt.md into workspace .sandstorm/', () => {
    expect(stackSh).toContain('review-prompt.md');
  });

  it('injects docker-compose.yml into workspace .sandstorm/', () => {
    // The injected docker-compose.yml is the sandstorm one, not the project one
    expect(stackSh).toContain('SANDSTORM_INJECT_ITEMS');
    expect(stackSh).toMatch(/SANDSTORM_INJECT_ITEMS=.*docker-compose\.yml/);
  });

  it('injects scripts/ directory recursively', () => {
    expect(stackSh).toMatch(/SANDSTORM_INJECT_ITEMS=.*scripts/);
    expect(stackSh).toContain('cp -r');
  });

  it('injects context/ directory recursively', () => {
    expect(stackSh).toMatch(/SANDSTORM_INJECT_ITEMS=.*context/);
  });

  it('injects spec-quality-gate.md', () => {
    expect(stackSh).toMatch(/SANDSTORM_INJECT_ITEMS=.*spec-quality-gate\.md/);
  });

  it('injects config file', () => {
    expect(stackSh).toMatch(/SANDSTORM_INJECT_ITEMS=.*\bconfig\b/);
  });

  it('does NOT inject workspaces/ directory', () => {
    // workspaces/ is workspace-specific and must not be copied
    expect(stackSh).not.toMatch(/SANDSTORM_INJECT_ITEMS=.*workspaces/);
  });

  it('does NOT inject stacks/ directory', () => {
    // stacks/ is workspace-specific and must not be copied
    expect(stackSh).not.toMatch(/SANDSTORM_INJECT_ITEMS=.*\bstacks\b/);
  });

  it('skips missing files silently (uses -e check and || true)', () => {
    // Should use [ -e "$src" ] to check existence before copying
    expect(stackSh).toContain('[ -e "$src" ]');
    // Should suppress errors from cp
    expect(stackSh).toMatch(/cp -r.*\|\| true/);
  });

  it('creates .sandstorm directory in workspace before copying', () => {
    expect(stackSh).toContain('mkdir -p "$WORKSPACE/.sandstorm"');
  });

  it('copies from $PROJECT_ROOT/.sandstorm/ as source', () => {
    expect(stackSh).toContain('$PROJECT_ROOT/.sandstorm/');
  });

  it('only injects on initial clone (inside the "if no .git" block)', () => {
    // The injection must be inside the workspace clone block
    // Verify the structure: injection code appears between clone_workspace call and port remapping
    const cloneBlock = stackSh.match(
      /if \[ ! -d "\$WORKSPACE\/\.git" \]([\s\S]*?)fi\s*\n\s*#\s*Make workspace world-readable/
    );
    expect(cloneBlock).not.toBeNull();
    expect(cloneBlock![1]).toContain('SANDSTORM_INJECT_ITEMS');
  });
});
