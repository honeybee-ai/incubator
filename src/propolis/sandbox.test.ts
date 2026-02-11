import { describe, it, expect } from 'vitest';
import { safePath } from './sandbox.js';

describe('safePath', () => {
  const workDir = '/tmp/test-workspace';

  it('resolves relative paths within workDir', () => {
    expect(safePath(workDir, 'hello.txt')).toBe('/tmp/test-workspace/hello.txt');
    expect(safePath(workDir, 'src/main.ts')).toBe('/tmp/test-workspace/src/main.ts');
  });

  it('rejects paths that escape via ../', () => {
    expect(() => safePath(workDir, '../etc/passwd')).toThrow('escapes the working directory');
    expect(() => safePath(workDir, 'src/../../outside')).toThrow('escapes the working directory');
  });

  it('rejects absolute paths outside workDir', () => {
    expect(() => safePath(workDir, '/etc/passwd')).toThrow('escapes the working directory');
  });

  it('allows absolute paths within workDir', () => {
    expect(safePath(workDir, '/tmp/test-workspace/file.txt')).toBe('/tmp/test-workspace/file.txt');
  });

  it('normalizes paths with ./', () => {
    expect(safePath(workDir, './src/file.ts')).toBe('/tmp/test-workspace/src/file.ts');
  });
});
