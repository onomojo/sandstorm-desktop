/**
 * Shared validation utilities for the main process.
 */

import path from 'path';

/**
 * Validate that projectDir is a non-empty absolute path.
 * Returns an error object if invalid, or null if valid.
 */
export function validateProjectDir(projectDir: unknown): { error: string } | null {
  if (!projectDir || typeof projectDir !== 'string' || !projectDir.trim()) {
    return {
      error:
        'projectDir is required and must be a non-empty string. ' +
        'Pass the absolute path to the project directory (e.g., "/home/user/my-project").',
    };
  }
  if (!path.isAbsolute(projectDir)) {
    return {
      error: `projectDir must be an absolute path. Got: "${projectDir}". ` +
        'Pass the full path (e.g., "/home/user/my-project").',
    };
  }
  // Reject paths with traversal sequences (e.g. /home/user/../etc/passwd)
  // path.resolve normalises the input; if the result differs from the original input,
  // the caller passed a path that contains .. or . segments.
  if (path.resolve(projectDir) !== projectDir) {
    return {
      error: `projectDir contains path traversal sequences. Got: "${projectDir}".`,
    };
  }
  return null;
}
