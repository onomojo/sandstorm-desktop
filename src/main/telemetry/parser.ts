/**
 * Electron-free JSONL parser for Claude Code transcript files.
 * Handles multiple Claude Code JSONL formats and skips malformed lines.
 */

import fs from 'fs';
import path from 'path';

export interface RawUsageEntry {
  sessionId: string;
  model: string;
  timestamp: string; // ISO 8601
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  stackId: string | null; // basename of stack root dir; null for host-root entries
}

export interface ParseResult {
  entries: RawUsageEntry[];
  skippedLines: number; // count of lines that failed JSON.parse()
}

/** Extract usage entry from a parsed JSON object, returning null if not a usage record. */
function extractUsage(obj: Record<string, unknown>, stackId: string | null): RawUsageEntry | null {
  const sessionId = obj.sessionId;
  const timestamp = obj.timestamp;
  if (typeof sessionId !== 'string' || typeof timestamp !== 'string') return null;

  // Format A: top-level model + usage (Claude Code >= 1.x "say" type)
  if (typeof obj.model === 'string' && obj.usage !== null && typeof obj.usage === 'object') {
    const u = obj.usage as Record<string, unknown>;
    if (typeof u.input_tokens === 'number') {
      return {
        sessionId,
        model: obj.model,
        timestamp,
        input: u.input_tokens,
        output: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
        cacheCreate: typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0,
        cacheRead: typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0,
        stackId,
      };
    }
  }

  // Format B: nested under message.model + message.usage (Claude Code assistant message)
  if (obj.message !== null && typeof obj.message === 'object') {
    const msg = obj.message as Record<string, unknown>;
    if (typeof msg.model === 'string' && msg.usage !== null && typeof msg.usage === 'object') {
      const u = msg.usage as Record<string, unknown>;
      if (typeof u.input_tokens === 'number') {
        return {
          sessionId,
          model: msg.model,
          timestamp,
          input: u.input_tokens,
          output: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
          cacheCreate: typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0,
          cacheRead: typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0,
          stackId,
        };
      }
    }
  }

  return null;
}

/** Parse a single JSONL file, returning entries and a count of malformed lines. */
export function parseJSONLFile(filePath: string, stackId: string | null = null): ParseResult {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { entries: [], skippedLines: 0 };
  }

  const entries: RawUsageEntry[] = [];
  let skippedLines = 0;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      skippedLines++;
      continue;
    }

    if (!obj || typeof obj !== 'object') {
      skippedLines++;
      continue;
    }

    const entry = extractUsage(obj as Record<string, unknown>, stackId);
    if (entry) entries.push(entry);
    // non-usage lines (user messages, tool results, etc.) are silently ignored
  }

  return { entries, skippedLines };
}

/** Recursively find all *.jsonl files under a directory. */
export function findJSONLFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findJSONLFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }
  } catch {
    // directory doesn't exist or isn't accessible — return empty
  }
  return results;
}

/** Parse all JSONL files under a root directory. */
export function parseTranscriptRoot(rootDir: string, stackId: string | null = null): ParseResult {
  const files = findJSONLFiles(rootDir);
  const allEntries: RawUsageEntry[] = [];
  let totalSkipped = 0;

  for (const file of files) {
    const { entries, skippedLines } = parseJSONLFile(file, stackId);
    allEntries.push(...entries);
    totalSkipped += skippedLines;
  }

  return { entries: allEntries, skippedLines: totalSkipped };
}

/**
 * Parse JSONL files from multiple roots with file-path-level deduplication.
 * Roots ending with `/.claude/projects` are treated as the host root (stackId=null).
 * All other roots get stackId=path.basename(root).
 *
 * Dedup is at file-path level: a file reachable under two roots is parsed once.
 * Entry-level dedup is NOT performed — sessionId spans many entries.
 */
export function parseTranscriptRoots(roots: string[]): ParseResult {
  const seenFiles = new Set<string>();
  const allEntries: RawUsageEntry[] = [];
  let totalSkipped = 0;

  for (const root of roots) {
    const stackId = root.endsWith('/.claude/projects') ? null : path.basename(root);
    const files = findJSONLFiles(root);

    for (const file of files) {
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);

      const { entries, skippedLines } = parseJSONLFile(file, stackId);
      allEntries.push(...entries);
      totalSkipped += skippedLines;
    }
  }

  return { entries: allEntries, skippedLines: totalSkipped };
}
