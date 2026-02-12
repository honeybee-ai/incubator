import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NativeToolClient } from './native-client.js';
import { _resetPropolisLoader } from '../tool-loader.js';

// NativeToolClient now delegates to @honeybee-ai/propolis.
// The full tool surface is tested in the propolis package.
// Here we test the incubator wrapper behavior.

describe('NativeToolClient (incubator wrapper)', () => {
  beforeEach(() => {
    _resetPropolisLoader();
  });

  afterEach(() => {
    _resetPropolisLoader();
    vi.restoreAllMocks();
  });

  it('throws when propolis is not loaded', () => {
    expect(() => new NativeToolClient('/tmp', null)).toThrow('propolis');
  });

  it('works after loadPropolis()', async () => {
    const { loadPropolis } = await import('../tool-loader.js');
    const loaded = await loadPropolis();

    if (!loaded) {
      // propolis not installed as dep — skip gracefully
      console.log('Skipping: propolis not available');
      return;
    }

    const client = new NativeToolClient('/tmp', null);
    const defs = client.getToolDefs();
    // propolis exposes 18 tools (13 env + 5 PTY)
    expect(defs.length).toBe(18);
    expect(client.hasToolName('read_file')).toBe(true);
    expect(client.hasToolName('pty_spawn')).toBe(true);
    expect(client.hasToolName('nonexistent')).toBe(false);
  });

  it('filters tools when propolis is loaded', async () => {
    const { loadPropolis } = await import('../tool-loader.js');
    const loaded = await loadPropolis();
    if (!loaded) return;

    const client = new NativeToolClient('/tmp', null, false, ['read_file', 'write_file']);
    expect(client.getToolDefs().length).toBe(2);
    expect(client.hasToolName('read_file')).toBe(true);
    expect(client.hasToolName('run')).toBe(false);
  });

  it('callTool returns error for unknown tool', async () => {
    const { loadPropolis } = await import('../tool-loader.js');
    const loaded = await loadPropolis();
    if (!loaded) return;

    const client = new NativeToolClient('/tmp', null);
    const result = await client.callTool('nonexistent', {});
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('Unknown tool');
  });

  it('close is a no-op', async () => {
    const { loadPropolis } = await import('../tool-loader.js');
    const loaded = await loadPropolis();
    if (!loaded) return;

    const client = new NativeToolClient('/tmp', null);
    await client.close(); // Should not throw
  });
});
