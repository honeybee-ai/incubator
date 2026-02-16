/**
 * Test runner check — install deps and run the project's test command.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalCheck, EvalCheckResult, EvalTask } from '../types.js';

/** Default weight if not configured in task. */
const DEFAULT_WEIGHT = 4;

export const testCheck: EvalCheck = {
  name: 'test',

  async run(workDir: string, task: EvalTask): Promise<EvalCheckResult> {
    const start = Date.now();
    const weight = task.checks?.test?.weight ?? DEFAULT_WEIGHT;

    // Check if package.json exists
    if (!existsSync(join(workDir, 'package.json'))) {
      return {
        name: 'test',
        passed: false,
        score: 0,
        weight,
        details: 'No package.json found — cannot run tests',
        duration_ms: Date.now() - start,
      };
    }

    // Install dependencies
    try {
      execFileSync('npm', ['install', '--ignore-scripts'], {
        cwd: workDir,
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const stderr = (err as { stderr?: Buffer })?.stderr?.toString()?.slice(0, 500) ?? '';
      return {
        name: 'test',
        passed: false,
        score: 0,
        weight,
        details: `npm install failed: ${stderr}`.slice(0, 2000),
        errors: ['npm install failed'],
        duration_ms: Date.now() - start,
      };
    }

    // Run tests
    const testCommand = task.checks?.test?.command ?? 'npm test';
    const [cmd, ...cmdArgs] = testCommand.split(' ');

    try {
      const result = execFileSync(cmd, cmdArgs, {
        cwd: workDir,
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const output = result.toString().trim();

      return {
        name: 'test',
        passed: true,
        score: 1.0,
        weight,
        details: `Tests passed.\n${output}`.slice(0, 2000),
        duration_ms: Date.now() - start,
      };
    } catch (err) {
      const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? '';
      const stdout = (err as { stdout?: Buffer })?.stdout?.toString() ?? '';
      const output = (stderr + '\n' + stdout).trim();

      return {
        name: 'test',
        passed: false,
        score: 0,
        weight,
        details: `Tests failed.\n${output}`.slice(0, 2000),
        errors: ['Test suite failed'],
        duration_ms: Date.now() - start,
      };
    }
  },
};
