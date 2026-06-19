import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getDefaultSpecQualityGate } from '../../src/main/spec-quality-gate';

describe('getDefaultSpecQualityGate', () => {
  it('returns non-empty built-in content', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toBeTruthy();
    expect(content.length).toBeGreaterThan(100);
  });

  it('includes all required criteria sections', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('### Problem Statement');
    expect(content).toContain('### Current vs Desired Behavior');
    expect(content).toContain('### Scope Boundaries');
    expect(content).toContain('### Migration Path');
    expect(content).toContain('### Edge Cases');
    expect(content).toContain('### Ambiguity Check');
    expect(content).toContain('### Testability');
    expect(content).toContain('### Files/Areas Affected');
    expect(content).toContain('### Assumptions');
  });

  it('includes assumption resolution criterion', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('### Assumptions — Zero Unresolved');
    expect(content).toContain('Assumptions are ambiguity');
    expect(content).toContain('MUST NOT pass while any assumption is *unresolved*');
  });

  it('includes dependency contracts criterion', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('### Dependency Contracts');
    expect(content).toContain('data contract must be explicit');
    expect(content).toContain('Read/write timing');
  });

  it('includes enforced-artifact requirement in dependency contracts', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('must resolve to an enforced artifact');
    expect(content).toContain('not prose');
  });

  it('includes contribution-to-the-whole criterion', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('### Contribution to the Whole');
    expect(content).toContain('epic-level acceptance behavior');
  });

  it('includes intent congruence criterion', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('### Intent Congruence');
    expect(content).toContain('undercuts');
  });

  it('edge cases criterion includes idempotency lens', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('Idempotency');
    expect(content).toMatch(/runs twice|idempotency/i);
  });

  it('new criteria do not reintroduce e2e/visual verification', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).not.toContain('### End-to-End Data Flow Verification');
    expect(content).not.toContain('### Automated Visual Verification');
  });

  it('includes all-verification-automatable criterion', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('### All Verification Must Be Automatable');
    expect(content).toContain('No "manually verify"');
    expect(content).toContain('eliminate manual steps entirely');
  });

  it('includes verify-before-asking criterion', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('### Verify Before Asking');
    expect(content).toContain('file:line');
  });

  it('includes the Decision Altitude section with the altitude filter', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('## Decision Altitude');
    expect(content).toContain(
      'a different answer would change observable behavior, system architecture,',
    );
    // Non-asking examples are enumerated as decide-and-record.
    expect(content).toContain('symbol / variable naming');
    expect(content).toContain('non-behavioral constants');
  });

  it('Assumptions criterion defines all three resolution types', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('three** legal resolutions');
    expect(content).toContain('**Verified fact**');
    expect(content).toContain('**Decision-significant question**');
    expect(content).toContain('**Decided-and-recorded**');
    // Decided-and-recorded still counts as resolved (pin-everything invariant).
    expect(content).toContain('"Decided-and-recorded" counts as resolved');
  });

  it('includes the Epic Context — treat as givens criterion', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('### Epic Context — treat as givens');
    expect(content).toContain('already-decided given');
    expect(content).toContain('MUST NOT surface a question whose answer is already in the epic context');
  });

  it('starts with a markdown heading', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toMatch(/^# Spec Quality Gate/);
  });

  it('does NOT include End-to-End Data Flow Verification criterion', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).not.toContain('### End-to-End Data Flow Verification');
    expect(content).not.toContain('entire pipeline without mocks');
  });

  it('does NOT include Automated Visual Verification criterion', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).not.toContain('### Automated Visual Verification (UI Tickets)');
    expect(content).not.toContain('not mocked component renders');
  });

  it('includes mandatory automated testing policy', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('Automated testing is **mandatory and assumed**');
    expect(content).toContain('MUST NOT ask');
    expect(content).toContain('npm run typecheck');
    expect(content).toContain('.sandstorm/verify.sh');
  });

  it('explicitly disallows e2e/Playwright requirement', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('e2e / Playwright / visual browser verification is **not required**');
    expect(content).toContain('Do NOT fail the gate because e2e tests are absent');
  });

  it('specifies Vitest as the test framework', () => {
    const content = getDefaultSpecQualityGate();
    expect(content).toContain('Vitest');
  });

  it('is the single source of truth (no file read in built-in content)', () => {
    const content = getDefaultSpecQualityGate();
    // The built-in gate never reads a file — it must not reference the old file path
    expect(content).not.toContain('spec-quality-gate.md');
  });
});

