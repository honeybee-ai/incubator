/**
 * TypeScript compilation check — runs tsc --noEmit.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { EvalCheck, EvalCheckResult, EvalTask } from '../types.js';

const require = createRequire(import.meta.url);

/** Resolve tsc binary from our own typescript installation. */
function findTsc(): string {
  try {
    return require.resolve('typescript/bin/tsc');
  } catch {
    return 'tsc'; // fallback to PATH
  }
}

/** Default weight if not configured in task. */
const DEFAULT_WEIGHT = 3;

export const typecheckCheck: EvalCheck = {
  name: 'typecheck',

  async run(workDir: string, task: EvalTask): Promise<EvalCheckResult> {
    const start = Date.now();
    const weight = task.checks?.typecheck?.weight ?? DEFAULT_WEIGHT;

    // Skip if no tsconfig.json
    if (!existsSync(join(workDir, 'tsconfig.json'))) {
      return {
        name: 'typecheck',
        passed: true,
        score: 1.0,
        weight,
        details: 'Skipped: no tsconfig.json found',
        duration_ms: Date.now() - start,
      };
    }

    try {
      execFileSync('node', [findTsc(), '--noEmit', '--pretty'], {
        cwd: workDir,
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      return {
        name: 'typecheck',
        passed: true,
        score: 1.0,
        weight,
        details: 'TypeScript compilation passed with no errors',
        duration_ms: Date.now() - start,
      };
    } catch (err) {
      const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? '';
      const stdout = (err as { stdout?: Buffer })?.stdout?.toString() ?? '';
      const output = (stderr + stdout).trim();

      // Count errors from tsc output
      const errorMatch = output.match(/Found (\d+) errors?/);
      const errorCount = errorMatch ? parseInt(errorMatch[1], 10) : 1;

      // Score degrades with errors: 0 errors = 1.0, each error costs 0.1
      const score = Math.max(0, 1 - errorCount * 0.1);

      // Extract error lines (truncate to 2000 chars)
      const lines = output.split('\n');
      const errorLines = lines.filter(l => l.includes('error TS')).slice(0, 20);
      const details = errorLines.length > 0
        ? `${errorCount} TypeScript error(s):\n${errorLines.join('\n')}`
        : `TypeScript compilation failed (${errorCount} error(s))`;

      return {
        name: 'typecheck',
        passed: false,
        score,
        weight,
        details: details.slice(0, 2000),
        errors: errorLines,
        duration_ms: Date.now() - start,
      };
    }
  },
};
