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

vi.mock('../../src/main/control-plane/ticket-references', () => ({
  resolveTicketReferences: vi.fn().mockResolvedValue([]),
  renderResolvedReferences: vi.fn().mockReturnValue(''),
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

describe('spec-gate builders — Decision Altitude + decide-and-record', () => {
  const ALTITUDE = 'a different answer would change observable behavior, system architecture, product intent, or a cross-ticket contract';
  const DECIDE_RECORD = 'Implementation discretion — decide and record';
  const GUARD = 'Do NOT emit a user question for these';

  const builders: Array<[string, () => string]> = [
    ['buildSpecCheckPrompt', () => buildSpecCheckPrompt(GATE, TICKET)],
    ['buildSpecRefineInitialPrompt', () => buildSpecRefineInitialPrompt(GATE, TICKET)],
    ['buildSpecRefineAnswerPrompt', () => buildSpecRefineAnswerPrompt(GATE, TICKET, ANSWERS)],
  ];

  for (const [name, build] of builders) {
    describe(name, () => {
      it('includes the altitude filter, decide-and-record path, and the discretion guard', () => {
        const prompt = build();
        expect(prompt).toContain(ALTITUDE);
        expect(prompt).toContain(DECIDE_RECORD);
        expect(prompt).toContain(GUARD);
      });
    });
  }
});

const EPIC_CONTEXT = "This ticket's role in the epic: role=build, serves acceptance criterion=crit-7\n\n# Parent Epic\n\nEpic body verbatim.";

describe('spec-gate builders — Epic Context plumbing', () => {
  const epicBuilders: Array<[string, (epic?: string) => string]> = [
    ['buildSpecCheckPrompt', (epic) => buildSpecCheckPrompt(GATE, TICKET, undefined, epic)],
    ['buildSpecRefineInitialPrompt', (epic) => buildSpecRefineInitialPrompt(GATE, TICKET, epic)],
    ['buildSpecRefineAnswerPrompt', (epic) => buildSpecRefineAnswerPrompt(GATE, TICKET, ANSWERS, epic)],
  ];

  for (const [name, build] of epicBuilders) {
    describe(name, () => {
      it('inserts the Epic Context section and role/crit line when epicContext is passed', () => {
        const prompt = build(EPIC_CONTEXT);
        expect(prompt).toContain('## Epic Context (already-decided givens — do NOT re-litigate)');
        expect(prompt).toContain("This ticket's role in the epic: role=build, serves acceptance criterion=crit-7");
        expect(prompt).toContain('Epic body verbatim.');
        // Phase-1 instruction to treat the epic as fixed givens is present.
        expect(prompt).toContain('Treat every contract, vocabulary term, and acceptance decision in it as a fixed given');
      });

      it('omits the Epic Context section when epicContext is not passed (no regression)', () => {
        const prompt = build(undefined);
        // The gate criteria text mentions "### Epic Context" as a criterion, so
        // assert against the unique injected block header instead.
        expect(prompt).not.toContain('## Epic Context (already-decided givens — do NOT re-litigate)');
        expect(prompt).not.toContain('Treat every contract, vocabulary term, and acceptance decision in it as a fixed given');
      });
    });
  }
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

  it('gate allows external design/reference links (not treated as incomplete spec)', () => {
    expect(GATE).toContain('design/reference material');
    expect(GATE).toContain('Resolved References');
  });

  it('gate still requires code contracts to be committed artifacts', () => {
    expect(GATE).toContain('CODE contracts only');
    expect(GATE).toContain('committed type/interface');
  });

  it('gate treats broken referenced links as a FAIL', () => {
    expect(GATE).toContain('broken or unreachable referenced link');
    expect(GATE).toContain('FAIL');
  });
});

describe('buildSpecCheckPrompt — with resolved references', () => {
  const GIST_URL = 'https://gist.github.com/user/abc123unique';
  const REFS_SECTION = `## Resolved References\n\n### ${GIST_URL}\n\n\`\`\`\nmockup content\n\`\`\`\n`;

  it('includes resolved references content when section is provided', () => {
    const prompt = buildSpecCheckPrompt(GATE, TICKET, REFS_SECTION);
    expect(prompt).toContain(GIST_URL);
    expect(prompt).toContain('mockup content');
  });

  it('does not include specific reference URLs when section is not provided', () => {
    const prompt = buildSpecCheckPrompt(GATE, TICKET);
    expect(prompt).not.toContain(GIST_URL);
  });

  it('does not include specific reference URLs when empty string provided', () => {
    const prompt = buildSpecCheckPrompt(GATE, TICKET, '');
    expect(prompt).not.toContain(GIST_URL);
  });

  it('still embeds gate and ticket when references are present', () => {
    const prompt = buildSpecCheckPrompt(GATE, TICKET, REFS_SECTION);
    expect(prompt).toContain(GATE);
    expect(prompt).toContain(TICKET);
  });
});
