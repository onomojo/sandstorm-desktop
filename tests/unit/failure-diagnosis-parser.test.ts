import { describe, it, expect } from 'vitest';
import { parseDiagnosticOutput } from '../../src/main/control-plane/failure-diagnosis';

const FULL_OUTPUT = `
## SUMMARY
The task failed because the review agent repeatedly flagged missing test coverage
for the new utility functions. The execution agent made partial progress but did
not add the required unit tests before the global cap was reached.

## ELIGIBILITY
selfHeal: true
answerQuestions: false
reincorporateSpec: false
`;

const OUTPUT_WITH_QUESTIONS = `
## SUMMARY
The agent hit an ambiguity about the API contract for the new endpoint.

## ELIGIBILITY
selfHeal: false
answerQuestions: true
reincorporateSpec: false

## QUESTIONS
\`\`\`json
[
  {
    "id": "q1",
    "question": "Should the endpoint return 404 or 400 for unknown IDs?",
    "options": [
      { "id": "a", "label": "404 Not Found", "recommended": true },
      { "id": "b", "label": "400 Bad Request" }
    ]
  }
]
\`\`\`
`;

const OUTPUT_REINCORPORATE = `
## SUMMARY
The spec is underspecified — the ticket lacks concrete acceptance criteria.

## ELIGIBILITY
selfHeal: false
answerQuestions: false
reincorporateSpec: true
`;

describe('parseDiagnosticOutput', () => {
  it('parses summary correctly', () => {
    const result = parseDiagnosticOutput(FULL_OUTPUT);
    expect(result.summary).toContain('missing test coverage');
  });

  it('parses selfHeal eligibility', () => {
    const result = parseDiagnosticOutput(FULL_OUTPUT);
    expect(result.eligibility.selfHeal).toBe(true);
    expect(result.eligibility.answerQuestions).toBe(false);
    expect(result.eligibility.reincorporateSpec).toBe(false);
  });

  it('parses reincorporateSpec eligibility', () => {
    const result = parseDiagnosticOutput(OUTPUT_REINCORPORATE);
    expect(result.eligibility.reincorporateSpec).toBe(true);
    expect(result.eligibility.selfHeal).toBe(false);
  });

  it('parses questions from JSON block', () => {
    const result = parseDiagnosticOutput(OUTPUT_WITH_QUESTIONS);
    expect(result.eligibility.answerQuestions).toBe(true);
    expect(result.questions).toBeDefined();
    expect(result.questions).toHaveLength(1);
    expect(result.questions![0].id).toBe('q1');
    expect(result.questions![0].question).toContain('404 or 400');
    expect(result.questions![0].options).toHaveLength(2);
    expect(result.questions![0].options[0].recommended).toBe(true);
  });

  it('does not include questions when answerQuestions is false', () => {
    const result = parseDiagnosticOutput(FULL_OUTPUT);
    expect(result.questions).toBeUndefined();
  });

  it('does not include questions when section is missing', () => {
    const result = parseDiagnosticOutput(OUTPUT_REINCORPORATE);
    expect(result.questions).toBeUndefined();
  });

  it('returns all-false eligibility for empty/malformed output', () => {
    const result = parseDiagnosticOutput('');
    expect(result.eligibility.selfHeal).toBe(false);
    expect(result.eligibility.answerQuestions).toBe(false);
    expect(result.eligibility.reincorporateSpec).toBe(false);
    expect(result.summary).toBe('');
  });

  it('does NOT depend on timeline — timeline is not in agent output', () => {
    const result = parseDiagnosticOutput(FULL_OUTPUT);
    expect('timeline' in result).toBe(false);
  });

  it('falls back to legacy numbered list parser when no JSON block in QUESTIONS', () => {
    const legacyOutput = `
## SUMMARY
Some issue.

## ELIGIBILITY
selfHeal: false
answerQuestions: true
reincorporateSpec: false

## QUESTIONS
1. What is the correct return type?
2. Should we use async or sync?
`;
    const result = parseDiagnosticOutput(legacyOutput);
    expect(result.questions).toHaveLength(2);
    expect(result.questions![0].question).toContain('return type');
    expect(result.questions![1].question).toContain('async or sync');
  });
});
