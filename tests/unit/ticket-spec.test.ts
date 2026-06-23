import { describe, it, expect, vi } from 'vitest';
import {
  extractGateSummary,
  extractQuestions,
  shortBodyHash,
  runSpecCheck,
  runSpecRefine,
  finalizeSpecGatePass,
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

  it('ignores ### Gaps section entirely — returns only Questions items (regression)', () => {
    const r = `## Spec Quality Gate: FAIL\n\n### Gaps (if any)\n- [ ] Citation stale — update to line 42\n- [ ] Wrong version check — use < 24\n\n### Questions Requiring User Answers (if any)\n\n\`\`\`json\n[{"id":"q1","question":"Which approach?","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}]\n\`\`\`\n`;
    const questions = extractQuestions(r);
    // Gaps section must be completely ignored; only the JSON Questions block counts
    expect(questions).toHaveLength(1);
    expect(questions[0].question).toBe('Which approach?');
  });

  it('ignores ### Gaps section when no JSON block is present (fallback regression)', () => {
    const r = `## Spec Quality Gate: FAIL\n\n### Gaps (if any)\n- [ ] Citation stale — update to line 42\n\n## Results\n`;
    const questions = extractQuestions(r);
    // Gaps-only report yields no questions
    expect(questions).toHaveLength(0);
  });

  it('RefineQuestion has no kind field (gap concept fully removed)', () => {
    const r = `### Questions Requiring User Answers\n\n\`\`\`json\n[{"id":"q1","question":"Approach?","options":[{"id":"a","label":"A"}]}]\n\`\`\`\n`;
    const questions = extractQuestions(r);
    expect(questions).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(questions[0], 'kind')).toBe(false);
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

  it('generates + stores the contract before marking spec-ready on PASS', async () => {
    const body = '# Ticket body';
    const generateContract = vi.fn().mockResolvedValue('{"contract_version":1}');
    const storeContract = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      fetchTicket: vi.fn().mockResolvedValue(body),
      generateContract,
      storeContract,
    });
    const result = await runSpecCheck('1', '/proj', deps);
    expect(result.passed).toBe(true);
    expect(result.contractError).toBeUndefined();
    expect(generateContract).toHaveBeenCalledWith('1', '/proj', body);
    expect(storeContract).toHaveBeenCalledWith('1', '/proj', '{"contract_version":1}', shortBodyHash(body));
    expect(deps.markSpecReady).toHaveBeenCalledWith('1', shortBodyHash(body));
  });

  it('reports NOT passed with a contractError when contract generation fails (block-until-contract)', async () => {
    const body = '# Ticket body';
    const generateContract = vi.fn().mockRejectedValue(new Error('model returned non-JSON'));
    const storeContract = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      fetchTicket: vi.fn().mockResolvedValue(body),
      generateContract,
      storeContract,
    });
    const result = await runSpecCheck('1', '/proj', deps);
    expect(result.passed).toBe(false);
    expect(result.contractError).toContain('model returned non-JSON');
    expect(storeContract).not.toHaveBeenCalled();
    expect(deps.markSpecReady).not.toHaveBeenCalled();
  });

  it('includes reportText on FAIL and null on PASS', async () => {
    const failDeps = makeDeps({
      runCheck: vi.fn().mockResolvedValue({ passed: false, report: FAIL_REPORT }),
    });
    const failResult = await runSpecCheck('1', '/proj', failDeps);
    expect(failResult.reportText).toBe(FAIL_REPORT);

    const passDeps = makeDeps();
    const passResult = await runSpecCheck('1', '/proj', passDeps);
    expect(passResult.reportText).toBeNull();
  });

  it('caps reportText at 64KB', async () => {
    const longReport = `## Spec Quality Gate: FAIL\n\n` + 'x'.repeat(70 * 1024);
    const deps = makeDeps({
      runCheck: vi.fn().mockResolvedValue({ passed: false, report: longReport }),
    });
    const result = await runSpecCheck('1', '/proj', deps);
    expect(result.reportText).toBeDefined();
    expect(result.reportText!.length).toBeLessThan(longReport.length);
    expect(result.reportText).toContain('[Report truncated at 64KB]');
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

  it('includes reportText on FAIL and null on PASS (runSpecRefine)', async () => {
    const failDeps = makeDeps({
      runRefine: vi.fn().mockResolvedValue({ passed: false, report: FAIL_REPORT }),
    });
    const failResult = await runSpecRefine('1', '/proj', 'answers', failDeps);
    expect(failResult.reportText).toBe(FAIL_REPORT);

    const passDeps = makeDeps();
    const passResult = await runSpecRefine('1', '/proj', 'answers', passDeps);
    expect(passResult.reportText).toBeNull();
  });
});

describe('finalizeSpecGatePass', () => {
  const mkDeps = (over: Partial<Pick<SpecGateDeps, 'generateContract' | 'storeContract' | 'markSpecReady'>> = {}) => ({
    markSpecReady: vi.fn().mockResolvedValue(undefined),
    generateContract: vi.fn().mockResolvedValue('{"contract_version":1}'),
    storeContract: vi.fn().mockResolvedValue(undefined),
    ...over,
  });

  it('generates, stores, then marks spec-ready in order on success', async () => {
    const deps = mkDeps();
    const res = await finalizeSpecGatePass('7', '/p', 'body', 'abc123', deps);
    expect(res).toEqual({ ok: true });
    expect(deps.generateContract).toHaveBeenCalledWith('7', '/p', 'body');
    expect(deps.storeContract).toHaveBeenCalledWith('7', '/p', '{"contract_version":1}', 'abc123');
    expect(deps.markSpecReady).toHaveBeenCalledWith('7', 'abc123');
  });

  it('returns ok:false and does NOT mark spec-ready when generation throws', async () => {
    const deps = mkDeps({ generateContract: vi.fn().mockRejectedValue(new Error('boom')) });
    const res = await finalizeSpecGatePass('7', '/p', 'body', 'abc123', deps);
    expect(res).toEqual({ ok: false, error: expect.stringContaining('boom') });
    expect(deps.storeContract).not.toHaveBeenCalled();
    expect(deps.markSpecReady).not.toHaveBeenCalled();
  });

  it('returns ok:false and does NOT mark spec-ready when storage throws', async () => {
    const deps = mkDeps({ storeContract: vi.fn().mockRejectedValue(new Error('gh down')) });
    const res = await finalizeSpecGatePass('7', '/p', 'body', 'abc123', deps);
    expect(res).toEqual({ ok: false, error: expect.stringContaining('gh down') });
    expect(deps.markSpecReady).not.toHaveBeenCalled();
  });

  it('falls back to mark-spec-ready-only when contract deps are absent (legacy)', async () => {
    const markSpecReady = vi.fn().mockResolvedValue(undefined);
    const res = await finalizeSpecGatePass('7', '/p', 'body', 'abc123', { markSpecReady });
    expect(res).toEqual({ ok: true });
    expect(markSpecReady).toHaveBeenCalledWith('7', 'abc123');
  });
});
