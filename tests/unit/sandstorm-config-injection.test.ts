import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('stack.sh .sandstorm/ config injection', () => {
  const stackShPath = resolve(__dirname, '../../sandstorm-cli/lib/stack.sh');
  const stackSh = readFileSync(stackShPath, 'utf-8');

  it('injects verify.sh into workspace .sandstorm/', () => {
    expect(stackSh).toContain('verify.sh');
    expect(stackSh).toContain('$PROJECT_ROOT/.sandstorm/verify.sh');
    expect(stackSh).toContain('$WORKSPACE/.sandstorm/verify.sh');
  });

  it('does NOT inject other files (review-prompt.md, scripts/, context/, etc.)', () => {
    expect(stackSh).not.toContain('review-prompt.md');
    expect(stackSh).not.toContain('SANDSTORM_INJECT_ITEMS');
    expect(stackSh).not.toMatch(/cp.*\.sandstorm\/scripts/);
    expect(stackSh).not.toMatch(/cp.*\.sandstorm\/context/);
    expect(stackSh).not.toMatch(/cp.*spec-quality-gate/);
  });

  it('skips injection silently if verify.sh does not exist', () => {
    // Uses -f check before copying
    expect(stackSh).toContain('[ -f "$PROJECT_ROOT/.sandstorm/verify.sh" ]');
  });

  it('creates .sandstorm directory in workspace before copying', () => {
    expect(stackSh).toContain('mkdir -p "$WORKSPACE/.sandstorm"');
  });

  it('only injects on initial clone (inside the "if no .git" block)', () => {
    const cloneBlock = stackSh.match(
      /if \[ ! -d "\$WORKSPACE\/\.git" \]([\s\S]*?)fi\s*\n\s*#\s*Make workspace world-readable/
    );
    expect(cloneBlock).not.toBeNull();
    expect(cloneBlock![1]).toContain('verify.sh');
  });
});
