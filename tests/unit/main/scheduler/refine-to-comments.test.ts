import { describe, it, expect, vi } from 'vitest';
import {
  runRefineToComments,
  formatQuestionComment,
  isBotComment,
  getLastBotComment,
  getUserAnswersAfterBot,
  BOT_COMMENT_MARKER,
  type RefineToCommentsDeps,
} from '../../../../src/main/scheduler/refine-to-comments';
import type { TicketEntry, TicketComment } from '../../../../src/main/control-plane/ticket-comments';
import type { SpecGateResult, RefineQuestion } from '../../../../src/main/control-plane/ticket-spec';

const PASS_RESULT: SpecGateResult = {
  passed: true,
  questions: [],
  gateSummary: 'Gate=PASS, questions=0',
  ticketUrl: null,
  cached: false,
};

const FAIL_QUESTIONS: RefineQuestion[] = [
  {
    id: 'q1',
    question: 'What does "fast" mean?',
    options: [
      { id: 'a', label: 'Under 100ms' },
      { id: 'b', label: 'Under 1s' },
    ],
  },
  {
    id: 'q2',
    question: 'Which provider handles auth?',
    options: [],
  },
];

const FAIL_RESULT: SpecGateResult = {
  passed: false,
  questions: FAIL_QUESTIONS,
  gateSummary: 'Gate=FAIL, questions=2',
  ticketUrl: null,
  cached: false,
};

const TICKET: TicketEntry = { id: '42', title: 'My rough ticket', author: 'devuser' };

function makeDeps(overrides: Partial<RefineToCommentsDeps> = {}): RefineToCommentsDeps {
  return {
    listTickets: vi.fn().mockResolvedValue([TICKET]),
    listComments: vi.fn().mockResolvedValue([]),
    postComment: vi.fn().mockResolvedValue(undefined),
    addLabel: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    specCheck: vi.fn().mockResolvedValue(PASS_RESULT),
    specRefine: vi.fn().mockResolvedValue(PASS_RESULT),
    ...overrides,
  };
}

// ── Helper unit tests ────────────────────────────────────────────────────────

describe('isBotComment', () => {
  it('returns true when body contains the marker', () => {
    expect(isBotComment({ author: 'bot', body: `${BOT_COMMENT_MARKER}\nHello`, createdAt: '' })).toBe(true);
  });

  it('returns false for a regular user comment', () => {
    expect(isBotComment({ author: 'user', body: 'My answer is X', createdAt: '' })).toBe(false);
  });
});

describe('getLastBotComment', () => {
  it('returns null when no bot comments exist', () => {
    const comments: TicketComment[] = [
      { author: 'devuser', body: 'Hello', createdAt: '2026-05-01T10:00:00Z' },
    ];
    expect(getLastBotComment(comments)).toBeNull();
  });

  it('returns the last bot comment in chronological order', () => {
    const first: TicketComment = { author: 'bot', body: `${BOT_COMMENT_MARKER}\nQ1`, createdAt: '2026-05-01T10:00:00Z' };
    const second: TicketComment = { author: 'bot', body: `${BOT_COMMENT_MARKER}\nQ2`, createdAt: '2026-05-02T10:00:00Z' };
    const user: TicketComment = { author: 'devuser', body: 'My answer', createdAt: '2026-05-01T12:00:00Z' };
    expect(getLastBotComment([first, user, second])).toBe(second);
  });
});

describe('getUserAnswersAfterBot', () => {
  it('returns empty string when no user comments exist', () => {
    const botComment: TicketComment = { author: 'bot', body: `${BOT_COMMENT_MARKER}\nQ?`, createdAt: '2026-05-01T10:00:00Z' };
    expect(getUserAnswersAfterBot([], 'devuser', botComment)).toBe('');
  });

  it('returns empty string when user comment precedes bot comment', () => {
    const botComment: TicketComment = { author: 'bot', body: `${BOT_COMMENT_MARKER}\nQ?`, createdAt: '2026-05-02T10:00:00Z' };
    const userBefore: TicketComment = { author: 'devuser', body: 'Old note', createdAt: '2026-05-01T10:00:00Z' };
    expect(getUserAnswersAfterBot([userBefore, botComment], 'devuser', botComment)).toBe('');
  });

  it('returns concatenated answers from user comments after bot comment', () => {
    const botComment: TicketComment = { author: 'bot', body: `${BOT_COMMENT_MARKER}\nQ?`, createdAt: '2026-05-01T10:00:00Z' };
    const ans1: TicketComment = { author: 'devuser', body: 'Answer one', createdAt: '2026-05-02T10:00:00Z' };
    const ans2: TicketComment = { author: 'devuser', body: 'Answer two', createdAt: '2026-05-03T10:00:00Z' };
    const result = getUserAnswersAfterBot([botComment, ans1, ans2], 'devuser', botComment);
    expect(result).toBe('Answer one\n\nAnswer two');
  });

  it('ignores comments from other users', () => {
    const botComment: TicketComment = { author: 'bot', body: `${BOT_COMMENT_MARKER}\nQ?`, createdAt: '2026-05-01T10:00:00Z' };
    const other: TicketComment = { author: 'otheruser', body: 'Other person comment', createdAt: '2026-05-02T10:00:00Z' };
    expect(getUserAnswersAfterBot([botComment, other], 'devuser', botComment)).toBe('');
  });

  it('includes all user comments when no bot comment exists (first pass)', () => {
    const userComment: TicketComment = { author: 'devuser', body: 'Initial clarification', createdAt: '2026-05-01T10:00:00Z' };
    expect(getUserAnswersAfterBot([userComment], 'devuser', null)).toBe('Initial clarification');
  });
});

