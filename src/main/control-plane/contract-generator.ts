/**
 * Contract Generator — pure, dependency-injected module.
 *
 * Transforms an approved (gate-passed) ticket into a machine-verifiable
 * execution contract via a bounded ephemeral LLM call, then parses and
 * validates the result against the contract schema. Also owns the on-ticket
 * storage format: a single marked GitHub issue comment that carries the
 * contract JSON plus the spec-body sha it was generated from.
 *
 * This module is electron-free and registry-free so it can be unit-tested in
 * isolation. The LLM call and provider I/O are injected by the caller
 * (claude/tools.ts wires `runEphemeral`; ticket-config.ts owns the comment I/O).
 *
 * Mirrors the shape of pr-creator.ts (pure-ish, deps-injected, structured
 * result, fence-tolerant JSON parsing).
 */

import { buildContractPrompt } from '../contract-generator-prompt';

/** Hard timeout for a single contract-generation call. */
export const CONTRACT_TIMEOUT_MS = 180_000;

/** Marker that identifies the contract comment on a ticket. */
export const CONTRACT_MARKER = '<!-- sandstorm:contract';
/** Current on-ticket contract envelope version. */
export const CONTRACT_COMMENT_VERSION = 1;

const VALID_CHANGE_TYPES = [
  'feature',
  'bugfix',
  'refactor',
  'migration',
  'docs',
  'test_only',
] as const;

const VALID_REVIEW_FOCUS = ['requirements', 'correctness', 'security'] as const;

export type ChangeType = (typeof VALID_CHANGE_TYPES)[number];
export type ReviewFocus = (typeof VALID_REVIEW_FOCUS)[number];

export interface Contract {
  contract_version: number;
  change_type: ChangeType;
  requirements: unknown[];
  acceptance_criteria: unknown[];
  required_tests: unknown[];
  implementation_obligations: unknown[];
  forbidden_changes: {
    files: unknown[];
    modules: unknown[];
    behaviors: unknown[];
  };
  risk_areas: unknown[];
  success_conditions: unknown[];
  review_focus: ReviewFocus[];
  mechanical_checks: {
    require_tests: boolean;
    allow_dependency_changes: boolean;
    allow_schema_changes: boolean;
    max_files_changed: number | null;
    max_lines_changed: number | null;
  };
}

export interface ContractGenDeps {
  /** One-shot ephemeral LLM call. Returns the agent's full text response. */
  runEphemeral: (prompt: string, projectDir: string, timeoutMs?: number) => Promise<string>;
}

export interface GenerateContractArgs {
  ticketId: string;
  projectDir: string;
  /** The approved ticket body (same text hashed for the spec-ready sha). */
  specBody: string;
}

/**
 * Parse + validate a contract JSON string. Tolerates a single leading code
 * fence (```json ... ```) like `parseDraftResponse`. Throws a descriptive
 * error on any schema violation so the atomic gate step fails closed.
 */
export function parseContract(raw: string): { json: string; contract: Contract } {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Contract response did not contain JSON: ${text.slice(0, 200)}`);
  }
  const slice = text.slice(start, end + 1);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(slice) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Contract JSON did not parse: ${e instanceof Error ? e.message : String(e)}`);
  }

  const requiredKeys = [
    'contract_version',
    'change_type',
    'requirements',
    'acceptance_criteria',
    'required_tests',
    'implementation_obligations',
    'forbidden_changes',
    'risk_areas',
    'success_conditions',
    'review_focus',
    'mechanical_checks',
  ];
  for (const key of requiredKeys) {
    if (!(key in parsed)) throw new Error(`Contract missing required key: ${key}`);
  }

  if (!VALID_CHANGE_TYPES.includes(parsed.change_type as ChangeType)) {
    throw new Error(
      `Contract change_type must be one of ${VALID_CHANGE_TYPES.join(', ')} (got ${JSON.stringify(parsed.change_type)})`,
    );
  }

  if (!Array.isArray(parsed.review_focus)) {
    throw new Error('Contract review_focus must be an array');
  }
  for (const f of parsed.review_focus as unknown[]) {
    if (!VALID_REVIEW_FOCUS.includes(f as ReviewFocus)) {
      throw new Error(
        `Contract review_focus contains a disallowed value: ${JSON.stringify(f)} (allowed: ${VALID_REVIEW_FOCUS.join(', ')})`,
      );
    }
  }

  const arrayKeys = [
    'requirements',
    'acceptance_criteria',
    'required_tests',
    'implementation_obligations',
    'risk_areas',
    'success_conditions',
  ];
  for (const key of arrayKeys) {
    if (!Array.isArray(parsed[key])) throw new Error(`Contract ${key} must be an array`);
  }

  const fc = parsed.forbidden_changes as Record<string, unknown> | null;
  if (!fc || typeof fc !== 'object' || Array.isArray(fc)) {
    throw new Error('Contract forbidden_changes must be an object');
  }
  for (const key of ['files', 'modules', 'behaviors']) {
    if (!Array.isArray(fc[key])) throw new Error(`Contract forbidden_changes.${key} must be an array`);
  }

  const mc = parsed.mechanical_checks as Record<string, unknown> | null;
  if (!mc || typeof mc !== 'object' || Array.isArray(mc)) {
    throw new Error('Contract mechanical_checks must be an object');
  }
  for (const key of ['require_tests', 'allow_dependency_changes', 'allow_schema_changes']) {
    if (typeof mc[key] !== 'boolean') {
      throw new Error(`Contract mechanical_checks.${key} must be a boolean`);
    }
  }

  // Re-serialize the validated object so storage is canonical (pretty-printed,
  // no surrounding prose) regardless of how the model formatted its output.
  const contract = parsed as unknown as Contract;
  return { json: JSON.stringify(contract, null, 2), contract };
}

/**
 * Generate and validate an execution contract for an approved ticket. The only
 * side effect is the bounded ephemeral call delegated through `deps.runEphemeral`.
 */
export async function generateContract(
  args: GenerateContractArgs,
  deps: ContractGenDeps,
): Promise<{ json: string; contract: Contract }> {
  if (!args.specBody.trim()) {
    throw new Error('Cannot generate a contract from an empty ticket body');
  }
  const prompt = buildContractPrompt(args.specBody);
  const raw = await deps.runEphemeral(prompt, args.projectDir, CONTRACT_TIMEOUT_MS);
  return parseContract(raw);
}

/**
 * Render the on-ticket contract comment: a marker line carrying the version and
 * the spec-body sha, followed by the contract JSON in a fenced block.
 */
export function buildContractComment(json: string, sha: string): string {
  return [
    `${CONTRACT_MARKER} v=${CONTRACT_COMMENT_VERSION} sha=${sha} -->`,
    '',
    '**Sandstorm execution contract** — machine-generated from the approved spec. Do not edit by hand.',
    '',
    '```json',
    json,
    '```',
  ].join('\n');
}

/**
 * Extract the contract from a comment body. Returns null for any comment that
 * is not a contract comment (no marker), so callers can scan all comments.
 */
export function parseContractComment(commentBody: string): { sha: string; json: string } | null {
  if (!commentBody || !commentBody.includes(CONTRACT_MARKER)) return null;
  const shaMatch = commentBody.match(/sandstorm:contract\s+v=\d+\s+sha=([^\s]+)\s*-->/);
  const sha = shaMatch ? shaMatch[1] : '';
  const fence = commentBody.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!fence) return null;
  return { sha, json: fence[1].trim() };
}
