import { describe, it, expect, vi } from 'vitest';
import { handleAcpTool } from './acp-mcp-server.js';
import { normalizeWait } from './wait.js';
import type { AcpBackend } from './types.js';

function mockBackend(overrides: Partial<AcpBackend> = {}): AcpBackend {
  return {
    publishEvent: vi.fn().mockResolvedValue('{"id":1}'),
    claimResource: vi.fn().mockResolvedValue('{"status":"granted"}'),
    releaseResource: vi.fn().mockResolvedValue('{"released":true}'),
    getState: vi.fn().mockResolvedValue('{"progress":0.5}'),
    setState: vi.fn().mockResolvedValue('{"ok":true}'),
    waitForWake: vi.fn().mockResolvedValue(['Event from agent-2: [task.done] {"result":"ok"}']),
    ...overrides,
  };
}

// ─── normalizeWait ──────────────────────────────────────────────

describe('normalizeWait', () => {
  it('true → any event, default timeout', () => {
    const r = normalizeWait(true);
    expect(r.types).toBeNull();
    expect(r.timeout).toBe(300_000);
    expect(r.pureDelay).toBe(false);
  });

  it('number → pure delay', () => {
    const r = normalizeWait(30000);
    expect(r.timeout).toBe(30000);
    expect(r.pureDelay).toBe(true);
  });

  it('string → single event type', () => {
    const r = normalizeWait('player.action');
    expect(r.types).toEqual(['player.action']);
    expect(r.pureDelay).toBe(false);
  });

  it('array → multiple event types', () => {
    const r = normalizeWait(['a', 'b']);
    expect(r.types).toEqual(['a', 'b']);
    expect(r.pureDelay).toBe(false);
  });

  it('object → explicit types + timeout', () => {
    const r = normalizeWait({ types: ['x'], timeout: 5000 });
    expect(r.types).toEqual(['x']);
    expect(r.timeout).toBe(5000);
    expect(r.pureDelay).toBe(false);
  });
});

// ─── handleAcpTool ──────────────────────────────────────────────

describe('handleAcpTool', () => {
  it('publishes an event', async () => {
    const backend = mockBackend();
    const result = await handleAcpTool(
      { dance: [{ do: 'publish', type: 'test.event', data: { msg: 'hi' } }] },
      backend,
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0].ok).toBe(true);
    expect(backend.publishEvent).toHaveBeenCalledWith('test.event', { msg: 'hi' });
  });

  it('claims and releases a resource', async () => {
    const backend = mockBackend();
    const result = await handleAcpTool(
      { dance: [
        { do: 'claim', resource: 'file:src/index.ts' },
        { do: 'release', resource: 'file:src/index.ts' },
      ] },
      backend,
    );
    expect(result.results).toHaveLength(2);
    expect(result.results[0].ok).toBe(true);
    expect(result.results[1].ok).toBe(true);
    expect(backend.claimResource).toHaveBeenCalledWith('file:src/index.ts', undefined);
    expect(backend.releaseResource).toHaveBeenCalledWith('file:src/index.ts');
  });

  it('gets state', async () => {
    const backend = mockBackend();
    const result = await handleAcpTool(
      { dance: [{ do: 'get_state' }] },
      backend,
    );
    expect(result.results[0].ok).toBe(true);
    expect(backend.getState).toHaveBeenCalledWith(undefined);
  });

  it('gets state with key', async () => {
    const backend = mockBackend();
    const result = await handleAcpTool(
      { dance: [{ do: 'get_state', key: 'progress' }] },
      backend,
    );
    expect(backend.getState).toHaveBeenCalledWith('progress');
  });

  it('sets state', async () => {
    const backend = mockBackend();
    const result = await handleAcpTool(
      { dance: [{ do: 'set_state', key: 'status', value: 'done' }] },
      backend,
    );
    expect(result.results[0].ok).toBe(true);
    expect(backend.setState).toHaveBeenCalledWith('status', 'done');
  });

  it('rejects unknown actions', async () => {
    const backend = mockBackend();
    const result = await handleAcpTool(
      { dance: [{ do: 'shell', command: 'rm -rf /' }] },
      backend,
    );
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toContain('Unknown ACP action');
  });

  it('rejects env actions (read_file, write_file, etc.)', async () => {
    const backend = mockBackend();
    const result = await handleAcpTool(
      { dance: [
        { do: 'read_file', path: '/etc/passwd' },
        { do: 'write_file', path: '/tmp/evil', content: 'bad' },
      ] },
      backend,
    );
    expect(result.results[0].ok).toBe(false);
    expect(result.results[1].ok).toBe(false);
  });

  it('parses dance from JSON string', async () => {
    const backend = mockBackend();
    const result = await handleAcpTool(
      { dance: JSON.stringify([{ do: 'get_state' }]) },
      backend,
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0].ok).toBe(true);
  });

  it('handles empty dance', async () => {
    const backend = mockBackend();
    const result = await handleAcpTool(
      { dance: [] },
      backend,
    );
    expect(result.results).toHaveLength(0);
    expect(result.wakeEvents).toBeUndefined();
  });

  it('handles wait after ops', async () => {
    const backend = mockBackend();
    const result = await handleAcpTool(
      { dance: [{ do: 'publish', type: 'done' }], wait: 'response' },
      backend,
    );
    expect(result.results).toHaveLength(1);
    expect(result.wakeEvents).toBeDefined();
    expect(backend.waitForWake).toHaveBeenCalled();
  });

  it('handles wait=true', async () => {
    const backend = mockBackend();
    const result = await handleAcpTool(
      { dance: [], wait: true },
      backend,
    );
    expect(result.wakeEvents).toBeDefined();
    expect(backend.waitForWake).toHaveBeenCalledWith(
      expect.objectContaining({ types: null, timeout: 300_000 }),
    );
  });

  it('handles pure delay wait (number)', async () => {
    const backend = mockBackend();
    const result = await handleAcpTool(
      { dance: [], wait: 50 },
      backend,
    );
    expect(result.wakeEvents).toEqual([]);
    // Should NOT call waitForWake — it's a pure delay
    expect(backend.waitForWake).not.toHaveBeenCalled();
  });

  it('handles wait as JSON string', async () => {
    const backend = mockBackend();
    const result = await handleAcpTool(
      { dance: [], wait: JSON.stringify({ types: ['x'], timeout: 1000 }) },
      backend,
    );
    expect(backend.waitForWake).toHaveBeenCalledWith(
      expect.objectContaining({ types: ['x'], timeout: 1000 }),
    );
  });

  it('handles backend errors gracefully', async () => {
    const backend = mockBackend({
      publishEvent: vi.fn().mockRejectedValue(new Error('connection refused')),
    });
    const result = await handleAcpTool(
      { dance: [{ do: 'publish', type: 'test' }] },
      backend,
    );
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toBe('connection refused');
  });

  it('continues after individual op failures', async () => {
    const backend = mockBackend({
      claimResource: vi.fn().mockRejectedValue(new Error('already claimed')),
    });
    const result = await handleAcpTool(
      { dance: [
        { do: 'claim', resource: 'x' },
        { do: 'get_state' },
      ] },
      backend,
    );
    expect(result.results).toHaveLength(2);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[1].ok).toBe(true);
  });
});
