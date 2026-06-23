import { describe, it, expect, vi } from 'vitest';
import {
  parseContract,
  generateContract,
  buildContractComment,
  parseContractComment,
  CONTRACT_MARKER,
} from '../../../src/main/control-plane/contract-generator';

const VALID = {
  contract_version: 1,
  change_type: 'bugfix',
  requirements: [{ id: 'R1', description: 'do x' }],
  acceptance_criteria: [{ id: 'AC1', description: 'x happens' }],
  required_tests: [{ id: 'T1', scenario: 'x path', type: 'unit' }],
  implementation_obligations: [{ id: 'IO1', description: 'add regression test' }],
  forbidden_changes: { files: [], modules: [], behaviors: [] },
  risk_areas: [{ name: 'persistence', reason: 'touches db' }],
  success_conditions: ['All required tests pass'],
  review_focus: ['correctness'],
  mechanical_checks: {
    require_tests: true,
    allow_dependency_changes: false,
    allow_schema_changes: false,
    max_files_changed: null,
    max_lines_changed: null,
  },
};
const validJson = JSON.stringify(VALID);

describe('parseContract', () => {
  it('parses a valid contract and re-serializes canonically', () => {
    const { contract, json } = parseContract(validJson);
    expect(contract.change_type).toBe('bugfix');
    expect(contract.review_focus).toEqual(['correctness']);
    // Re-serialized (pretty-printed) form parses back to the same object.
    expect(JSON.parse(json)).toEqual(VALID);
  });

  it('tolerates a leading ```json code fence', () => {
    const fenced = '```json\n' + validJson + '\n```';
    expect(parseContract(fenced).contract.change_type).toBe('bugfix');
  });

  it('tolerates prose around the JSON object', () => {
    const wrapped = 'Here is the contract:\n' + validJson + '\nDone.';
    expect(parseContract(wrapped).contract.contract_version).toBe(1);
  });

  it('throws on an invalid change_type', () => {
    const bad = JSON.stringify({ ...VALID, change_type: 'chore' });
    expect(() => parseContract(bad)).toThrow(/change_type/);
  });

  it('throws on a disallowed review_focus value', () => {
    const bad = JSON.stringify({ ...VALID, review_focus: ['optimization'] });
    expect(() => parseContract(bad)).toThrow(/review_focus/);
  });

  it('throws when a required top-level key is missing', () => {
    const { mechanical_checks, ...rest } = VALID;
    void mechanical_checks;
    expect(() => parseContract(JSON.stringify(rest))).toThrow(/missing required key: mechanical_checks/);
  });

  it('throws when forbidden_changes is not shaped correctly', () => {
    const bad = JSON.stringify({ ...VALID, forbidden_changes: { files: [], modules: [] } });
    expect(() => parseContract(bad)).toThrow(/forbidden_changes\.behaviors/);
  });

  it('throws when a mechanical_checks flag is not a boolean', () => {
    const bad = JSON.stringify({
      ...VALID,
      mechanical_checks: { ...VALID.mechanical_checks, require_tests: 'yes' },
    });
    expect(() => parseContract(bad)).toThrow(/require_tests must be a boolean/);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseContract('{ not json ')).toThrow();
  });

  it('throws when there is no JSON object at all', () => {
    expect(() => parseContract('totally not json')).toThrow(/did not contain JSON/);
  });
});

describe('generateContract', () => {
  it('builds the prompt, calls runEphemeral, and returns the parsed contract', async () => {
    const runEphemeral = vi.fn().mockResolvedValue(validJson);
    const out = await generateContract(
      { ticketId: '5', projectDir: '/p', specBody: '## Approved spec body' },
      { runEphemeral },
    );
    expect(out.contract.change_type).toBe('bugfix');
    const [prompt, dir] = runEphemeral.mock.calls[0];
    expect(prompt).toContain('Sandstorm Contract Generator');
    expect(prompt).toContain('## Approved spec body');
    expect(dir).toBe('/p');
  });

  it('throws when the spec body is empty', async () => {
    const runEphemeral = vi.fn();
    await expect(
      generateContract({ ticketId: '5', projectDir: '/p', specBody: '   ' }, { runEphemeral }),
    ).rejects.toThrow(/empty ticket body/);
    expect(runEphemeral).not.toHaveBeenCalled();
  });

  it('propagates parse failures from a bad LLM response', async () => {
    const runEphemeral = vi.fn().mockResolvedValue('I cannot do that');
    await expect(
      generateContract({ ticketId: '5', projectDir: '/p', specBody: 'body' }, { runEphemeral }),
    ).rejects.toThrow();
  });
});

describe('contract comment marshalling', () => {
  it('round-trips json + sha through build/parse', () => {
    const comment = buildContractComment(validJson, 'deadbeef1234');
    expect(comment).toContain(CONTRACT_MARKER);
    const parsed = parseContractComment(comment);
    expect(parsed).not.toBeNull();
    expect(parsed!.sha).toBe('deadbeef1234');
    expect(JSON.parse(parsed!.json)).toEqual(VALID);
  });

  it('returns null for a comment without the marker', () => {
    expect(parseContractComment('just a normal human comment')).toBeNull();
    expect(parseContractComment('```json\n{}\n```')).toBeNull();
  });

  it('returns null for an empty comment', () => {
    expect(parseContractComment('')).toBeNull();
  });
});
