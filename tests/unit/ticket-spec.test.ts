import { describe, it, expect, vi } from 'vitest';
import {
  extractGateSummary,
  extractQuestions,
  shortBodyHash,
  runSpecCheck,
  runSpecRefine,
  type SpecGateDeps,
} from '../../src/main/control-plane/ticket-spec';
import type { ProjectTicketConfig } from '../../src/main/control-plane/registry';

const PASS_REPORT = `## Spec Quality Gate: PASS

### Results
| Criterion | Result | Notes |
|-----------|--------|-------|
| One | PASS | |
`;

const FAIL_REPORT = `## Spec Quality Gate: FAIL

### Questions
1. What does "fast" mean here in concrete numbers?
2. Should we cache the full body or just the hash?

### Results
| Criterion | Result |
|-----------|--------|
| Specificity | FAIL |
`;

const FAIL_REPORT_JSON = `## Spec Quality Gate: FAIL

### Questions

\`\`\`json
[
  {
    "id": "q1",
    "question": "What does fast mean?",
    "options": [
      { "id": "a", "label": "Under 100ms" },
      { "id": "b", "label": "Under 1s" }
    ]
  },
  {
    "id": "q2",
    "question": "Cache strategy?",
    "options": [
      { "id": "a", "label": "Full body" },
      { "id": "b", "label": "Hash only" }
    ]
  }
]
\`\`\`

### Results
| Criterion | Result |
|-----------|--------|
| Specificity | FAIL |
`;

const FAIL_REPORT_JSON_RECOMMENDED = `## Spec Quality Gate: FAIL

### Questions

\`\`\`json
[
  {
    "id": "q1",
    "question": "What does fast mean?",
    "options": [
      { "id": "a", "label": "Under 100ms", "recommended": true },
      { "id": "b", "label": "Under 1s" }
    ]
  },
  {
    "id": "q2",
    "question": "Cache strategy?",
    "options": [
      { "id": "a", "label": "Full body" },
      { "id": "b", "label": "Hash only", "recommended": true }
    ]
  }
]
\`\`\`

### Results
| Criterion | Result |
|-----------|--------|
| Specificity | FAIL |
`;

const FAIL_REPORT_JSON_MALFORMED_RECOMMENDED = `## Spec Quality Gate: FAIL

### Questions

\`\`\`json
[
  {
    "id": "q1",
    "question": "Cache strategy?",
    "options": [
      { "id": "a", "label": "Full body", "recommended": "true" },
      { "id": "b", "label": "Hash only", "recommended": 1 }
    ]
  }
]
\`\`\`

### Results
| Criterion | Result |
|-----------|--------|
| Specificity | FAIL |
`;

const FAIL_REPORT_JSON_MULTI_RECOMMENDED = `## Spec Quality Gate: FAIL

### Questions

\`\`\`json
[
  {
    "id": "q1",
    "question": "Pick one?",
    "options": [
      { "id": "a", "label": "Option A", "recommended": true },
      { "id": "b", "label": "Option B", "recommended": true }
    ]
  }
]
\`\`\`

### Results
| Criterion | Result |
|-----------|--------|
| Specificity | FAIL |
`;

const GITHUB_CONFIG: ProjectTicketConfig = { provider: 'github' };

