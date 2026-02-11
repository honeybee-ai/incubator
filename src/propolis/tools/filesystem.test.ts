import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileHandler, writeFileHandler, patchFileHandler, listFilesHandler, globHandler, grepHandler } from './filesystem.js';

describe('filesystem tools', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'propolis-test-'));
    // Create test files
    await mkdir(join(workDir, 'src'), { recursive: true });
    await writeFile(join(workDir, 'hello.txt'), 'Hello, world!');
    await writeFile(join(workDir, 'src/main.ts'), 'export function main() { return 42; }');
    await writeFile(join(workDir, 'src/util.ts'), 'export const PI = 3.14;');
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function getText(result: { content: Array<{ text: string }> }): string {
    return result.content[0].text;
  }

  function getJson(result: { content: Array<{ text: string }> }): unknown {
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return result.content[0].text;
    }
  }

  // ─── read_file ──────────────────────────────────────

  describe('read_file', () => {
    it('reads an existing file', async () => {
      const result = await readFileHandler({ path: 'hello.txt' }, workDir, null);
      expect(getText(result)).toBe('Hello, world!');
    });

    it('returns error for missing file', async () => {
      const result = await readFileHandler({ path: 'nope.txt' }, workDir, null);
      const data = getJson(result) as { error: string };
      expect(data.error).toContain('ENOENT');
    });

    it('rejects path traversal', async () => {
      const result = await readFileHandler({ path: '../../../etc/passwd' }, workDir, null);
      const data = getJson(result) as { error: string };
      expect(data.error).toContain('escapes');
    });
  });

  // ─── write_file ─────────────────────────────────────

  describe('write_file', () => {
    it('writes a new file', async () => {
      const result = await writeFileHandler({ path: 'new.txt', content: 'hi' }, workDir, null);
      const data = getJson(result) as { success: boolean };
      expect(data.success).toBe(true);
      expect(await readFile(join(workDir, 'new.txt'), 'utf-8')).toBe('hi');
    });

    it('creates parent directories', async () => {
      const result = await writeFileHandler({ path: 'deep/nested/file.txt', content: 'deep' }, workDir, null);
      const data = getJson(result) as { success: boolean };
      expect(data.success).toBe(true);
      expect(await readFile(join(workDir, 'deep/nested/file.txt'), 'utf-8')).toBe('deep');
    });
  });

  // ─── patch_file ─────────────────────────────────────

  describe('patch_file', () => {
    it('replaces text in file', async () => {
      const result = await patchFileHandler(
        { path: 'hello.txt', search: 'world', replace: 'propolis' },
        workDir, null,
      );
      const data = getJson(result) as { success: boolean };
      expect(data.success).toBe(true);
      expect(await readFile(join(workDir, 'hello.txt'), 'utf-8')).toBe('Hello, propolis!');
    });

    it('returns error if search string not found', async () => {
      const result = await patchFileHandler(
        { path: 'hello.txt', search: 'nonexistent', replace: 'x' },
        workDir, null,
      );
      const data = getJson(result) as { error: string };
      expect(data.error).toContain('not found');
    });
  });

  // ─── list_files ─────────────────────────────────────

  describe('list_files', () => {
    it('lists root directory', async () => {
      const result = await listFilesHandler({}, workDir, null);
      const data = getJson(result) as { entries: string[] };
      expect(data.entries).toContain('hello.txt');
      expect(data.entries).toContain('src/');
    });

    it('lists recursively', async () => {
      const result = await listFilesHandler({ recursive: true }, workDir, null);
      const data = getJson(result) as { entries: string[] };
      expect(data.entries).toContain('src/main.ts');
      expect(data.entries).toContain('src/util.ts');
    });

    it('lists subdirectory', async () => {
      const result = await listFilesHandler({ path: 'src' }, workDir, null);
      const data = getJson(result) as { entries: string[] };
      expect(data.entries).toContain('src/main.ts');
    });
  });

  // ─── glob ───────────────────────────────────────────

  describe('glob', () => {
    it('matches *.ts files', async () => {
      const result = await globHandler({ pattern: '**/*.ts' }, workDir, null);
      const data = getJson(result) as { matches: string[] };
      expect(data.matches).toContain('src/main.ts');
      expect(data.matches).toContain('src/util.ts');
    });

    it('matches specific directory', async () => {
      const result = await globHandler({ pattern: '*.txt' }, workDir, null);
      const data = getJson(result) as { matches: string[] };
      expect(data.matches).toContain('hello.txt');
    });
  });

  // ─── grep ───────────────────────────────────────────

  describe('grep', () => {
    it('finds matching lines', async () => {
      const result = await grepHandler({ pattern: 'export' }, workDir, null);
      const data = getJson(result) as { matches: Array<{ file: string; line: number; text: string }> };
      expect(data.matches.length).toBeGreaterThanOrEqual(2);
      expect(data.matches.some(m => m.file === 'src/main.ts')).toBe(true);
    });

    it('filters by glob', async () => {
      const result = await grepHandler({ pattern: 'PI', glob: '**/*.ts' }, workDir, null);
      const data = getJson(result) as { matches: Array<{ file: string }> };
      expect(data.matches.some(m => m.file === 'src/util.ts')).toBe(true);
    });
  });
});