describe('formatQuestionComment', () => {
  const questions: RefineQuestion[] = [
    { id: 'q1', question: 'What is X?', options: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }] },
    { id: 'q2', question: 'Why Y?', options: [] },
  ];

  it('includes the bot marker', () => {
    const result = formatQuestionComment(questions, 'Gate=FAIL, questions=2');
    expect(result).toContain(BOT_COMMENT_MARKER);
  });

  it('formats questions as numbered list', () => {
    const result = formatQuestionComment(questions, '');
    expect(result).toContain('1. What is X?');
    expect(result).toContain('2. Why Y?');
  });

  it('renders options as lettered markdown sub-items', () => {
    const result = formatQuestionComment(questions, '');
    expect(result).toContain('   - A) Option A');
    expect(result).toContain('   - B) Option B');
  });

  it('does not emit option lines when a question has no options', () => {
    const noOpts: RefineQuestion[] = [{ id: 'q1', question: 'Open ended?', options: [] }];
    const result = formatQuestionComment(noOpts, '');
    expect(result).toContain('1. Open ended?');
    expect(result).not.toContain('   - A)');
  });

  it('includes gate summary when provided', () => {
    const single: RefineQuestion[] = [{ id: 'q1', question: 'Q', options: [] }];
    const result = formatQuestionComment(single, 'Gate=FAIL, questions=1');
    expect(result).toContain('Gate=FAIL, questions=1');
  });
});

// ── Integration tests ────────────────────────────────────────────────────────

describe('runRefineToComments — first pass, no comments', () => {
  it('runs spec check and posts questions when gate fails', async () => {
    const deps = makeDeps({
      specCheck: vi.fn().mockResolvedValue(FAIL_RESULT),
    });
    const result = await runRefineToComments('/proj', 'needs-spec', deps);
    expect(deps.specCheck).toHaveBeenCalledWith('42', '/proj');
    expect(deps.postComment).toHaveBeenCalledOnce();
    const [id, , body] = (deps.postComment as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(id).toBe('42');
    expect(body).toContain(BOT_COMMENT_MARKER);
    expect(body).toContain('What does "fast" mean?');
    expect(result).toEqual({ processed: 1, passed: 0, failed: 1 });
  });

  it('swaps labels when gate passes on first check', async () => {
    const deps = makeDeps({ specCheck: vi.fn().mockResolvedValue(PASS_RESULT) });
    const result = await runRefineToComments('/proj', 'needs-spec', deps);
    expect(deps.addLabel).toHaveBeenCalledWith('42', '/proj', 'spec-ready');
    expect(deps.removeLabel).toHaveBeenCalledWith('42', '/proj', 'needs-spec');
    expect(deps.postComment).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 1, passed: 1, failed: 0 });
  });

  it('adds spec-ready before removing needs-spec (Gap B swap order)', async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      specCheck: vi.fn().mockResolvedValue(PASS_RESULT),
      addLabel: vi.fn().mockImplementation(async () => { calls.push('add'); }),
      removeLabel: vi.fn().mockImplementation(async () => { calls.push('remove'); }),
    });
    await runRefineToComments('/proj', 'needs-spec', deps);
    expect(calls).toEqual(['add', 'remove']);
  });
});

describe('runRefineToComments — subsequent fire, unanswered', () => {
  it('is a no-op when bot has posted but user has not answered', async () => {
    const botComment: TicketComment = {
      author: 'bot',
      body: `${BOT_COMMENT_MARKER}\n## Spec Review\n1. What does X mean?`,
      createdAt: '2026-05-01T10:00:00Z',
    };
    const deps = makeDeps({
      listComments: vi.fn().mockResolvedValue([botComment]),
    });
    const result = await runRefineToComments('/proj', 'needs-spec', deps);
    expect(deps.specCheck).not.toHaveBeenCalled();
    expect(deps.specRefine).not.toHaveBeenCalled();
    expect(deps.postComment).not.toHaveBeenCalled();
    expect(deps.addLabel).not.toHaveBeenCalled();
    // processed=1, but neither passed nor failed
    expect(result).toEqual({ processed: 1, passed: 0, failed: 0 });
  });
});