describe('init.sh no longer generates spec-quality-gate.md', () => {
  const initPath = path.resolve(__dirname, '../../sandstorm-cli/lib/init.sh');

  it('does not generate .sandstorm/spec-quality-gate.md during init', () => {
    const init = fs.readFileSync(initPath, 'utf-8');
    expect(init).not.toContain('Created .sandstorm/spec-quality-gate.md');
    expect(init).not.toContain('spec-quality-gate.md');
  });
});

describe('skill files do not reference spec-quality-gate.md', () => {
  const skillsDir = path.resolve(__dirname, '../../sandstorm-cli/skills');

  it('sandstorm-spec-check.md does not read spec-quality-gate.md', () => {
    const content = fs.readFileSync(
      path.join(skillsDir, 'sandstorm-spec-check.md'),
      'utf-8',
    );
    expect(content).not.toContain('Read `.sandstorm/spec-quality-gate.md`');
    expect(content).not.toContain('Load the quality gate');
    expect(content).toContain('built into Sandstorm Desktop');
  });

  it('sandstorm-spec-refine.md does not read spec-quality-gate.md', () => {
    const content = fs.readFileSync(
      path.join(skillsDir, 'sandstorm-spec-refine.md'),
      'utf-8',
    );
    expect(content).not.toContain('Read `.sandstorm/spec-quality-gate.md`');
    expect(content).toContain('built into Sandstorm Desktop');
  });

  it('skill files are still user-invocable', () => {
    for (const skill of ['sandstorm-spec-check.md', 'sandstorm-spec-refine.md']) {
      const content = fs.readFileSync(path.join(skillsDir, skill), 'utf-8');
      expect(content).toContain('user_invocable: true');
    }
  });

  it('spec-check skill still includes assumption resolution phase', () => {
    const content = fs.readFileSync(
      path.join(skillsDir, 'sandstorm-spec-check.md'),
      'utf-8',
    );
    expect(content).toContain('Resolve assumptions');
    expect(content).toContain('Self-resolvable');
    expect(content).toContain('Requires human input');
    expect(content).toContain('Assumptions — Zero Unresolved');
    expect(content).toContain('Dependency Contracts');
    expect(content).toContain('Questions Requiring User Answers');
  });

  it('spec-check skill does not require e2e or automated visual verification', () => {
    const content = fs.readFileSync(
      path.join(skillsDir, 'sandstorm-spec-check.md'),
      'utf-8',
    );
    expect(content).not.toContain('Automated Visual Verification');
    expect(content).not.toContain('End-to-End Data Flow');
    expect(content).toContain('Do NOT require e2e');
  });

  it('spec-refine skill does not require e2e or automated visual verification', () => {
    const content = fs.readFileSync(
      path.join(skillsDir, 'sandstorm-spec-refine.md'),
      'utf-8',
    );
    expect(content).not.toContain('Automated Visual Verification');
    expect(content).not.toContain('End-to-End Data Flow');
    expect(content).toContain('Do NOT require e2e');
  });

  it('spec-refine skill includes enhanced evaluation checks', () => {
    const content = fs.readFileSync(
      path.join(skillsDir, 'sandstorm-spec-refine.md'),
      'utf-8',
    );
    expect(content).toContain('Resolve assumptions first');
    expect(content).toContain('Self-resolvable');
    expect(content).toContain('Zero Unresolved Assumptions');
    expect(content).toContain('Dependency Contracts');
    expect(content).toContain('All Verification Automatable');
    expect(content).toContain('Replace resolved assumptions with verified facts');
  });
});
