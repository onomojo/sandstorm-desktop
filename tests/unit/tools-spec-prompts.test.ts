import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../src/main/index', () => ({
  stackManager: {},
  agentBackend: {
    runEphemeralAgent: vi.fn(),
    spawnEphemeralAgent: vi.fn(),
    spawnEphemeralSession: vi.fn(),
  },
  registry: {
    getProjectTicketConfig: vi.fn(),
  },
}));

vi.mock('../../src/main/control-plane/ticket-config', () => ({
  fetchTicketWithConfig: vi.fn(),
  updateTicketWithConfig: vi.fn(),
}));

vi.mock('../../src/main/control-plane/registry', () => ({}));

vi.mock('../../src/main/scheduler', () => ({
  createSchedule: vi.fn(),
  listSchedules: vi.fn(),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
}));

vi.mock('../../src/main/scheduler/scheduler-manager', () => ({
  syncAllProjectsCrontab: vi.fn(),
}));

vi.mock('../../src/main/validation', () => ({
  validateProjectDir: vi.fn().mockReturnValue(null),
}));

import {
  buildSpecCheckPrompt,
  buildSpecRefineInitialPrompt,
  buildSpecRefineAnswerPrompt,
} from '../../src/main/claude/tools';
import { getDefaultSpecQualityGate } from '../../src/main/spec-quality-gate';

const GATE = getDefaultSpecQualityGate();
const TICKET = '# Test Ticket\n\nDo something.';
const ANSWERS = 'Q1: A1\nQ2: A2';

describe('buildSpecCheckPrompt', () => {
  it('embeds the gate criteria', () => {
    const prompt = buildSpecCheckPrompt(GATE, TICKET);
    expect(prompt).toContain(GATE);
  });

  it('embeds the ticket body', () => {
    const prompt = buildSpecCheckPrompt(GATE, TICKET);
    expect(prompt).toContain(TICKET);
  });

  it('does not contain hardcoded Automated Visual Verification FAIL condition', () => {
    const prompt = buildSpecCheckPrompt(GATE, TICKET);
    // The gate may mention e2e in the "not required" context, but the prompt
    // builder must not add its own FAIL-if-no-visual-verification condition.
    expect(prompt).not.toMatch(/\*\*Automated Visual Verification\*\*:.*FAIL/);
  });

  it('does not contain hardcoded End-to-End Data Flow FAIL condition', () => {
    const prompt = buildSpecCheckPrompt(GATE, TICKET);
    expect(prompt).not.toMatch(/\*\*End-to-End Data Flow Verification\*\*:.*FAIL/);
  });

  it('does not contain hardcoded All Verification Automatable FAIL condition (in Phase 2 extra criteria)', () => {
    const prompt = buildSpecCheckPrompt(GATE, TICKET);
    // The FAIL condition for "All Verification Automatable" must come from the
    // gate content, not from a separate hardcoded Phase 2 bullet.
    expect(prompt).not.toMatch(/\*\*All Verification Automatable\*\*: FAIL if ANY verification/);
  });

  it('includes assumption resolution instruction', () => {
    const prompt = buildSpecCheckPrompt(GATE, TICKET);
    expect(prompt).toContain('Assumption Resolution');
    expect(prompt).toContain('Self-resolvable');
  });

  it('uses imperative assumption-checking wording', () => {
    const prompt = buildSpecCheckPrompt(GATE, TICKET);
    expect(prompt).toContain('Use Read/Grep/Glob now');
  });

  it('does not contain old passive assumption-checking wording', () => {
    const prompt = buildSpecCheckPrompt(GATE, TICKET);
    expect(prompt).not.toContain('state what you would check and whether the assumption appears correct or incorrect based on the information available');
  });

  it('requests a structured report with pass/fail verdict', () => {
    const prompt = buildSpecCheckPrompt(GATE, TICKET);
    expect(prompt).toContain('## Spec Quality Gate: [PASS or FAIL]');
  });
});

