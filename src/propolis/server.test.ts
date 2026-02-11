import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server.js';

describe('Propolis MCP Server', () => {
  let workDir: string;
  let client: Client;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'propolis-server-'));
    await writeFile(join(workDir, 'test.txt'), 'Hello from test');

    const server = createServer({ workDir, noGuard: true });
    client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  it('lists all 13 tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(13);
    const names = tools.map(t => t.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('patch_file');
    expect(names).toContain('list_files');
    expect(names).toContain('glob');
    expect(names).toContain('grep');
    expect(names).toContain('run');
    expect(names).toContain('git_status');
    expect(names).toContain('git_diff');
    expect(names).toContain('git_commit');
    expect(names).toContain('git_log');
  });

  it('read_file via MCP', async () => {
    const result = await callTool('read_file', { path: 'test.txt' });
    expect(result).toBe('Hello from test');
  });

  it('write_file + read_file round-trip via MCP', async () => {
    await callTool('write_file', { path: 'new.txt', content: 'written via MCP' });
    const result = await callTool('read_file', { path: 'new.txt' });
    expect(result).toBe('written via MCP');
  });

  it('run via MCP', async () => {
    const result = await callTool('run', { command: 'echo test123' });
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('test123');
  });

  it('list_files via MCP', async () => {
    const result = await callTool('list_files', {});
    expect(result.entries).toContain('test.txt');
  });

  it('rejects path traversal via MCP', async () => {
    const result = await callTool('read_file', { path: '../../../etc/passwd' });
    expect(result.error).toContain('escapes');
  });
});
