import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GitFreshnessResult {
  mutated: boolean;
  warning?: string;
}

async function git(args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 30_000 });
    return { stdout: stdout.trim(), code: 0 };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string };
    return { stdout: (e.stdout ?? '').trim(), code: e.code ?? 1 };
  }
}

/**
 * Ensures the project directory is fresh against origin/main before spec-check/refine
 * evaluates file:line citations.
 *
 * Strategy:
 *  1. git fetch origin (read-only; safe)
 *  2. If fetch fails → warn "offline", proceed without mutation
 *  3. If HEAD == origin/main → up-to-date, no-op
 *  4. If on main branch + clean tree + HEAD is ancestor of origin/main → fast-forward
 *  5. All other cases (dirty, feature branch, detached HEAD, diverged) → warn-only, no mutation
 */
export async function ensureFreshAgainstMain(projectDir: string): Promise<GitFreshnessResult> {
  // Step 1: git fetch origin
  const fetch = await git(['fetch', 'origin'], projectDir);
  if (fetch.code !== 0) {
    return {
      mutated: false,
      warning:
        '[Staleness warning] Could not verify against `origin/main` (fetch failed/offline). ' +
        'Citations evaluated against the local tree as-is — results may be stale.',
    };
  }

  // Step 2: Determine current branch
  const branchRes = await git(['rev-parse', '--abbrev-ref', 'HEAD'], projectDir);
  const branch = branchRes.stdout;
  const isOnMain = branch === 'main';
  const isDetached = branch === 'HEAD';

  // Step 3: Get SHAs
  const headShaRes = await git(['rev-parse', 'HEAD'], projectDir);
  const originShaRes = await git(['rev-parse', 'origin/main'], projectDir);
  const headSha = headShaRes.stdout;
  const originSha = originShaRes.stdout;

  // Up-to-date: no-op, no warning
  if (headSha === originSha) {
    return { mutated: false };
  }

  // Step 4: Check if HEAD is ancestor of origin/main (FF-eligible)
  const ancestorRes = await git(['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], projectDir);
  const isAncestor = ancestorRes.code === 0;

  if (isOnMain && isAncestor) {
    // Check working tree cleanliness
    const statusRes = await git(['status', '--porcelain'], projectDir);
    const isDirty = statusRes.stdout.length > 0;

    if (!isDirty) {
      // Safe to fast-forward
      const ffRes = await git(['merge', '--ff-only', 'origin/main'], projectDir);
      if (ffRes.code === 0) {
        return { mutated: true };
      }
      // FF unexpectedly failed — fall through to warn
    } else {
      // Dirty tree on main, behind — warn only
      return {
        mutated: false,
        warning:
          `[Staleness warning] Project dir is on \`main@${headSha.slice(0, 8)}\` with uncommitted changes, ` +
          `behind \`origin/main\` — citations may be stale; refresh before trusting a FAIL.`,
      };
    }
  }

  // All warn-only cases: diverged, feature branch, detached HEAD, non-FF
  const displayBranch = isDetached ? `detached@${headSha.slice(0, 8)}` : `${branch}@${headSha.slice(0, 8)}`;
  return {
    mutated: false,
    warning:
      `[Staleness warning] Project dir is on \`${displayBranch}\`, ` +
      `behind \`origin/main\` — citations may be stale; refresh before trusting a FAIL.`,
  };
}
