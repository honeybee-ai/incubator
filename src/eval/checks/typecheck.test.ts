import { describe, it, expect, afterEach } from 'vitest';
import { typecheckCheck } from './typecheck.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { EvalTask } from '../types.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `eval-ts-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTask(weight = 3): EvalTask {
  return {
    name: 'test',
    description: '',
    task: 'test',
    checks: { typecheck: { weight } },
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tmpDirs.length = 0;
});

describe('typecheckCheck', () => {
  it('skips when no tsconfig.json', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);

    const result = await typecheckCheck.run(dir, makeTask());
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.details).toContain('Skipped');
  });

  it('passes for valid TypeScript', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
      },
      include: ['src'],
    }));
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const x: number = 42;\n');

    const result = await typecheckCheck.run(dir, makeTask());
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
  }, 30_000);

  it('fails for invalid TypeScript', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
      },
      include: ['src'],
    }));
    writeFileSync(join(dir, 'src', 'bad.ts'), 'const x: number = "not a number";\n');

    const result = await typecheckCheck.run(dir, makeTask());
    expect(result.passed).toBe(false);
    expect(result.score).toBeLessThan(1.0);
  }, 30_000);

  it('uses configured weight', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);

    const result = await typecheckCheck.run(dir, makeTask(5));
    expect(result.weight).toBe(5);
  });
});
