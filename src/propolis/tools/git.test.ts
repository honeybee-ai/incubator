import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { gitStatusHandler, gitDiffHandler, gitCommitHandler, gitLogHandler } from './git.js';

describe('git tools', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'propolis-git-'));
    // Init a git repo
    execSync('git init', { cwd: workDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: workDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: workDir, stdio: 'ignore' });
    // Create initial commit
    await writeFile(join(workDir, 'README.md'), '# Test');
    execSync('git add -A && git commit -m "initial"', { cwd: workDir, stdio: 'ignore' });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function getText(result: { content: Array<{ text: string }> }): string {
    return result.content[0].text;
  }

  function getJson(result: { content: Array<{ text: string }> }): Record<string, unknown> {
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return { text: result.content[0].text };
    }
  }

  describe('git_status', () => {
    it('shows clean status', async () => {
      const result = await gitStatusHandler({} as Record<string, never>, workDir);
      expect(getText(result)).toBe('(clean)');
    });

    it('shows modified files', async () => {
      await writeFile(join(workDir, 'new.txt'), 'new');
      const result = await gitStatusHandler({} as Record<string, never>, workDir);
      expect(getText(result)).toContain('new.txt');
    });
  });

  describe('git_diff', () => {
    it('shows no diff on clean repo', async () => {
      const result = await gitDiffHandler({}, workDir, null);
      expect(getText(result)).toBe('(no diff)');
    });

    it('shows diff for modified file', async () => {
      await writeFile(join(workDir, 'README.md'), '# Updated');
      const result = await gitDiffHandler({}, workDir, null);
      expect(getText(result)).toContain('Updated');
    });
  });

  describe('git_commit', () => {
    it('commits changes', async () => {
      await writeFile(join(workDir, 'feature.ts'), 'export const x = 1;');
      const result = await gitCommitHandler({ message: 'add feature' }, workDir, null);
      const data = getJson(result);
      expect(data.success).toBe(true);

      // Verify via git log
      const logResult = await gitLogHandler({ count: 1 }, workDir);
      expect(getText(logResult)).toContain('add feature');
    });

    it('commits specific files', async () => {
      await writeFile(join(workDir, 'a.txt'), 'a');
      await writeFile(join(workDir, 'b.txt'), 'b');
      const result = await gitCommitHandler({ message: 'just a', files: 'a.txt' }, workDir, null);
      const data = getJson(result);
      expect(data.success).toBe(true);

      // b.txt should still be untracked
      const status = await gitStatusHandler({} as Record<string, never>, workDir);
      expect(getText(status)).toContain('b.txt');
    });
  });

  describe('git_log', () => {
    it('shows commit history', async () => {
      const result = await gitLogHandler({ count: 5 }, workDir);
      expect(getText(result)).toContain('initial');
    });
  });
});
