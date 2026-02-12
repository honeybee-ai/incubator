import { describe, it, expect, vi } from 'vitest';
import { NativeToolClient } from './native-client.js';
import type { ToolEntry } from '@honeybee-ai/hivemind-sdk/integrations';

// Mock tool entries (propolis-shaped)
function makeMockEntries(): ToolEntry[] {
  return [
    {
      def: {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string', description: 'path' } }, required: ['path'] },
        },
      },
      schema: {},
      handler: vi.fn(async (args: Record<string, unknown>) => ({
        content: [{ type: 'text' as const, text: `read: ${args.path}` }],
      })),
    },
    {
      def: {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write a file',
          parameters: { type: 'object', properties: { path: { type: 'string', description: 'path' }, content: { type: 'string', description: 'content' } }, required: ['path', 'content'] },
        },
      },
      schema: {},
      handler: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
      })),
    },
    {
      def: {
        type: 'function',
        function: {
          name: 'run',
          description: 'Execute shell command',
          parameters: { type: 'object', properties: { command: { type: 'string', description: 'cmd' } }, required: ['command'] },
        },
      },
      schema: {},
      handler: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'done' }],
      })),
    },
  ];
}

describe('NativeToolClient', () => {
  it('creates from ToolEntry array', () => {
    const entries = makeMockEntries();
    const client = new NativeToolClient(entries);
    expect(client.getToolDefs().length).toBe(3);
    expect(client.hasToolName('read_file')).toBe(true);
    expect(client.hasToolName('write_file')).toBe(true);
    expect(client.hasToolName('run')).toBe(true);
    expect(client.hasToolName('nonexistent')).toBe(false);
  });

  it('filters tools via whitelist', () => {
    const entries = makeMockEntries();
    const client = new NativeToolClient(entries, ['read_file', 'write_file']);
    expect(client.getToolDefs().length).toBe(2);
    expect(client.hasToolName('read_file')).toBe(true);
    expect(client.hasToolName('run')).toBe(false);
  });

  it('null filter means no filtering', () => {
    const entries = makeMockEntries();
    const client = new NativeToolClient(entries, null);
    expect(client.getToolDefs().length).toBe(3);
  });

  it('callTool invokes handler and unwraps ToolResult', async () => {
    const entries = makeMockEntries();
    const client = new NativeToolClient(entries);
    const result = await client.callTool('read_file', { path: 'test.txt' });
    expect(result).toBe('read: test.txt');
    expect(entries[0].handler).toHaveBeenCalledWith({ path: 'test.txt' });
  });

  it('callTool returns error for unknown tool', async () => {
    const entries = makeMockEntries();
    const client = new NativeToolClient(entries);
    const result = await client.callTool('nonexistent', {});
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('Unknown tool');
  });

  it('close is a no-op', async () => {
    const entries = makeMockEntries();
    const client = new NativeToolClient(entries);
    await client.close(); // Should not throw
  });

  it('works with empty entries array', () => {
    const client = new NativeToolClient([]);
    expect(client.getToolDefs().length).toBe(0);
    expect(client.hasToolName('anything')).toBe(false);
  });
});
