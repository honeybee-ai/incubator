import { exec } from 'node:child_process';
import { safePath } from '../sandbox.js';
import type { Guard } from '../guard.js';
import { scanInput } from '../guard.js';
import { type ToolResult, textResult, errorResult } from './types.js';

const DEFAULT_TIMEOUT = 60_000; // 60s
const MAX_OUTPUT = 100 * 1024; // 100KB

export async function runHandler(
  args: { command: string; cwd?: string; timeout?: number },
  workDir: string,
  guard: Guard | null,
  verbose?: boolean,
): Promise<ToolResult> {
  const blocked = scanInput(guard, [args.command], verbose);
  if (blocked) return errorResult(blocked);

  const cwd = args.cwd ? safePath(workDir, args.cwd) : workDir;
  const timeout = args.timeout ?? DEFAULT_TIMEOUT;

  return new Promise((resolve) => {
    const proc = exec(args.command, {
      cwd,
      timeout,
      maxBuffer: MAX_OUTPUT,
      env: { ...process.env, HOME: process.env.HOME },
    }, (err, stdout, stderr) => {
      let output = stdout || '';
      if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr;

      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT) + '\n... (output truncated)';
      }

      if (err) {
        const exitCode = (err as NodeJS.ErrnoException & { code?: number | string }).code;
        resolve(textResult({
          exitCode: typeof exitCode === 'number' ? exitCode : 1,
          output,
          error: err.killed ? 'Command timed out' : err.message,
        }));
        return;
      }

      resolve(textResult({ exitCode: 0, output }));
    });

    // Safety: kill on timeout (exec handles this too, but belt & suspenders)
    setTimeout(() => {
      proc.kill('SIGKILL');
    }, timeout + 1000);
  });
}
