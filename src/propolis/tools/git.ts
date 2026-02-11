import { exec } from 'node:child_process';
import { safePath } from '../sandbox.js';
import type { Guard } from '../guard.js';
import { scanInput } from '../guard.js';
import { type ToolResult, textResult, errorResult } from './types.js';

function execGit(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

// ─── git_status ───────────────────────────────────────────

export async function gitStatusHandler(
  _args: Record<string, never>,
  workDir: string,
): Promise<ToolResult> {
  try {
    const output = await execGit('git status --porcelain', workDir);
    return textResult(output || '(clean)');
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

// ─── git_diff ─────────────────────────────────────────────

export async function gitDiffHandler(
  args: { path?: string; staged?: boolean },
  workDir: string,
  guard: Guard | null,
  verbose?: boolean,
): Promise<ToolResult> {
  const blocked = scanInput(guard, [args.path], verbose);
  if (blocked) return errorResult(blocked);

  try {
    let cmd = 'git diff';
    if (args.staged) cmd += ' --staged';
    if (args.path) {
      const abs = safePath(workDir, args.path);
      cmd += ` -- "${abs}"`;
    }
    const output = await execGit(cmd, workDir);
    return textResult(output || '(no diff)');
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

// ─── git_commit ───────────────────────────────────────────

export async function gitCommitHandler(
  args: { message: string; files?: string },
  workDir: string,
  guard: Guard | null,
  verbose?: boolean,
): Promise<ToolResult> {
  const blocked = scanInput(guard, [args.message, args.files], verbose);
  if (blocked) return errorResult(blocked);

  try {
    // Stage files
    if (args.files) {
      const fileList = args.files.split(',').map(f => f.trim()).filter(Boolean);
      for (const f of fileList) {
        const abs = safePath(workDir, f);
        await execGit(`git add "${abs}"`, workDir);
      }
    } else {
      await execGit('git add -A', workDir);
    }

    // Commit — pass message via stdin to avoid shell escaping issues
    const output = await new Promise<string>((resolve, reject) => {
      const proc = exec('git commit -F -', { cwd: workDir, timeout: 30_000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
          return;
        }
        resolve(stdout.trim());
      });
      proc.stdin?.write(args.message);
      proc.stdin?.end();
    });

    return textResult({ success: true, output });
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

// ─── git_log ──────────────────────────────────────────────

export async function gitLogHandler(
  args: { count?: number },
  workDir: string,
): Promise<ToolResult> {
  try {
    const n = args.count ?? 10;
    const output = await execGit(`git log --oneline -n ${n}`, workDir);
    return textResult(output || '(no commits)');
  } catch (err) {
    return errorResult((err as Error).message);
  }
}
