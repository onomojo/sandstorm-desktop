import { describe, it, expect, vi } from 'vitest';
import {
  extractGateSummary,
  extractQuestions,
  shortBodyHash,
  runSpecCheck,
  runSpecRefine,
  type SpecGateDeps,
} from '../../src/main/control-plane/ticket-spec';

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

function makeDeps(overrides: Partial<SpecGateDeps> = {}): SpecGateDeps {
  return {
    fetchTicket: vi.fn().mockResolvedValue('a body'),
    scriptStatus: vi.fn().mockReturnValue('ok'),
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

  it('parses FAIL verdict and counts numbered questions', () => {
    expect(extractGateSummary(FAIL_REPORT)).toBe('Gate=FAIL, questions=2');
  });

  it('returns empty string when report is empty', () => {
    expect(extractGateSummary('')).toBe('');
  });

  it('returns "not parsed" when verdict header is missing', () => {
    expect(extractGateSummary('## Some other section')).toBe('Gate verdict not parsed');
  });
});

describe('extractQuestions', () => {
  it('pulls numbered items under a Questions heading', () => {
    expect(extractQuestions(FAIL_REPORT)).toEqual([
      'What does "fast" mean here in concrete numbers?',
      'Should we cache the full body or just the hash?',
    ]);
  });

  it('also captures items under a Gaps heading', () => {
    const r = `### Gaps\n1. First gap\n2. Second gap\n## Next\n3. Outside`;
    expect(extractQuestions(r)).toEqual(['First gap', 'Second gap']);
  });

  it('returns empty array when no Questions/Gaps heading exists', () => {
    expect(extractQuestions(PASS_REPORT)).toEqual([]);
  });

  it('stops capturing at the next ## heading boundary', () => {
    const r = `### Questions\n1. Inside\n## Other\n2. Outside`;
    expect(extractQuestions(r)).toEqual(['Inside']);
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
  it('returns an error when fetch-ticket.sh is missing', async () => {
    const deps = makeDeps({ scriptStatus: vi.fn().mockReturnValue('missing') });
    const result = await runSpecCheck('1', '/proj', deps);
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/fetch-ticket\.sh is missing/);
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
    expect(result.questions.length).toBe(2);
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
  it('passes user answers to the refine handler', async () => {
    const deps = makeDeps({
      runRefine: vi.fn().mockResolvedValue({ passed: true, report: PASS_REPORT }),
    });
    await runSpecRefine('1', '/proj', 'Q1: foo\nA: bar', deps);
    expect(deps.runRefine).toHaveBeenCalledWith('1', '/proj', 'Q1: foo\nA: bar');
  });

  it('re-fetches the body and tags spec-ready on PASS', async () => {
    const fresh = '# updated body';
    const fetch = vi.fn()
      // First call (none in refine path) — but post-PASS we re-fetch
      .mockResolvedValue(fresh);
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
    expect(result.questions.length).toBe(2);
    expect(deps.markSpecReady).not.toHaveBeenCalled();
  });
});
