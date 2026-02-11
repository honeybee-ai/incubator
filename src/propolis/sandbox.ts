import { resolve, relative } from 'node:path';

/**
 * Resolve a user-provided path relative to workDir and ensure it doesn't
 * escape above workDir. Returns the resolved absolute path.
 * Throws if the path escapes the sandbox.
 */
export function safePath(workDir: string, userPath: string): string {
  const abs = resolve(workDir, userPath);
  const rel = relative(workDir, abs);

  // If the relative path starts with ".." or is absolute, it escapes
  if (rel.startsWith('..') || resolve(rel) === rel) {
    throw new Error(`Path "${userPath}" escapes the working directory`);
  }

  return abs;
}