function makeDeps(overrides: Partial<SpecGateDeps> = {}): SpecGateDeps {
  return {
    fetchTicket: vi.fn().mockResolvedValue('a body'),
    getProviderConfig: vi.fn().mockReturnValue(GITHUB_CONFIG),
    runCheck: vi.fn().mockResolvedValue({ passed: true, report: PASS_REPORT }),
    runRefine: vi.fn().mockResolvedValue({ passed: true, report: PASS_REPORT }),
    readSpecReadyHash: vi.fn().mockResolvedValue(''),
    readTicketUrl: vi.fn().mockResolvedValue('https://github.com/o/r/issues/1'),
    markSpecReady: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('extractGateSummary', () => {
  it('parses PASS verdict and zero questions', () => {
    expect(extractGateSummary(PASS_REPORT)).toBe('Gate=PASS, questions=0');
  });

  it('parses FAIL verdict and counts numbered questions (fallback)', () => {
    expect(extractGateSummary(FAIL_REPORT)).toBe('Gate=FAIL, questions=2');
  });

  it('parses FAIL verdict and counts JSON questions', () => {
    expect(extractGateSummary(FAIL_REPORT_JSON)).toBe('Gate=FAIL, questions=2');
  });

  it('returns empty string when report is empty', () => {
    expect(extractGateSummary('')).toBe('');
  });

  it('returns "not parsed" when verdict header is missing', () => {
    expect(extractGateSummary('## Some other section')).toBe('Gate verdict not parsed');
  });
});

describe('extractQuestions', () => {
  it('parses JSON block under a Questions heading', () => {
    const questions = extractQuestions(FAIL_REPORT_JSON);
    expect(questions).toHaveLength(2);
    expect(questions[0].id).toBe('q1');
    expect(questions[0].question).toBe('What does fast mean?');
    expect(questions[0].options).toEqual([
      { id: 'a', label: 'Under 100ms' },
      { id: 'b', label: 'Under 1s' },
    ]);
    expect(questions[1].id).toBe('q2');
    expect(questions[1].question).toBe('Cache strategy?');
  });

  it('falls back to numbered list when no JSON block (legacy)', () => {
    const questions = extractQuestions(FAIL_REPORT);
    expect(questions).toHaveLength(2);
    expect(questions[0].question).toBe('What does "fast" mean here in concrete numbers?');
    expect(questions[0].options).toEqual([]);
    expect(questions[1].question).toBe('Should we cache the full body or just the hash?');
    expect(questions[1].options).toEqual([]);
  });

  it('also captures items under a Gaps heading (fallback)', () => {
    const r = `### Gaps\n1. First gap\n2. Second gap\n## Next\n3. Outside`;
    const questions = extractQuestions(r);
    expect(questions).toHaveLength(2);
    expect(questions[0].question).toBe('First gap');
    expect(questions[1].question).toBe('Second gap');
  });

  it('also captures JSON block under a Gaps heading', () => {
    const r = `### Gaps\n\n\`\`\`json\n[{"id":"q1","question":"Gap Q?","options":[{"id":"a","label":"Yes"},{"id":"b","label":"No"}]}]\n\`\`\`\n## Next`;
    const questions = extractQuestions(r);
    expect(questions).toHaveLength(1);
    expect(questions[0].question).toBe('Gap Q?');
    expect(questions[0].options).toHaveLength(2);
  });

  it('returns empty array when no Questions/Gaps heading exists', () => {
    expect(extractQuestions(PASS_REPORT)).toEqual([]);
  });

  it('stops capturing at the next ## heading boundary (fallback)', () => {
    const r = `### Questions\n1. Inside\n## Other\n2. Outside`;
    const questions = extractQuestions(r);
    expect(questions).toHaveLength(1);
    expect(questions[0].question).toBe('Inside');
  });

  it('falls back gracefully when JSON block is malformed', () => {
    const r = `### Questions\n\`\`\`json\nnot valid json\n\`\`\``;
    expect(extractQuestions(r)).toEqual([]);
  });

  it('returns empty options array when options key is missing in JSON item', () => {
    const r = `### Questions\n\n\`\`\`json\n[{"id":"q1","question":"A question?"}]\n\`\`\``;
    const questions = extractQuestions(r);
    expect(questions).toHaveLength(1);
    expect(questions[0].options).toEqual([]);
  });

  it('preserves recommended:true flag on options', () => {
    const questions = extractQuestions(FAIL_REPORT_JSON_RECOMMENDED);
    expect(questions[0].options[0]).toEqual({ id: 'a', label: 'Under 100ms', recommended: true });
    expect(questions[0].options[1]).toEqual({ id: 'b', label: 'Under 1s' });
    expect(questions[1].options[0]).toEqual({ id: 'a', label: 'Full body' });
    expect(questions[1].options[1]).toEqual({ id: 'b', label: 'Hash only', recommended: true });
  });

  it('ignores non-boolean recommended values (string, number)', () => {
    const questions = extractQuestions(FAIL_REPORT_JSON_MALFORMED_RECOMMENDED);
    expect(questions[0].options[0]).toEqual({ id: 'a', label: 'Full body' });
    expect(questions[0].options[1]).toEqual({ id: 'b', label: 'Hash only' });
    expect(questions[0].options[0].recommended).toBeUndefined();
    expect(questions[0].options[1].recommended).toBeUndefined();
  });

  it('preserves all recommended flags when multiple options are flagged (UI applies first-only rule)', () => {
    const questions = extractQuestions(FAIL_REPORT_JSON_MULTI_RECOMMENDED);
    expect(questions[0].options[0].recommended).toBe(true);
    expect(questions[0].options[1].recommended).toBe(true);
  });

  it('options without recommended field have no recommended property', () => {
    const questions = extractQuestions(FAIL_REPORT_JSON);
    for (const q of questions) {
      for (const opt of q.options) {
        expect(opt.recommended).toBeUndefined();
      }
    }
  });
});

describe('shortBodyHash', () => {
  it('produces a 12-char hex string', () => {
    const h = shortBodyHash('hello world');
    expect(h).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic for the same input', () => {
    expect(shortBodyHash('foo')).toBe(shortBodyHash('foo'));
  });

  it('changes when the body changes', () => {
    expect(shortBodyHash('foo')).not.toBe(shortBodyHash('foo!'));
  });
});

describe('runSpecCheck', () => {
  it('returns an error when no ticket provider is configured', async () => {
    const deps = makeDeps({ getProviderConfig: vi.fn().mockReturnValue(null) });
    const result = await runSpecCheck('1', '/proj', deps);
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/No ticket provider configured/);
    expect(deps.runCheck).not.toHaveBeenCalled();
  });

  it('returns an error when the fetched body is empty', async () => {
    const deps = makeDeps({ fetchTicket: vi.fn().mockResolvedValue('') });
    const result = await runSpecCheck('1', '/proj', deps);
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/returned no output/);
    expect(deps.runCheck).not.toHaveBeenCalled();
  });

  it('short-circuits when the spec-ready label hash matches the current body', async () => {
    const body = '# Ticket body';
    const hash = shortBodyHash(body);
    const deps = makeDeps({
      fetchTicket: vi.fn().mockResolvedValue(body),
      readSpecReadyHash: vi.fn().mockResolvedValue(hash),
    });
    const result = await runSpecCheck('1', '/proj', deps);
    expect(result.passed).toBe(true);
    expect(result.cached).toBe(true);
    expect(result.gateSummary).toMatch(/cached/);
    expect(deps.runCheck).not.toHaveBeenCalled();
    expect(deps.markSpecReady).not.toHaveBeenCalled();
  });

  it('runs the check when there is no cached hash and tags the ticket on PASS', async () => {
    const body = '# Ticket body';
    const deps = makeDeps({ fetchTicket: vi.fn().mockResolvedValue(body) });
    const result = await runSpecCheck('1', '/proj', deps);
    expect(result.passed).toBe(true);
    expect(result.cached).toBe(false);
    expect(deps.runCheck).toHaveBeenCalledWith('1', '/proj');
    expect(deps.markSpecReady).toHaveBeenCalledWith('1', shortBodyHash(body));
  });

  it('parses gate failures into structured questions and skips the label', async () => {
    const deps = makeDeps({
      runCheck: vi.fn().mockResolvedValue({ passed: false, report: FAIL_REPORT }),
    });
    const result = await runSpecCheck('1', '/proj', deps);
    expect(result.passed).toBe(false);
    expect(result.questions).toHaveLength(2);
    expect(result.questions[0]).toMatchObject({ question: expect.any(String), options: [] });
    expect(result.gateSummary).toBe('Gate=FAIL, questions=2');
    expect(deps.markSpecReady).not.toHaveBeenCalled();
  });

  it('surfaces handler errors verbatim', async () => {
    const deps = makeDeps({
      runCheck: vi.fn().mockResolvedValue({ passed: false, error: 'No quality gate configured' }),
    });
    const result = await runSpecCheck('1', '/proj', deps);
    expect(result.passed).toBe(false);
    expect(result.error).toBe('No quality gate configured');
  });
});

