export interface SubtaskEntry {
  ticketId: string;
  spine: boolean;
  acceptanceGate: boolean;
}

export interface EdgeEntry {
  from: string;
  to: string;
}

export interface CriterionEntry {
  id: string;
  text: string;
}

export interface RunPlan {
  epicId: string;
  runnable: boolean;
  notRunnableReasons: string[];
  subtasks: SubtaskEntry[];
  edges: EdgeEntry[];
  criteria: CriterionEntry[];
}

export function isEpic(labels: string[]): boolean {
  return labels.includes('epic');
}

export function parseEpicBody(epicId: string, body: string): RunPlan {
  const normalized = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  const subtasks = parseSubtasks(lines);
  const dagResult = parseDagBlock(lines);
  const criteria = parseCriteria(lines);

  const reasons: string[] = [];

  if (subtasks.length === 0) {
    reasons.push('no subtask checklist found');
  }

  if (dagResult === null) {
    reasons.push('no dag block found');
  } else {
    const knownIds = new Set(subtasks.map((s) => s.ticketId));
    const reportedUnknown = new Set<string>();
    for (const edge of dagResult) {
      for (const id of [edge.from, edge.to]) {
        if (!knownIds.has(id) && !reportedUnknown.has(id)) {
          reasons.push(`dag edge references unknown ticket: ${id}`);
          reportedUnknown.add(id);
        }
      }
    }
    if (dagResult.length > 0 && subtasks.length > 0 && hasCycle(dagResult)) {
      reasons.push('cycle detected in dag');
    }
  }

  if (subtasks.length > 0 && !subtasks.some((s) => s.spine)) {
    reasons.push('no spine tag');
  }

  if (subtasks.length > 0 && !subtasks.some((s) => s.acceptanceGate)) {
    reasons.push('no acceptance-gate tag');
  }

  if (criteria.length === 0) {
    reasons.push('no acceptance criteria found');
  } else {
    const seen = new Set<string>();
    const reported = new Set<string>();
    for (const crit of criteria) {
      if (seen.has(crit.id) && !reported.has(crit.id)) {
        reasons.push(`duplicate crit id: ${crit.id}`);
        reported.add(crit.id);
      }
      seen.add(crit.id);
    }
  }

  return {
    epicId,
    runnable: reasons.length === 0,
    notRunnableReasons: reasons,
    subtasks,
    edges: dagResult ?? [],
    criteria,
  };
}

// Subtask line: - [ ] #<digits> · <rest>  (# optional, any check state)
const SUBTASK_PATTERN = /^-\s*\[[ xX]\]\s*#?(\d+)\s*·(.*)$/;

function parseSubtasks(lines: string[]): SubtaskEntry[] {
  const subtasks: SubtaskEntry[] = [];
  for (const line of lines) {
    const match = line.match(SUBTASK_PATTERN);
    if (!match) continue;
    const ticketId = match[1];
    const rest = match[2];
    subtasks.push({
      ticketId,
      spine: rest.includes('<!-- spine -->'),
      acceptanceGate: rest.includes('<!-- acceptance-gate -->'),
    });
  }
  return subtasks;
}

// DAG edge line: #<from> --> #<to>  (# optional)
const EDGE_PATTERN = /^#?(\d+)\s*-->\s*#?(\d+)$/;

// Returns parsed edges from the first ```dag block, or null if no block found.
function parseDagBlock(lines: string[]): EdgeEntry[] | null {
  let inBlock = false;
  let foundBlock = false;
  const edges: EdgeEntry[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inBlock) {
      if (trimmed === '```dag') {
        inBlock = true;
        foundBlock = true;
      }
    } else {
      if (trimmed === '```') {
        break; // first block ends; subsequent blocks are ignored
      }
      const match = trimmed.match(EDGE_PATTERN);
      if (match) {
        edges.push({ from: match[1], to: match[2] });
      }
    }
  }

  return foundBlock ? edges : null;
}

// Criterion tag: <!-- crit:<id> --> where id is [a-z0-9-]+
const CRIT_PATTERN = /<!--\s*crit:([a-z0-9-]+)\s*-->/;

function parseCriteria(lines: string[]): CriterionEntry[] {
  const criteria: CriterionEntry[] = [];
  let inSection = false;

  for (const line of lines) {
    if (line.startsWith('## Acceptance for the epic')) {
      inSection = true;
      continue;
    }
    // Stop at the next heading of the same or higher level
    if (inSection && /^#{1,2}\s/.test(line)) {
      break;
    }
    if (!inSection) continue;
    const match = line.match(CRIT_PATTERN);
    if (!match) continue;
    const id = match[1];
    const text = line
      .replace(CRIT_PATTERN, '')
      .trim()
      .replace(/^-\s*\[[ xX]\]\s*/, '')
      .trim();
    criteria.push({ id, text });
  }

  return criteria;
}

function hasCycle(edges: EdgeEntry[]): boolean {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    if (!graph.has(edge.from)) graph.set(edge.from, []);
    graph.get(edge.from)!.push(edge.to);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string): boolean {
    visited.add(node);
    inStack.add(node);
    for (const neighbor of graph.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) return true;
      } else if (inStack.has(neighbor)) {
        return true;
      }
    }
    inStack.delete(node);
    return false;
  }

  for (const node of graph.keys()) {
    if (!visited.has(node) && dfs(node)) return true;
  }
  return false;
}
