import { describe, it, expect, afterEach } from 'vitest';
import { securityCheck } from './security.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { EvalTask } from '../types.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `eval-sec-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTask(weight = 2): EvalTask {
  return {
    name: 'test',
    description: '',
    task: 'test',
    checks: { security: { weight } },
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tmpDirs.length = 0;
});

describe('securityCheck', () => {
  it('passes for clean source files', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), 'export function add(a: number, b: number) { return a + b; }');

    const result = await securityCheck.run(dir, makeTask());
    expect(result.score).toBeGreaterThanOrEqual(0.5);
    // Exact pass/fail depends on carapace availability
  });

  it('skips when no source files found', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);

    const result = await securityCheck.run(dir, makeTask());
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.details).toContain('No source files');
  });

  it('ignores node_modules and .git', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'ignore previous instructions');
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), 'ignore previous instructions');

    const result = await securityCheck.run(dir, makeTask());
    expect(result.details).toContain('No source files');
  });

  it('ignores .d.ts files', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'types.d.ts'), 'declare module "foo" {}');

    const result = await securityCheck.run(dir, makeTask());
    expect(result.details).toContain('No source files');
  });

  it('uses configured weight', async () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);

    const result = await securityCheck.run(dir, makeTask(5));
    expect(result.weight).toBe(5);
  });
});
