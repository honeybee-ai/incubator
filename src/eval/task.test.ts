import { describe, it, expect, afterEach } from 'vitest';
import { parseEvalTask } from './task.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

function tmpFile(content: string): string {
  const dir = join(tmpdir(), `eval-task-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'task.yaml');
  writeFileSync(path, content);
  return path;
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tmpDirs.length = 0;
});

describe('parseEvalTask', () => {
  it('parses a minimal valid task', () => {
    const path = tmpFile(`
name: test-task
task: Build a thing
`);
    tmpDirs.push(join(path, '..'));

    const task = parseEvalTask(path);
    expect(task.name).toBe('test-task');
    expect(task.task).toBe('Build a thing');
    expect(task.description).toBe('');
    expect(task.seed).toBeUndefined();
    expect(task.expected_files).toBeUndefined();
    expect(task.checks).toBeUndefined();
  });

  it('parses a full task with all fields', () => {
    const path = tmpFile(`
name: full-task
description: A comprehensive task
task: Build a REST API
seed:
  package.json: '{"name": "test"}'
  src/index.ts: 'console.log("hi")'
expected_files:
  - src/**/*.ts
checks:
  typecheck:
    weight: 3
  test:
    weight: 4
    command: npx vitest run
metrics:
  max_duration_s: 300
brood: custom/brood.yaml
provider: cerebras/llama-3.3-70b
`);
    tmpDirs.push(join(path, '..'));

    const task = parseEvalTask(path);
    expect(task.name).toBe('full-task');
    expect(task.description).toBe('A comprehensive task');
    expect(task.seed).toHaveProperty('package.json');
    expect(task.expected_files).toEqual(['src/**/*.ts']);
    expect(task.checks?.typecheck?.weight).toBe(3);
    expect(task.checks?.test?.command).toBe('npx vitest run');
    expect(task.metrics?.max_duration_s).toBe(300);
    expect(task.brood).toBe('custom/brood.yaml');
    expect(task.provider).toBe('cerebras/llama-3.3-70b');
  });

  it('throws on missing name', () => {
    const path = tmpFile(`task: Build a thing`);
    tmpDirs.push(join(path, '..'));
    expect(() => parseEvalTask(path)).toThrow('requires a "name"');
  });

  it('throws on missing task', () => {
    const path = tmpFile(`name: test`);
    tmpDirs.push(join(path, '..'));
    expect(() => parseEvalTask(path)).toThrow('requires a "task"');
  });

  it('throws on invalid check weight', () => {
    const path = tmpFile(`
name: test
task: Build
checks:
  typecheck:
    weight: -1
`);
    tmpDirs.push(join(path, '..'));
    expect(() => parseEvalTask(path)).toThrow('positive "weight"');
  });
});