describe('runSpecRefine', () => {
  it('returns an error when no ticket provider is configured', async () => {
    const deps = makeDeps({ getProviderConfig: vi.fn().mockReturnValue(null) });
    const result = await runSpecRefine('1', '/proj', 'answers', deps);
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/No ticket provider configured/);
    expect(deps.runRefine).not.toHaveBeenCalled();
  });

  it('passes user answers to the refine handler', async () => {
    const deps = makeDeps({
      runRefine: vi.fn().mockResolvedValue({ passed: true, report: PASS_REPORT }),
    });
    await runSpecRefine('1', '/proj', 'Q1: foo\nA: bar', deps);
    expect(deps.runRefine).toHaveBeenCalledWith('1', '/proj', 'Q1: foo\nA: bar');
  });

  it('re-fetches the body and tags spec-ready on PASS', async () => {
    const fresh = '# updated body';
    const fetch = vi.fn().mockResolvedValue(fresh);
    const deps = makeDeps({
      fetchTicket: fetch,
      runRefine: vi.fn().mockResolvedValue({ passed: true, report: PASS_REPORT }),
    });
    const result = await runSpecRefine('1', '/proj', 'answers', deps);
    expect(result.passed).toBe(true);
    expect(fetch).toHaveBeenCalledWith('1', '/proj');
    expect(deps.markSpecReady).toHaveBeenCalledWith('1', shortBodyHash(fresh));
  });

  it('returns parsed questions on FAIL', async () => {
    const deps = makeDeps({
      runRefine: vi.fn().mockResolvedValue({ passed: false, report: FAIL_REPORT }),
    });
    const result = await runSpecRefine('1', '/proj', 'answers', deps);
    expect(result.passed).toBe(false);
    expect(result.questions).toHaveLength(2);
    expect(result.questions[0]).toMatchObject({ question: expect.any(String), options: [] });
    expect(deps.markSpecReady).not.toHaveBeenCalled();
  });
});
