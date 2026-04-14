import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getDefaultReviewPrompt,
  getReviewPrompt,
  saveReviewPrompt,
  isReviewPromptMissing,
  ensureReviewPrompt,
} from '../../src/main/review-prompt';

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

  it('includes all review categories', () => {
    const content = getDefaultReviewPrompt();
    expect(content).toContain('Requirements compliance');
    expect(content).toContain('Architecture');
    expect(content).toContain('Best practices');
    expect(content).toContain('Separation of concerns');
    expect(content).toContain('DRY');
    expect(content).toContain('Security');
    expect(content).toContain('Scalability');
    expect(content).toContain('Test coverage');
  });

  it('includes REVIEW_PASS and REVIEW_FAIL verdict markers', () => {
    const content = getDefaultReviewPrompt();
    expect(content).toContain('REVIEW_PASS');
    expect(content).toContain('REVIEW_FAIL');
  });

  it('does NOT contain the old "lean toward REVIEW_PASS" escape hatch', () => {
    const content = getDefaultReviewPrompt();
    expect(content).not.toContain("If you're unsure whether something is an issue, lean toward REVIEW_PASS and mention it as a note");
  });

  it('contains the new strict guidance for obvious fixes', () => {
    const content = getDefaultReviewPrompt();
    expect(content).toContain('If you identified a problem and the fix is obvious');
    expect(content).toContain('it is a REVIEW_FAIL, not a note');
  });

  it('includes code quality guidance as BEST_PRACTICE failures', () => {
    const content = getDefaultReviewPrompt();
    expect(content).toContain('Code quality is a review criterion');
    expect(content).toContain('Redundant database calls');
    expect(content).toContain('Unnecessary object reloads');
    expect(content).toContain('trivially simplified');
    expect(content).toContain('"Functionally correct" is necessary but not sufficient');
  });

  it('requires categorization of all findings', () => {
    const content = getDefaultReviewPrompt();
    expect(content).toContain('Categorize all findings');
    expect(content).toContain('REVIEW_FAIL issue');
    expect(content).toContain('Explicitly stated as acceptable');
    expect(content).toContain('Do not leave unclassified observations');
  });
});

describe('getReviewPrompt', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-prompt-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty string when file does not exist', () => {
    expect(getReviewPrompt(tmpDir)).toBe('');
  });

  it('returns file content when file exists', () => {
    const sandstormDir = path.join(tmpDir, '.sandstorm');
    fs.mkdirSync(sandstormDir, { recursive: true });
    fs.writeFileSync(
      path.join(sandstormDir, 'review-prompt.md'),
      '# Custom Review\n\nCustom criteria here.\n',
    );
    const result = getReviewPrompt(tmpDir);
    expect(result).toBe('# Custom Review\n\nCustom criteria here.\n');
  });
});

describe('saveReviewPrompt', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-prompt-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the file in .sandstorm/', () => {
    fs.mkdirSync(path.join(tmpDir, '.sandstorm'), { recursive: true });
    saveReviewPrompt(tmpDir, '# My Prompt\n');
    const content = fs.readFileSync(
      path.join(tmpDir, '.sandstorm', 'review-prompt.md'),
      'utf-8',
    );
    expect(content).toBe('# My Prompt\n');
  });

  it('creates .sandstorm directory if it does not exist', () => {
    saveReviewPrompt(tmpDir, '# My Prompt\n');
    expect(
      fs.existsSync(path.join(tmpDir, '.sandstorm', 'review-prompt.md')),
    ).toBe(true);
  });

  it('overwrites existing content', () => {
    const sandstormDir = path.join(tmpDir, '.sandstorm');
    fs.mkdirSync(sandstormDir, { recursive: true });
    fs.writeFileSync(
      path.join(sandstormDir, 'review-prompt.md'),
      '# Old\n',
    );
    saveReviewPrompt(tmpDir, '# New\n');
    const content = fs.readFileSync(
      path.join(sandstormDir, 'review-prompt.md'),
      'utf-8',
    );
    expect(content).toBe('# New\n');
  });
});

describe('isReviewPromptMissing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-prompt-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when project is not initialized', () => {
    expect(isReviewPromptMissing(tmpDir)).toBe(false);
  });

  it('returns true when initialized but review prompt file missing', () => {
    const sandstormDir = path.join(tmpDir, '.sandstorm');
    fs.mkdirSync(sandstormDir, { recursive: true });
    fs.writeFileSync(path.join(sandstormDir, 'config'), 'PROJECT_NAME=test\n');
    expect(isReviewPromptMissing(tmpDir)).toBe(true);
  });

  it('returns false when initialized and review prompt file exists', () => {
    const sandstormDir = path.join(tmpDir, '.sandstorm');
    fs.mkdirSync(sandstormDir, { recursive: true });
    fs.writeFileSync(path.join(sandstormDir, 'config'), 'PROJECT_NAME=test\n');
    fs.writeFileSync(
      path.join(sandstormDir, 'review-prompt.md'),
      '# Review\n',
    );
    expect(isReviewPromptMissing(tmpDir)).toBe(false);
  });
});