describe('runRefineToComments — fold-in with user answer', () => {
  it('runs refiner with user answers and swaps labels when gate passes', async () => {
    const botComment: TicketComment = {
      author: 'bot',
      body: `${BOT_COMMENT_MARKER}\n1. Q?`,
      createdAt: '2026-05-01T10:00:00Z',
    };
    const userAnswer: TicketComment = {
      author: 'devuser',
      body: 'My answer to Q',
      createdAt: '2026-05-02T10:00:00Z',
    };
    const deps = makeDeps({
      listComments: vi.fn().mockResolvedValue([botComment, userAnswer]),
      specRefine: vi.fn().mockResolvedValue(PASS_RESULT),
    });
    const result = await runRefineToComments('/proj', 'needs-spec', deps);
    expect(deps.specRefine).toHaveBeenCalledWith('42', '/proj', 'My answer to Q');
    expect(deps.addLabel).toHaveBeenCalledWith('42', '/proj', 'spec-ready');
    expect(deps.removeLabel).toHaveBeenCalledWith('42', '/proj', 'needs-spec');
    expect(result).toEqual({ processed: 1, passed: 1, failed: 0 });
  });

  it('posts new question comment when refiner still fails', async () => {
    const botComment: TicketComment = {
      author: 'bot',
      body: `${BOT_COMMENT_MARKER}\n1. Q?`,
      createdAt: '2026-05-01T10:00:00Z',
    };
    const userAnswer: TicketComment = {
      author: 'devuser',
      body: 'Partial answer',
      createdAt: '2026-05-02T10:00:00Z',
    };
    const deps = makeDeps({
      listComments: vi.fn().mockResolvedValue([botComment, userAnswer]),
      specRefine: vi.fn().mockResolvedValue(FAIL_RESULT),
    });
    const result = await runRefineToComments('/proj', 'needs-spec', deps);
    expect(deps.postComment).toHaveBeenCalledOnce();
    const body = (deps.postComment as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(body).toContain(BOT_COMMENT_MARKER);
    expect(result).toEqual({ processed: 1, passed: 0, failed: 1 });
  });
});

describe('runRefineToComments — error handling', () => {
  it('returns empty result when listTickets fails', async () => {
    const deps = makeDeps({
      listTickets: vi.fn().mockRejectedValue(new Error('gh: not authenticated')),
    });
    const result = await runRefineToComments('/proj', 'needs-spec', deps);
    expect(result).toEqual({ processed: 0, passed: 0, failed: 0 });
  });

  it('counts per-ticket error as failed and continues to next ticket', async () => {
    const ticket2: TicketEntry = { id: '99', title: 'Second', author: 'devuser' };
    const deps = makeDeps({
      listTickets: vi.fn().mockResolvedValue([TICKET, ticket2]),
      specCheck: vi
        .fn()
        .mockRejectedValueOnce(new Error('LLM timeout'))
        .mockResolvedValueOnce(PASS_RESULT),
    });
    const result = await runRefineToComments('/proj', 'needs-spec', deps);
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.passed).toBe(1);
  });

  it('counts spec result with error field as thrown error (failed)', async () => {
    const errorResult: SpecGateResult = {
      passed: false,
      questions: [],
      gateSummary: '',
      ticketUrl: null,
      cached: false,
      error: 'fetch-ticket.sh is missing',
    };
    const deps = makeDeps({ specCheck: vi.fn().mockResolvedValue(errorResult) });
    const result = await runRefineToComments('/proj', 'needs-spec', deps);
    expect(result.failed).toBe(1);
    expect(deps.postComment).not.toHaveBeenCalled();
  });

  it('non-author comments are ignored when filtering answers', async () => {
    const botComment: TicketComment = {
      author: 'bot',
      body: `${BOT_COMMENT_MARKER}\n1. Q?`,
      createdAt: '2026-05-01T10:00:00Z',
    };
    const otherUser: TicketComment = {
      author: 'nottheauthor',
      body: 'I can answer this!',
      createdAt: '2026-05-02T10:00:00Z',
    };
    const deps = makeDeps({
      listComments: vi.fn().mockResolvedValue([botComment, otherUser]),
    });
    const result = await runRefineToComments('/proj', 'needs-spec', deps);
    // otherUser's comment doesn't count — treated as unanswered → no-op
    expect(deps.specRefine).not.toHaveBeenCalled();
    expect(deps.specCheck).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 1, passed: 0, failed: 0 });
  });

  it('returns empty result when no tickets match the label', async () => {
    const deps = makeDeps({ listTickets: vi.fn().mockResolvedValue([]) });
    const result = await runRefineToComments('/proj', 'needs-spec', deps);
    expect(result).toEqual({ processed: 0, passed: 0, failed: 0 });
  });
});
