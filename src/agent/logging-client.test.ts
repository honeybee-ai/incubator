import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LoggingToolClient } from './logging-client.js';
import type { ToolClient } from './tool-client.js';

function mockToolClient(result = '{"ok":true}'): ToolClient {
  return {
    getToolDefs: vi.fn(() => [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {}, required: [] } } }]),
    hasToolName: vi.fn((name: string) => name === 'read_file' || name === 'run'),
    callTool: vi.fn(async () => result),
    close: vi.fn(async () => {}),
  };
}

function mockTelemetry() {
  return { record: vi.fn() } as unknown as { record: ReturnType<typeof vi.fn> };
}

describe('LoggingToolClient', () => {
  let inner: ToolClient;
  let telemetry: ReturnType<typeof mockTelemetry>;
  let client: LoggingToolClient;

  beforeEach(() => {
    inner = mockToolClient();
    telemetry = mockTelemetry();
    client = new LoggingToolClient(inner, telemetry as any, 'agent_abc', 'developer');
  });

  it('delegates getToolDefs to inner', () => {
    const defs = client.getToolDefs();
    expect(defs).toHaveLength(1);
    expect(inner.getToolDefs).toHaveBeenCalled();
  });

  it('delegates hasToolName to inner', () => {
    expect(client.hasToolName('read_file')).toBe(true);
    expect(client.hasToolName('nonexistent')).toBe(false);
  });

  it('delegates close to inner', async () => {
    await client.close();
    expect(inner.close).toHaveBeenCalled();
  });

  it('records tool_call_detailed telemetry on success', async () => {
    const result = await client.callTool('read_file', { path: 'src/app.ts' });
    expect(result).toBe('{"ok":true}');
    expect(telemetry.record).toHaveBeenCalledOnce();

    const [type, meta] = telemetry.record.mock.calls[0];
    expect(type).toBe('tool_call_detailed');
    expect(meta.agentId).toBe('agent_abc');
    expect(meta.role).toBe('developer');
    expect(meta.tool).toBe('read_file');
    expect(meta.success).toBe(true);
    expect(meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(meta.resultBytes).toBeGreaterThan(0);
    expect(meta.args).toEqual({ path: 'src/app.ts' });
  });

  it('records telemetry on error and rethrows', async () => {
    const failClient = mockToolClient();
    (failClient.callTool as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    client = new LoggingToolClient(failClient, telemetry as any, 'agent_x', 'tester');

    await expect(client.callTool('read_file', { path: 'bad' })).rejects.toThrow('boom');

    const [type, meta] = telemetry.record.mock.calls[0];
    expect(type).toBe('tool_call_detailed');
    expect(meta.success).toBe(false);
    expect(meta.error).toBe('boom');
  });

  it('sanitizes content field in args', async () => {
    await client.callTool('write_file', { path: 'out.txt', content: 'x'.repeat(5000) });
    const meta = telemetry.record.mock.calls[0][1];
    expect(meta.args.content).toBe('[5000 bytes]');
  });

  it('truncates long replace field', async () => {
    await client.callTool('patch_file', { path: 'f.ts', search: 'old', replace: 'x'.repeat(200) });
    const meta = telemetry.record.mock.calls[0][1];
    expect(meta.args.replace).toHaveLength(103); // 100 + '...'
  });

  it('truncates long string values', async () => {
    await client.callTool('read_file', { path: 'a'.repeat(1000) });
    const meta = telemetry.record.mock.calls[0][1];
    expect(meta.args.path).toHaveLength(503);
  });

  describe('shell command parsing', () => {
    it('extracts shell command name for run tool', async () => {
      await client.callTool('run', { command: 'cat src/app.ts' });
      const meta = telemetry.record.mock.calls[0][1];
      expect(meta.shellCommand).toBe('cat');
      expect(meta.hasPipes).toBe(false);
      expect(meta.hasRedirects).toBe(false);
      expect(meta.hasChains).toBe(false);
    });

    it('detects pipes', async () => {
      await client.callTool('run', { command: 'cat file.ts | grep function | wc -l' });
      const meta = telemetry.record.mock.calls[0][1];
      expect(meta.shellCommand).toBe('cat');
      expect(meta.hasPipes).toBe(true);
    });

    it('detects redirects', async () => {
      await client.callTool('run', { command: 'echo hello > out.txt' });
      const meta = telemetry.record.mock.calls[0][1];
      expect(meta.shellCommand).toBe('echo');
      expect(meta.hasRedirects).toBe(true);
    });

    it('detects chains', async () => {
      await client.callTool('run', { command: 'mkdir -p dir && cd dir' });
      const meta = telemetry.record.mock.calls[0][1];
      expect(meta.shellCommand).toBe('mkdir');
      expect(meta.hasChains).toBe(true);
    });

    it('skips env vars to find command name', async () => {
      await client.callTool('run', { command: 'NODE_ENV=test pnpm test' });
      const meta = telemetry.record.mock.calls[0][1];
      expect(meta.shellCommand).toBe('pnpm');
    });

    it('truncates long raw commands', async () => {
      await client.callTool('run', { command: 'echo ' + 'x'.repeat(300) });
      const meta = telemetry.record.mock.calls[0][1];
      expect(meta.rawCommand.length).toBeLessThanOrEqual(203);
    });

    it('does not add shell metadata for non-run tools', async () => {
      await client.callTool('read_file', { path: 'file.ts' });
      const meta = telemetry.record.mock.calls[0][1];
      expect(meta.shellCommand).toBeUndefined();
    });
  });
});