describe('ensureReviewPrompt', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-prompt-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates default review prompt file when missing in initialized project', () => {
    const sandstormDir = path.join(tmpDir, '.sandstorm');
    fs.mkdirSync(sandstormDir, { recursive: true });
    fs.writeFileSync(path.join(sandstormDir, 'config'), 'PROJECT_NAME=test\n');

    const created = ensureReviewPrompt(tmpDir);
    expect(created).toBe(true);

    const content = fs.readFileSync(
      path.join(sandstormDir, 'review-prompt.md'),
      'utf-8',
    );
    expect(content).toContain('# Code Review');
    expect(content).toContain('REVIEW_PASS');
  });

  it('returns false when review prompt file already exists', () => {
    const sandstormDir = path.join(tmpDir, '.sandstorm');
    fs.mkdirSync(sandstormDir, { recursive: true });
    fs.writeFileSync(path.join(sandstormDir, 'config'), 'PROJECT_NAME=test\n');
    fs.writeFileSync(
      path.join(sandstormDir, 'review-prompt.md'),
      '# Custom\n',
    );

    const created = ensureReviewPrompt(tmpDir);
    expect(created).toBe(false);

    // Verify it didn't overwrite custom content
    const content = fs.readFileSync(
      path.join(sandstormDir, 'review-prompt.md'),
      'utf-8',
    );
    expect(content).toBe('# Custom\n');
  });

  it('returns false when project is not initialized', () => {
    const created = ensureReviewPrompt(tmpDir);
    expect(created).toBe(false);
  });
});

describe('review-prompt.md source file', () => {
  const reviewPromptPath = path.resolve(__dirname, '../../sandstorm-cli/docker/review-prompt.md');

  it('does NOT contain the old "lean toward REVIEW_PASS" escape hatch', () => {
    const content = fs.readFileSync(reviewPromptPath, 'utf-8');
    expect(content).not.toContain("If you're unsure whether something is an issue, lean toward REVIEW_PASS and mention it as a note");
  });

  it('contains the new strict guidance for obvious fixes', () => {
    const content = fs.readFileSync(reviewPromptPath, 'utf-8');
    expect(content).toContain('If you identified a problem and the fix is obvious');
  });

  it('contains code quality guidance', () => {
    const content = fs.readFileSync(reviewPromptPath, 'utf-8');
    expect(content).toContain('Code quality is a review criterion');
    expect(content).toContain('Redundant database calls');
  });

  it('requires categorization of all findings', () => {
    const content = fs.readFileSync(reviewPromptPath, 'utf-8');
    expect(content).toContain('Categorize all findings');
  });
});

describe('init.sh generates review-prompt.md', () => {
  const initPath = path.resolve(__dirname, '../../sandstorm-cli/lib/init.sh');

  it('generates .sandstorm/review-prompt.md during init', () => {
    const init = fs.readFileSync(initPath, 'utf-8');
    expect(init).toContain('review-prompt.md');
    expect(init).toContain('Created .sandstorm/review-prompt.md');
  });

  it('includes the updated review prompt content in init.sh', () => {
    const init = fs.readFileSync(initPath, 'utf-8');
    expect(init).toContain('Code quality is a review criterion');
    expect(init).toContain('Categorize all findings');
    expect(init).not.toContain("If you're unsure whether something is an issue, lean toward REVIEW_PASS and mention it as a note");
  });
});

describe('task-runner.sh per-project review prompt', () => {
  const taskRunnerPath = path.resolve(__dirname, '../../sandstorm-cli/docker/task-runner.sh');
  const taskRunner = fs.readFileSync(taskRunnerPath, 'utf-8');

  it('checks for per-project review prompt at /app/.sandstorm/review-prompt.md', () => {
    expect(taskRunner).toContain('/app/.sandstorm/review-prompt.md');
  });

  it('uses per-project review prompt when it exists and is non-empty', () => {
    expect(taskRunner).toContain('Using per-project review prompt');
  });

  it('warns and falls back when per-project review prompt is empty', () => {
    expect(taskRunner).toContain('exists but is empty');
    expect(taskRunner).toContain('falling back to built-in default');
  });

  it('falls back to /usr/bin/review-prompt.md as default', () => {
    expect(taskRunner).toContain('/usr/bin/review-prompt.md');
  });
});
