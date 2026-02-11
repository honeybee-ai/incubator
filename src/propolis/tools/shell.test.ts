import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHandler } from './shell.js';

describe('shell tool', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'propolis-shell-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function getJson(result: { content: Array<{ text: string }> }): Record<string, unknown> {
    return JSON.parse(result.content[0].text);
  }

  it('executes a simple command', async () => {
    const result = await runHandler({ command: 'echo hello' }, workDir, null);
    const data = getJson(result);
    expect(data.exitCode).toBe(0);
    expect((data.output as string).trim()).toBe('hello');
  });

  it('captures exit code on failure', async () => {
    const result = await runHandler({ command: 'false' }, workDir, null);
    const data = getJson(result);
    expect(data.exitCode).not.toBe(0);
  });

  it('respects timeout', async () => {
    const result = await runHandler({ command: 'sleep 30', timeout: 500 }, workDir, null);
    const data = getJson(result);
    expect(data.error).toContain('timed out');
  }, 10_000);

  it('runs in workDir', async () => {
    const result = await runHandler({ command: 'pwd' }, workDir, null);
    const data = getJson(result);
    expect((data.output as string).trim()).toBe(workDir);
  });

  it('captures stderr', async () => {
    const result = await runHandler({ command: 'echo err >&2' }, workDir, null);
    const data = getJson(result);
    expect((data.output as string).trim()).toContain('err');
  });
});
