import { describe, it, expect, afterEach } from 'vitest';
import { structureCheck } from './structure.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { EvalTask } from '../types.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `eval-struct-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTask(expected_files: string[], weight = 1): EvalTask {
  return {
    name: 'test',
    description: '',
    task: 'test',
    expected_files,
    checks: { structure: { weight } },
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tmpDirs.length = 0;
});

describe('structureCheck', () => {
  it('passes when all expected files exist', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;');

    const result = await structureCheck.run(dir, makeTask(['src/index.ts']));
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
  });

  it('fails when expected file is missing', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);

    const result = await structureCheck.run(dir, makeTask(['src/index.ts']));
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.errors).toBeDefined();
  });

  it('matches glob patterns', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;');

    const result = await structureCheck.run(dir, makeTask(['src/**/*.ts']));
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
  });

  it('partial match gives proportional score', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;');

    const result = await structureCheck.run(dir, makeTask(['src/index.ts', 'src/missing.ts']));
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.5);
  });

  it('skips when no expected files configured', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);

    const result = await structureCheck.run(dir, makeTask([]));
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.details).toContain('skipped');
  });

  it('rejects empty files', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'empty.ts'), '');

    const result = await structureCheck.run(dir, makeTask(['src/empty.ts']));
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
  });
});
