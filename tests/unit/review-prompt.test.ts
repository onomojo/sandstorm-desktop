import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getDefaultReviewPrompt } from '../../src/main/review-prompt';

describe('getDefaultReviewPrompt', () => {
  it('returns non-empty default content', () => {
    const content = getDefaultReviewPrompt();
    expect(content).toBeTruthy();
    expect(content.length).toBeGreaterThan(100);
  });

  it('starts with a markdown heading', () => {
    const content = getDefaultReviewPrompt();
    expect(content).toMatch(/^# Code Review/);
  });

  it('includes all review categories (#291/#292 strict-contract rewrite)', () => {
    const content = getDefaultReviewPrompt();
    // Post-rewrite, categories are referenced by their CODE name in the
    // output contract rather than by prose heading. Assert the codes
    // since those are the strings that guide the model's formatting.
    expect(content).toContain('SCOPE');
    expect(content).toContain('REQUIREMENTS');
    expect(content).toContain('ARCHITECTURE');
    expect(content).toContain('CORRECTNESS');
    expect(content).toContain('BUG');
    expect(content).toContain('SECURITY');
    expect(content).toContain('BEST_PRACTICE');
    expect(content).toContain('SEPARATION');
    expect(content).toContain('DRY');
    expect(content).toContain('SCALABILITY');
    expect(content).toContain('OPTIMIZATION');
    expect(content).toContain('TEST_COVERAGE');
  });

  it('includes SCOPE category for out-of-scope file enforcement (#335)', () => {
    const content = getDefaultReviewPrompt();
    expect(content).toContain('SCOPE');
    expect(content).toContain('out_of_scope:<path>');
    expect(content).toContain('Out of scope');
    expect(content).toContain('Non-goals');
    expect(content).toContain('Out-of-scope file changes are ALWAYS a fail');
  });

  it('includes REVIEW_PASS and REVIEW_FAIL sentinels', () => {
    const content = getDefaultReviewPrompt();
    expect(content).toContain('REVIEW_PASS');
    expect(content).toContain('REVIEW_FAIL');
  });

  it('forbids praise and positive summaries in the review output (#291)', () => {
    // The original 1.4M-token cascade was rooted in reviews that wrote
    // glowing summaries ("all tests pass, build is clean") without a
    // sentinel. The parser treated those as UNCLEAR → FAIL. The fix is
    // at the prompt level: the contract must explicitly ban commentary.
    const content = getDefaultReviewPrompt();
    expect(content).toMatch(/Never praise/i);
    expect(content).toMatch(/Never summarize what the code got right/i);
    expect(content).toMatch(/Never narrate your process/i);
  });

  it('enforces sentinel-as-last-line contract (#291)', () => {
    const content = getDefaultReviewPrompt();
    expect(content).toMatch(/sentinel.*MUST be the last non-empty line/i);
    expect(content).toMatch(/treated as FAIL/i);
  });

  it('removes the "acceptable observation" category — it must be FAIL or omit (#292)', () => {
    // Old prompt allowed "Explicitly stated as acceptable with a brief
    // reason". That's exactly how positive summaries leaked into
    // /tmp/claude-review-output.txt, then got fed back to the
    // execution agent as the "issues to fix" body (#292). Bad category
    // must be gone.
    const content = getDefaultReviewPrompt();
    expect(content).not.toContain('Explicitly stated as acceptable');
    expect(content).toMatch(/If you mentioned it, it's a fail/i);
  });

  it('frames the output as machine-read for the execution agent, not a human', () => {
    const content = getDefaultReviewPrompt();
    expect(content).toMatch(/machine-read/i);
    expect(content).toMatch(/execution agent/i);
  });

  it('covers the core quality signals that were BEST_PRACTICE failures pre-rewrite', () => {
    // Same quality checks — just rehoused inside the BEST_PRACTICE
    // category bullet instead of a separate section.
    const content = getDefaultReviewPrompt();
    expect(content).toContain('Redundant database');
    expect(content).toContain('Unnecessary object reloads');
    expect(content).toContain('Multiple round-trips');
    expect(content).toContain('Dead or unreachable code');
  });

  it('matches the container-side template byte-for-byte (#291)', () => {
    // Both files seed the review prompt. The .md gets baked into
    // /usr/bin/review-prompt.md in the container image; this .ts
    // seeds .sandstorm/review-prompt.md in new projects via the
    // migration modal. A drift between them means some projects get
    // the old contract and others get the new one.
    const containerTemplate = fs.readFileSync(
      path.join(__dirname, '..', '..', 'sandstorm-cli', 'docker', 'review-prompt.md'),
      'utf-8',
    );
    expect(getDefaultReviewPrompt()).toBe(containerTemplate);
  });
});


describe('review-prompt.md source file (#291/#292 strict-contract)', () => {
  const reviewPromptPath = path.resolve(__dirname, '../../sandstorm-cli/docker/review-prompt.md');

  it('contains the REVIEW_PASS and REVIEW_FAIL sentinels', () => {
    const content = fs.readFileSync(reviewPromptPath, 'utf-8');
    expect(content).toContain('REVIEW_PASS');
    expect(content).toContain('REVIEW_FAIL');
  });

  it('forbids praise, summaries of what works, and process narration', () => {
    const content = fs.readFileSync(reviewPromptPath, 'utf-8');
    expect(content).toMatch(/Never praise/i);
    expect(content).toMatch(/Never summarize what the code got right/i);
    expect(content).toMatch(/Never narrate your process/i);
  });

  it('does NOT contain the old "Explicitly stated as acceptable" escape hatch (#292)', () => {
    // That hatch was how positive review bodies leaked into
    // /tmp/claude-review-output.txt and got fed back as "issues to fix".
    const content = fs.readFileSync(reviewPromptPath, 'utf-8');
    expect(content).not.toContain('Explicitly stated as acceptable');
  });

  it('enforces sentinel-as-last-non-empty-line (#291)', () => {
    const content = fs.readFileSync(reviewPromptPath, 'utf-8');
    expect(content).toMatch(/sentinel.*MUST be the last non-empty line/i);
  });

  it('retains the best-practice quality signals under the BEST_PRACTICE category', () => {
    const content = fs.readFileSync(reviewPromptPath, 'utf-8');
    expect(content).toContain('Redundant database');
    expect(content).toContain('Unnecessary object reloads');
  });

  it('includes SCOPE category for out-of-scope file enforcement (#335)', () => {
    const content = fs.readFileSync(reviewPromptPath, 'utf-8');
    expect(content).toContain('SCOPE');
    expect(content).toContain('out_of_scope:<path>');
    expect(content).toContain('Out-of-scope file changes are ALWAYS a fail');
  });
});

describe('review-prompt.md directly-affected-test carve-out (#397)', () => {
  it('getDefaultReviewPrompt includes the directly-affected-test carve-out', () => {
    const content = getDefaultReviewPrompt();
    expect(content).toContain('directly-affected test, fixture, or caller is NOT an out-of-scope violation');
    expect(content).toContain('direct, necessary consequence');
  });

  it('review-prompt.md source includes the directly-affected-test carve-out', () => {
    const content = fs.readFileSync(
      path.resolve(__dirname, '../../sandstorm-cli/docker/review-prompt.md'),
      'utf-8',
    );
    expect(content).toContain('directly-affected test, fixture, or caller is NOT an out-of-scope violation');
    expect(content).toContain('direct, necessary consequence');
  });
});

describe('SANDSTORM_INNER.md directly-affected-test carve-out (#397)', () => {
  it('grants authority to fix directly-broken tests/callers', () => {
    const content = fs.readFileSync(
      path.resolve(__dirname, '../../sandstorm-cli/docker/SANDSTORM_INNER.md'),
      'utf-8',
    );
    expect(content).toContain('authorized — and expected — to update directly-affected tests');
    expect(content).toContain('update directly-affected tests, fixtures, and callers when your change');
  });
});

describe('task-runner.sh uses built-in default review prompt', () => {
  const taskRunnerPath = path.resolve(__dirname, '../../sandstorm-cli/docker/task-runner.sh');
  const taskRunner = fs.readFileSync(taskRunnerPath, 'utf-8');

  it('does not check for per-project review prompt', () => {
    expect(taskRunner).not.toContain('/app/.sandstorm/review-prompt.md');
  });

  it('falls back to /usr/bin/review-prompt.md as default', () => {
    expect(taskRunner).toContain('/usr/bin/review-prompt.md');
  });
});
