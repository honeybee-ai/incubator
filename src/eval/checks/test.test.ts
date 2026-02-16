import { describe, it, expect, afterEach } from 'vitest';
import { testCheck } from './test.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { EvalTask } from '../types.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `eval-test-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTask(command?: string, weight = 4): EvalTask {
  return {
    name: 'test',
    description: '',
    task: 'test',
    checks: { test: { weight, command } },
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tmpDirs.length = 0;
});

describe('testCheck', () => {
  it('fails when no package.json', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);

    const result = await testCheck.run(dir, makeTask());
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.details).toContain('No package.json');
  });

  it('passes with a successful test command', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-proj',
      scripts: { test: 'echo "all good"' },
    }));

    const result = await testCheck.run(dir, makeTask('echo ok'));
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
  }, 30_000);

  it('fails with a failing test command', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'test-proj',
      scripts: { test: 'exit 1' },
    }));

    const result = await testCheck.run(dir, makeTask('node -e process.exit(1)'));
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
  }, 30_000);

  it('uses configured weight', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);

    const result = await testCheck.run(dir, makeTask(undefined, 7));
    expect(result.weight).toBe(7);
  });
});
