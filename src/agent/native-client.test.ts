import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NativeToolClient } from './native-client.js';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let workDir: string;

beforeEach(() => {
  workDir = join(tmpdir(), `native-client-test-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe('NativeToolClient', () => {
  it('exposes all 13 tool defs by default', () => {
    const client = new NativeToolClient(workDir, null);
    const defs = client.getToolDefs();
    expect(defs.length).toBe(13);

    const names = defs.map(d => d.function.name).sort();
    expect(names).toEqual([
      'fetch', 'git_commit', 'git_diff', 'git_log', 'git_status',
      'glob', 'grep', 'list_files', 'patch_file',
      'read_file', 'run', 'scrape_page', 'write_file',
    ]);
  });

  it('filters tools by whitelist', () => {
    const client = new NativeToolClient(workDir, null, false, ['read_file', 'write_file']);
    const defs = client.getToolDefs();
    expect(defs.length).toBe(2);

    const names = defs.map(d => d.function.name).sort();
    expect(names).toEqual(['read_file', 'write_file']);
  });

  it('hasToolName checks correctly', () => {
    const client = new NativeToolClient(workDir, null);
    expect(client.hasToolName('read_file')).toBe(true);
    expect(client.hasToolName('nonexistent')).toBe(false);
  });

  it('hasToolName respects filter', () => {
    const client = new NativeToolClient(workDir, null, false, ['read_file']);
    expect(client.hasToolName('read_file')).toBe(true);
    expect(client.hasToolName('write_file')).toBe(false);
  });

  it('callTool reads a file', async () => {
    writeFileSync(join(workDir, 'hello.txt'), 'world');
    const client = new NativeToolClient(workDir, null);
    const result = await client.callTool('read_file', { path: 'hello.txt' });
    expect(result).toBe('world');
  });

  it('callTool writes a file', async () => {
    const client = new NativeToolClient(workDir, null);
    const result = await client.callTool('write_file', { path: 'out.txt', content: 'test content' });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(readFileSync(join(workDir, 'out.txt'), 'utf-8')).toBe('test content');
  });

  it('callTool returns error for unknown tool', async () => {
    const client = new NativeToolClient(workDir, null);
    const result = await client.callTool('nonexistent', {});
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('Unknown tool');
  });

  it('callTool patches a file', async () => {
    writeFileSync(join(workDir, 'patch.txt'), 'hello world');
    const client = new NativeToolClient(workDir, null);
    const result = await client.callTool('patch_file', { path: 'patch.txt', search: 'world', replace: 'earth' });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(readFileSync(join(workDir, 'patch.txt'), 'utf-8')).toBe('hello earth');
  });

  it('callTool lists files', async () => {
    writeFileSync(join(workDir, 'a.txt'), '');
    writeFileSync(join(workDir, 'b.txt'), '');
    const client = new NativeToolClient(workDir, null);
    const result = await client.callTool('list_files', {});
    const parsed = JSON.parse(result);
    expect(parsed.entries).toContain('a.txt');
    expect(parsed.entries).toContain('b.txt');
  });

  it('callTool runs a command', async () => {
    const client = new NativeToolClient(workDir, null);
    const result = await client.callTool('run', { command: 'echo hello' });
    const parsed = JSON.parse(result);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.output).toContain('hello');
  });

  it('close is a no-op', async () => {
    const client = new NativeToolClient(workDir, null);
    await client.close(); // Should not throw
  });

  it('callTool returns error for path traversal', async () => {
    const client = new NativeToolClient(workDir, null);
    const result = await client.callTool('read_file', { path: '../../etc/passwd' });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('escapes');
  });
});