describe('buildSpecRefineInitialPrompt', () => {
  it('embeds the gate criteria', () => {
    const prompt = buildSpecRefineInitialPrompt(GATE, TICKET);
    expect(prompt).toContain(GATE);
  });

  it('embeds the ticket body', () => {
    const prompt = buildSpecRefineInitialPrompt(GATE, TICKET);
    expect(prompt).toContain(TICKET);
  });

  it('does not contain hardcoded Automated Visual Verification FAIL condition', () => {
    const prompt = buildSpecRefineInitialPrompt(GATE, TICKET);
    expect(prompt).not.toMatch(/\*\*Automated Visual Verification\*\*: FAIL/);
  });

  it('does not contain hardcoded End-to-End Data Flow FAIL condition', () => {
    const prompt = buildSpecRefineInitialPrompt(GATE, TICKET);
    expect(prompt).not.toMatch(/\*\*End-to-End Data Flow\*\*: FAIL/);
  });

  it('includes assumption resolution instruction', () => {
    const prompt = buildSpecRefineInitialPrompt(GATE, TICKET);
    expect(prompt).toContain('Assumption Resolution');
    expect(prompt).toContain('Self-resolvable');
  });

  it('uses imperative assumption-checking wording', () => {
    const prompt = buildSpecRefineInitialPrompt(GATE, TICKET);
    expect(prompt).toContain('Use Read/Grep/Glob now');
  });

  it('does not contain old passive assumption-checking wording', () => {
    const prompt = buildSpecRefineInitialPrompt(GATE, TICKET);
    expect(prompt).not.toContain("State what you'd verify and whether it appears correct or incorrect.");
  });
});

describe('buildSpecRefineAnswerPrompt', () => {
  it('embeds the gate criteria', () => {
    const prompt = buildSpecRefineAnswerPrompt(GATE, TICKET, ANSWERS);
    expect(prompt).toContain(GATE);
  });

  it('embeds the ticket body', () => {
    const prompt = buildSpecRefineAnswerPrompt(GATE, TICKET, ANSWERS);
    expect(prompt).toContain(TICKET);
  });

  it('embeds the user answers', () => {
    const prompt = buildSpecRefineAnswerPrompt(GATE, TICKET, ANSWERS);
    expect(prompt).toContain(ANSWERS);
  });

  it('does not contain hardcoded Automated Visual Verification FAIL condition', () => {
    const prompt = buildSpecRefineAnswerPrompt(GATE, TICKET, ANSWERS);
    expect(prompt).not.toMatch(/\*\*Automated Visual Verification\*\*: UI tickets need automated visual/);
  });

  it('does not contain hardcoded End-to-End Data Flow FAIL condition', () => {
    const prompt = buildSpecRefineAnswerPrompt(GATE, TICKET, ANSWERS);
    expect(prompt).not.toMatch(/\*\*End-to-End Data Flow\*\*: Multi-boundary features need e2e/);
  });

  it('asks for updated ticket body in output', () => {
    const prompt = buildSpecRefineAnswerPrompt(GATE, TICKET, ANSWERS);
    expect(prompt).toContain('## Updated Ticket Body');
  });
});

describe('built-in gate verification policy', () => {
  it('gate is always non-empty (resolveSpecContext always has a gate)', () => {
    expect(GATE).toBeTruthy();
    expect(GATE.length).toBeGreaterThan(500);
  });

  it('gate prohibits asking about verification level (MUST NOT ask)', () => {
    // The gate explicitly prohibits the evaluator from asking these questions
    expect(GATE).toContain('MUST NOT ask');
    // The phrases appear only in the prohibition context, not as instructions to ask
    expect(GATE).toMatch(/MUST NOT ask.*verification level/s);
  });

  it('gate does not require e2e tests', () => {
    expect(GATE).not.toContain('### End-to-End Data Flow Verification');
    expect(GATE).toContain('e2e / Playwright / visual browser verification is **not required**');
  });

  it('gate does not require automated visual verification', () => {
    expect(GATE).not.toContain('### Automated Visual Verification');
  });
});
