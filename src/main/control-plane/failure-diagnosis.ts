import type { Registry, Task, Stack } from './registry';
import type { AgentBackend } from '../agent/types';
import type { RefineQuestion } from './ticket-spec';
import { buildFailureTimeline, type TimelineEntry } from './failure-timeline';

export interface DiagnosticAgentOutput {
  summary: string;
  eligibility: {
    selfHeal: boolean;
    answerQuestions: boolean;
    reincorporateSpec: boolean;
  };
  questions?: RefineQuestion[];
}

export interface FailureDiagnosis extends DiagnosticAgentOutput {
  timeline: TimelineEntry[];
}

/**
 * Parse the free-form agent output into a DiagnosticAgentOutput.
 * Looks for structured sections; gracefully falls back on malformed output.
 */
export function parseDiagnosticOutput(text: string): DiagnosticAgentOutput {
  const summary = extractSection(text, 'SUMMARY') ?? text.trim().slice(0, 1000);
  const eligibility = parseEligibility(text);
  const questions = parseQuestions(text);

  return {
    summary,
    eligibility,
    questions: questions.length > 0 ? questions : undefined,
  };
}

function extractSection(text: string, header: string): string | null {
  const re = new RegExp(`^##\\s+${header}\\s*$`, 'im');
  const match = re.exec(text);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const nextHeader = /^##\s/m.exec(rest);
  const raw = nextHeader ? rest.slice(0, nextHeader.index) : rest;
  return raw.trim() || null;
}

function parseEligibility(text: string): DiagnosticAgentOutput['eligibility'] {
  const section = extractSection(text, 'ELIGIBILITY') ?? text;
  return {
    selfHeal: /self.?heal[^\n]*:\s*true/i.test(section),
    answerQuestions: /answer.?questions[^\n]*:\s*true/i.test(section),
    reincorporateSpec: /reincorporate.?spec[^\n]*:\s*true/i.test(section),
  };
}

function parseQuestions(text: string): RefineQuestion[] {
  const section = extractSection(text, 'QUESTIONS');
  if (!section) return [];

  // Try JSON block first
  const jsonMatch = /```json\s*([\s\S]*?)```/i.exec(section);
  if (jsonMatch) {
    try {
      const parsed: unknown = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed)) {
        return parsed.filter(isRefineQuestion);
      }
    } catch { /* fall through */ }
  }

  // Fallback: numbered list
  const lines = section.split('\n');
  const out: RefineQuestion[] = [];
  let idx = 0;
  for (const line of lines) {
    const m = line.match(/^[0-9]+\.\s*(.+)$/);
    if (m) {
      out.push({ id: `q${idx + 1}`, question: m[1].trim(), options: [] });
      idx++;
    }
  }
  return out;
}

function isRefineQuestion(v: unknown): v is RefineQuestion {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.question === 'string' && typeof obj.id === 'string';
}

export function buildDiagnosticPrompt(task: Task, stack: Stack): string {
  const reviewVerdicts: string[] = JSON.parse(task.review_verdicts ?? '[]');
  const verifyOutputs: string[] = JSON.parse(task.verify_outputs ?? '[]');
  const executeOutputs: string[] = JSON.parse(task.execute_outputs ?? '[]');

  const lastReview = reviewVerdicts.length > 0
    ? reviewVerdicts[reviewVerdicts.length - 1]?.slice(0, 2000)
    : '(none)';
  const lastVerify = verifyOutputs.length > 0
    ? verifyOutputs[verifyOutputs.length - 1]?.slice(0, 2000)
    : '(none)';
  const lastExecute = executeOutputs.length > 0
    ? executeOutputs[executeOutputs.length - 1]?.slice(0, 2000)
    : '(none)';
  const execSummary = (task.execution_summary ?? '(none)').slice(0, 2000);

  return `You are a diagnostic agent reviewing a failed automated code-change task.

The task ran through its maximum review iterations and ended in a terminal failed state.
Your job is to analyze the failure artifacts and determine why it failed and what recovery options are viable.

## Task Prompt (first 500 chars)
${task.prompt.slice(0, 500)}

## Last Execute Output
${lastExecute}

## Last Review Verdict
${lastReview}

## Last Verify Output
${lastVerify}

## Execution Summary
${execSummary}

## Stats
- Review iterations: ${task.review_iterations}
- Verify retries: ${task.verify_retries}
- Stack: ${stack.id}
- Ticket: ${stack.ticket ?? '(none)'}

---

Respond in exactly this structured format (keep section headers as-is):

## SUMMARY
Write a one-paragraph explanation of why the task failed and whether it could succeed with another attempt.

## ELIGIBILITY
selfHeal: <true|false>  (true if another review round on the same code could plausibly pass)
answerQuestions: <true|false>  (true if the agent has concrete blocking questions to ask)
reincorporateSpec: <true|false>  (true if the ticket spec is ambiguous/incomplete and needs updating with learnings)

## QUESTIONS
(Only include this section if answerQuestions is true. Use a \`\`\`json\`\`\` block with this shape:)
\`\`\`json
[
  {
    "id": "q1",
    "question": "...",
    "options": [
      { "id": "a", "label": "...", "recommended": true },
      { "id": "b", "label": "..." }
    ]
  }
]
\`\`\`
`;
}

/**
 * On-demand diagnostic. Called when user clicks "Resolve Failure".
 * Spawns one ephemeral agent, parses its output, adds the deterministic timeline.
 */
export async function getFailureDiagnosis(
  stackId: string,
  registry: Registry,
  agentBackend: AgentBackend,
): Promise<FailureDiagnosis> {
  const stack = registry.getStack(stackId);
  if (!stack) throw new Error(`Stack "${stackId}" not found`);
  if (stack.status !== 'failed') throw new Error(`Stack "${stackId}" is not in failed state`);

  const task = registry.getMostRecentTask(stackId);
  if (!task) throw new Error(`No task found for stack "${stackId}"`);

  const prompt = buildDiagnosticPrompt(task, stack);
  const { promise } = agentBackend.spawnEphemeralAgent(
    prompt,
    stack.project_dir,
    120_000,
    undefined,
    { ticketId: stack.ticket ?? undefined, stage: 'failure-diagnosis' },
  );

  const agentOutput = await promise;
  const parsed = parseDiagnosticOutput(agentOutput);
  const timeline = buildFailureTimeline(task);

  return { ...parsed, timeline };
}
