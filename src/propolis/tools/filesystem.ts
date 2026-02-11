import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { safePath } from '../sandbox.js';
import type { Guard } from '../guard.js';
import { scanInput } from '../guard.js';
import { type ToolResult, textResult, errorResult } from './types.js';

const MAX_FILE_SIZE = 500 * 1024; // 500KB
const MAX_LIST_ENTRIES = 1000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '__pycache__', '.cache', 'dist', 'build']);

// ─── read_file ────────────────────────────────────────────

export async function readFileHandler(
  args: { path: string },
  workDir: string,
  guard: Guard | null,
  verbose?: boolean,
): Promise<ToolResult> {
  const blocked = scanInput(guard, [args.path], verbose);
  if (blocked) return errorResult(blocked);

  try {
    const abs = safePath(workDir, args.path);
    const stats = await stat(abs);
    if (stats.size > MAX_FILE_SIZE) {
      return errorResult(`File too large (${Math.round(stats.size / 1024)}KB, max ${MAX_FILE_SIZE / 1024}KB)`);
    }
    const content = await readFile(abs, 'utf-8');
    return textResult(content);
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

// ─── write_file ───────────────────────────────────────────

export async function writeFileHandler(
  args: { path: string; content: string },
  workDir: string,
  guard: Guard | null,
  verbose?: boolean,
): Promise<ToolResult> {
  const blocked = scanInput(guard, [args.path, args.content], verbose);
  if (blocked) return errorResult(blocked);

  try {
    const abs = safePath(workDir, args.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, args.content, 'utf-8');
    return textResult({ success: true, path: args.path, bytes: Buffer.byteLength(args.content) });
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

// ─── patch_file ───────────────────────────────────────────

export async function patchFileHandler(
  args: { path: string; search: string; replace: string },
  workDir: string,
  guard: Guard | null,
  verbose?: boolean,
): Promise<ToolResult> {
  const blocked = scanInput(guard, [args.path, args.search, args.replace], verbose);
  if (blocked) return errorResult(blocked);

  try {
    const abs = safePath(workDir, args.path);
    const content = await readFile(abs, 'utf-8');

    if (!content.includes(args.search)) {
      return errorResult(`Search string not found in ${args.path}`);
    }

    const newContent = content.replace(args.search, args.replace);
    await writeFile(abs, newContent, 'utf-8');
    return textResult({ success: true, path: args.path });
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

// ─── list_files ───────────────────────────────────────────

export async function listFilesHandler(
  args: { path?: string; recursive?: boolean },
  workDir: string,
  guard: Guard | null,
  verbose?: boolean,
): Promise<ToolResult> {
  const blocked = scanInput(guard, [args.path], verbose);
  if (blocked) return errorResult(blocked);

  try {
    const abs = args.path ? safePath(workDir, args.path) : workDir;
    const entries: string[] = [];

    async function walk(dir: string): Promise<void> {
      if (entries.length >= MAX_LIST_ENTRIES) return;

      const items = await readdir(dir, { withFileTypes: true });
      for (const item of items) {
        if (entries.length >= MAX_LIST_ENTRIES) return;
        if (SKIP_DIRS.has(item.name)) continue;

        const fullPath = join(dir, item.name);
        const relPath = relative(workDir, fullPath);
        entries.push(item.isDirectory() ? relPath + '/' : relPath);

        if (item.isDirectory() && args.recursive) {
          await walk(fullPath);
        }
      }
    }

    await walk(abs);
    return textResult({ entries, count: entries.length, truncated: entries.length >= MAX_LIST_ENTRIES });
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

// ─── glob ─────────────────────────────────────────────────

export async function globHandler(
  args: { pattern: string; path?: string },
  workDir: string,
  guard: Guard | null,
  verbose?: boolean,
): Promise<ToolResult> {
  const blocked = scanInput(guard, [args.pattern, args.path], verbose);
  if (blocked) return errorResult(blocked);

  try {
    const baseDir = args.path ? safePath(workDir, args.path) : workDir;
    const matches = await globMatch(baseDir, workDir, args.pattern);
    return textResult({ matches, count: matches.length });
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

async function globMatch(baseDir: string, workDir: string, pattern: string): Promise<string[]> {
  const results: string[] = [];
  const regex = globToRegex(pattern);

  async function walk(dir: string): Promise<void> {
    if (results.length >= MAX_LIST_ENTRIES) return;

    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const item of items) {
      if (results.length >= MAX_LIST_ENTRIES) return;
      if (SKIP_DIRS.has(item.name)) continue;

      const fullPath = join(dir, item.name);
      const relPath = relative(workDir, fullPath);

      if (regex.test(relPath)) {
        results.push(relPath);
      }

      if (item.isDirectory()) {
        await walk(fullPath);
      }
    }
  }

  await walk(baseDir);
  return results;
}

export function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      // ** matches any path segments
      regex += '.*';
      i += 2;
      if (pattern[i] === '/') i++; // skip trailing /
    } else if (c === '*') {
      regex += '[^/]*';
      i++;
    } else if (c === '?') {
      regex += '[^/]';
      i++;
    } else if (c === '.') {
      regex += '\\.';
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  return new RegExp(`^${regex}$`);
}

// ─── grep ─────────────────────────────────────────────────

export async function grepHandler(
  args: { pattern: string; path?: string; glob?: string },
  workDir: string,
  guard: Guard | null,
  verbose?: boolean,
): Promise<ToolResult> {
  const blocked = scanInput(guard, [args.pattern, args.path, args.glob], verbose);
  if (blocked) return errorResult(blocked);

  try {
    const baseDir = args.path ? safePath(workDir, args.path) : workDir;
    const regex = new RegExp(args.pattern);
    const fileFilter = args.glob ? globToRegex(args.glob) : null;
    const matches: Array<{ file: string; line: number; text: string }> = [];
    const MAX_MATCHES = 200;

    async function searchDir(dir: string): Promise<void> {
      if (matches.length >= MAX_MATCHES) return;

      let items;
      try {
        items = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const item of items) {
        if (matches.length >= MAX_MATCHES) return;
        if (SKIP_DIRS.has(item.name)) continue;

        const fullPath = join(dir, item.name);

        if (item.isDirectory()) {
          await searchDir(fullPath);
        } else if (item.isFile()) {
          const relPath = relative(workDir, fullPath);
          if (fileFilter && !fileFilter.test(relPath)) continue;

          try {
            const stats = await stat(fullPath);
            if (stats.size > MAX_FILE_SIZE) continue;
            const content = await readFile(fullPath, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (matches.length >= MAX_MATCHES) break;
              if (regex.test(lines[i])) {
                matches.push({ file: relPath, line: i + 1, text: lines[i].slice(0, 200) });
              }
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    }

    await searchDir(baseDir);
    return textResult({ matches, count: matches.length, truncated: matches.length >= MAX_MATCHES });
  } catch (err) {
    return errorResult((err as Error).message);
  }
}
