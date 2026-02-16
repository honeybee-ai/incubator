/**
 * File structure check — validates expected files exist and are non-empty.
 */
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { EvalCheck, EvalCheckResult, EvalTask } from '../types.js';

/** Default weight if not configured in task. */
const DEFAULT_WEIGHT = 1;

/**
 * Simple glob match (supports `*` and `**`).
 * Not a full glob engine — handles the common patterns.
 */
function matchGlob(pattern: string, filePath: string): boolean {
  // Exact match
  if (pattern === filePath) return true;

  // Convert glob to regex (safe — patterns come from task YAML, not user input)
  let regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex chars (not * or ?)
    .replace(/\*\*\//g, '{{GLOBSTAR_SEP}}') // **/ = zero or more dirs
    .replace(/\*\*/g, '{{GLOBSTAR}}')       // ** at end
    .replace(/\*/g, '[^/]*')                // * = one segment
    .replace(/\{\{GLOBSTAR_SEP\}\}/g, '(?:.+/)?')  // **/ matches "" or "a/" or "a/b/"
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  return new RegExp(`^${regexStr}$`).test(filePath);
}

/**
 * Recursively list all files in a directory (relative paths).
 */
function listFiles(dir: string, base?: string): string[] {
  const result: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(...listFiles(join(dir, entry.name), rel));
    } else {
      result.push(rel);
    }
  }
  return result;
}

export const structureCheck: EvalCheck = {
  name: 'structure',

  async run(workDir: string, task: EvalTask): Promise<EvalCheckResult> {
    const start = Date.now();
    const weight = task.checks?.structure?.weight ?? DEFAULT_WEIGHT;
    const patterns = task.expected_files;

    if (!patterns || patterns.length === 0) {
      return {
        name: 'structure',
        passed: true,
        score: 1.0,
        weight,
        details: 'No expected files configured — skipped',
        duration_ms: Date.now() - start,
      };
    }

    const allFiles = listFiles(workDir);
    const results: Array<{ pattern: string; matched: boolean; files: string[] }> = [];

    for (const pattern of patterns) {
      // Check if any file matches this pattern
      const matches = allFiles.filter(f => matchGlob(pattern, f));

      // Verify matched files are non-empty
      const nonEmpty = matches.filter(f => {
        const fullPath = join(workDir, f);
        return existsSync(fullPath) && statSync(fullPath).size > 0;
      });

      results.push({
        pattern,
        matched: nonEmpty.length > 0,
        files: nonEmpty,
      });
    }

    const matchedCount = results.filter(r => r.matched).length;
    const score = patterns.length > 0 ? matchedCount / patterns.length : 1.0;
    const passed = matchedCount === patterns.length;

    const matchedPatterns = results.filter(r => r.matched).map(r => r.pattern);
    const missingPatterns = results.filter(r => !r.matched).map(r => r.pattern);

    const parts: string[] = [];
    if (matchedPatterns.length > 0) {
      parts.push(`Matched: ${matchedPatterns.join(', ')}`);
    }
    if (missingPatterns.length > 0) {
      parts.push(`Missing: ${missingPatterns.join(', ')}`);
    }

    return {
      name: 'structure',
      passed,
      score,
      weight,
      details: `${matchedCount}/${patterns.length} expected file patterns found. ${parts.join('. ')}`,
      errors: missingPatterns.length > 0 ? missingPatterns.map(p => `Missing: ${p}`) : undefined,
      duration_ms: Date.now() - start,
    };
  },
};
