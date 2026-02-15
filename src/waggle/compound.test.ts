import { describe, it, expect, vi, beforeEach } from 'vitest';
import { compoundHandler, normalizeWait } from './compound.js';
import type { CompoundContext } from './compound.js';
import type { AcpBackend } from './types.js';
import type { ToolResult } from '../propolis/tools/types.js';

// ─── Helpers ────────────────────────────────────────────────────────

function textResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] };
}

function mockHandler(result: unknown) {
  return vi.fn().mockResolvedValue(textResult(result));
}

function makeCtx(overrides?: Partial<CompoundContext>): CompoundContext {
  return {
    handlers: new Map([
      ['read_file', mockHandler({ content: 'hello world', path: 'test.txt' })],
      ['write_file', mockHandler({ written: true, path: 'test.txt' })],
      ['patch_file', mockHandler({ patched: true })],
      ['list_files', mockHandler({ files: ['a.ts', 'b.ts'] })],
      ['glob', mockHandler({ matches: ['src/index.ts'] })],
      ['grep', mockHandler({ matches: [{ file: 'a.ts', line: 1, text: 'hello' }] })],
      ['run', mockHandler({ stdout: 'ok', exitCode: 0 })],
      ['git_status', mockHandler({ status: 'clean' })],
      ['git_diff', mockHandler({ diff: '' })],
      ['git_commit', mockHandler({ committed: true })],
      ['git_log', mockHandler({ log: 'abc123 init' })],
      ['fetch', mockHandler({ status: 200, body: '{}' })],
      ['scrape_page', mockHandler({ text: 'page content' })],
    ]),
    ...overrides,
  };
}

function mockAcp(): AcpBackend {
  return {
    publishEvent: vi.fn().mockResolvedValue(JSON.stringify({ published: true, type: 'test' })),
    claimResource: vi.fn().mockResolvedValue(JSON.stringify({ status: 'approved', resource: 'x' })),
    releaseResource: vi.fn().mockResolvedValue(JSON.stringify({ released: true, resource: 'x' })),
    getState: vi.fn().mockResolvedValue(JSON.stringify({ key1: 'val1' })),
    setState: vi.fn().mockResolvedValue(JSON.stringify({ ok: true, key: 'k' })),
    waitForWake: vi.fn().mockResolvedValue(['Event from agent_a: [player.action] {"move":"e4"}']),
  };
}

// ─── normalizeWait ──────────────────────────────────────────────────

describe('normalizeWait', () => {
  it('returns null for undefined/false', () => {
    expect(normalizeWait(undefined)).toBeNull();
    expect(normalizeWait(false)).toBeNull();
  });

  it('true → any event, no timeout', () => {
    expect(normalizeWait(true)).toEqual({ types: null, timeout: 0, pureDelay: false });
  });

  it('string → specific event type', () => {
    expect(normalizeWait('player.action')).toEqual({ types: ['player.action'], timeout: 0, pureDelay: false });
  });

  it('string[] → multiple event types', () => {
    expect(normalizeWait(['a', 'b'])).toEqual({ types: ['a', 'b'], timeout: 0, pureDelay: false });
  });

  it('number → pure delay', () => {
    expect(normalizeWait(30000)).toEqual({ types: null, timeout: 30000, pureDelay: true });
  });

  it('object → explicit form', () => {
    expect(normalizeWait({ types: ['x'], timeout: 5000 })).toEqual({ types: ['x'], timeout: 5000, pureDelay: false });
  });

  it('empty array → any event', () => {
    expect(normalizeWait([])).toEqual({ types: null, timeout: 0, pureDelay: false });
  });

  it('object with no types → any event', () => {
    expect(normalizeWait({ timeout: 1000 })).toEqual({ types: null, timeout: 1000, pureDelay: false });
  });
});

// ─── Single env ops ─────────────────────────────────────────────────

describe('compoundHandler — env ops', () => {
  it('routes read_file to handler', async () => {
    const ctx = makeCtx();
    const result = await compoundHandler({ dance: [{ do: 'read_file', path: 'test.txt' }] }, ctx);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].ok).toBe(true);
    expect(result.results[0].op).toBe('read_file');
    expect(ctx.handlers.get('read_file')).toHaveBeenCalledWith({ path: 'test.txt' });
  });

  it('routes shell → run handler', async () => {
    const ctx = makeCtx();
    const result = await compoundHandler({ dance: [{ do: 'shell', command: 'echo hi' }] }, ctx);
    expect(result.results[0].ok).toBe(true);
    expect(result.results[0].op).toBe('shell');
    expect(ctx.handlers.get('run')).toHaveBeenCalledWith({ command: 'echo hi' });
  });

  it('routes scrape → scrape_page handler', async () => {
    const ctx = makeCtx();
    const result = await compoundHandler({ dance: [{ do: 'scrape', url: 'https://example.com' }] }, ctx);
    expect(result.results[0].ok).toBe(true);
    expect(ctx.handlers.get('scrape_page')).toHaveBeenCalledWith({ url: 'https://example.com' });
  });

  it('maps git_diff cached → staged', async () => {
    const ctx = makeCtx();
    await compoundHandler({ dance: [{ do: 'git_diff', cached: true }] }, ctx);
    expect(ctx.handlers.get('git_diff')).toHaveBeenCalledWith({ staged: true });
  });

  it('maps git_commit files array → comma-separated', async () => {
    const ctx = makeCtx();
    await compoundHandler({ dance: [{ do: 'git_commit', message: 'fix', files: ['a.ts', 'b.ts'] }] }, ctx);
    expect(ctx.handlers.get('git_commit')).toHaveBeenCalledWith({ message: 'fix', files: 'a.ts,b.ts' });
  });

  it('returns error for unknown action', async () => {
    const ctx = makeCtx();
    const result = await compoundHandler({ dance: [{ do: 'fly_to_moon' }] }, ctx);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toContain('unknown action');
  });

  it('detects errors in handler result', async () => {
    const ctx = makeCtx({
      handlers: new Map([
        ['read_file', mockHandler({ error: 'File not found' })],
      ]),
    });
    const result = await compoundHandler({ dance: [{ do: 'read_file', path: 'nope.txt' }] }, ctx);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toBe('File not found');
  });

  it('catches thrown errors', async () => {
    const ctx = makeCtx({
      handlers: new Map([
        ['read_file', vi.fn().mockRejectedValue(new Error('disk full'))],
      ]),
    });
    const result = await compoundHandler({ dance: [{ do: 'read_file', path: 'x' }] }, ctx);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toBe('disk full');
  });
});

// ─── Batched ops ────────────────────────────────────────────────────

describe('compoundHandler — batched ops', () => {
  it('executes multiple ops sequentially', async () => {
    const ctx = makeCtx();
    const result = await compoundHandler({
      dance: [
        { do: 'read_file', path: 'a.ts' },
        { do: 'write_file', path: 'b.ts', content: 'hi' },
        { do: 'git_status' },
      ],
    }, ctx);
    expect(result.results).toHaveLength(3);
    expect(result.results.every(r => r.ok)).toBe(true);
    expect(result.results.map(r => r.op)).toEqual(['read_file', 'write_file', 'git_status']);
  });

  it('continues after one op fails', async () => {
    const ctx = makeCtx({
      handlers: new Map([
        ['read_file', vi.fn().mockRejectedValue(new Error('fail'))],
        ['git_status', mockHandler({ status: 'clean' })],
      ]),
    });
    const result = await compoundHandler({
      dance: [
        { do: 'read_file', path: 'x' },
        { do: 'git_status' },
      ],
    }, ctx);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[1].ok).toBe(true);
  });

  it('handles empty ops array', async () => {
    const ctx = makeCtx();
    const result = await compoundHandler({ dance: [] }, ctx);
    expect(result.results).toEqual([]);
  });
});

// ─── ACP ops ────────────────────────────────────────────────────────

describe('compoundHandler — ACP ops', () => {
  it('routes publish to ACP backend', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp });
    const result = await compoundHandler({
      dance: [{ do: 'publish', type: 'npc.dialogue', data: { text: 'hello' } }],
    }, ctx);
    expect(result.results[0].ok).toBe(true);
    expect(acp.publishEvent).toHaveBeenCalledWith('npc.dialogue', { text: 'hello' });
  });

  it('routes claim to ACP backend', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp });
    await compoundHandler({ dance: [{ do: 'claim', resource: 'player_turn', value: 'me' }] }, ctx);
    expect(acp.claimResource).toHaveBeenCalledWith('player_turn', 'me');
  });

  it('routes release to ACP backend', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp });
    await compoundHandler({ dance: [{ do: 'release', resource: 'player_turn' }] }, ctx);
    expect(acp.releaseResource).toHaveBeenCalledWith('player_turn');
  });

  it('routes get_state to ACP backend', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp });
    const result = await compoundHandler({ dance: [{ do: 'get_state' }] }, ctx);
    expect(result.results[0].ok).toBe(true);
    expect(result.results[0].data).toEqual({ key1: 'val1' });
  });

  it('routes set_state to ACP backend', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp });
    await compoundHandler({ dance: [{ do: 'set_state', key: 'hp', value: 42 }] }, ctx);
    expect(acp.setState).toHaveBeenCalledWith('hp', 42);
  });

  it('returns error when no ACP backend', async () => {
    const ctx = makeCtx();
    const result = await compoundHandler({ dance: [{ do: 'publish', type: 'x' }] }, ctx);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toBe('no ACP backend available');
  });
});

// ─── Mixed ops ──────────────────────────────────────────────────────

describe('compoundHandler — mixed env + ACP', () => {
  it('handles env and ACP ops in one batch', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp });
    const result = await compoundHandler({
      dance: [
        { do: 'read_file', path: 'state.json' },
        { do: 'write_file', path: 'state.json', content: '{}' },
        { do: 'publish', type: 'state.updated' },
        { do: 'claim', resource: 'player_turn' },
      ],
    }, ctx);
    expect(result.results).toHaveLength(4);
    expect(result.results.map(r => r.op)).toEqual(['read_file', 'write_file', 'publish', 'claim']);
    expect(result.results.every(r => r.ok)).toBe(true);
  });
});

// ─── Wait parameter ─────────────────────────────────────────────────

describe('compoundHandler — wait', () => {
  it('no wait → no wakeEvents in result', async () => {
    const ctx = makeCtx();
    const result = await compoundHandler({ dance: [] }, ctx);
    expect(result.wakeEvents).toBeUndefined();
  });

  it('wait: true → calls acp.waitForWake', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp });
    const result = await compoundHandler({ dance: [], wait: true }, ctx);
    expect(acp.waitForWake).toHaveBeenCalledWith({ types: null, timeout: 0 });
    expect(result.wakeEvents).toHaveLength(1);
  });

  it('wait: "event.type" → calls with specific type', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp });
    await compoundHandler({ dance: [], wait: 'player.action' }, ctx);
    expect(acp.waitForWake).toHaveBeenCalledWith({ types: ['player.action'], timeout: 0 });
  });

  it('wait: ["a", "b"] → calls with multiple types', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp });
    await compoundHandler({ dance: [], wait: ['a', 'b'] }, ctx);
    expect(acp.waitForWake).toHaveBeenCalledWith({ types: ['a', 'b'], timeout: 0 });
  });

  it('wait: number → pure delay (no ACP call)', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp });
    const start = Date.now();
    const result = await compoundHandler({ dance: [], wait: 50 }, ctx);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(acp.waitForWake).not.toHaveBeenCalled();
    expect(result.wakeEvents).toEqual([]);
  });

  it('wait: { types, timeout } → full spec', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp });
    await compoundHandler({ dance: [], wait: { types: ['x'], timeout: 5000 } }, ctx);
    expect(acp.waitForWake).toHaveBeenCalledWith({ types: ['x'], timeout: 5000 });
  });

  it('ops execute before wait', async () => {
    const order: string[] = [];
    const acp = mockAcp();
    (acp.waitForWake as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('wait');
      return [];
    });
    const readHandler = vi.fn().mockImplementation(async () => {
      order.push('read');
      return textResult({ ok: true });
    });
    const ctx: CompoundContext = {
      handlers: new Map([['read_file', readHandler]]),
      acp,
    };
    await compoundHandler({ dance: [{ do: 'read_file', path: 'x' }], wait: true }, ctx);
    expect(order).toEqual(['read', 'wait']);
  });
});

// ─── load_protocol op ──────────────────────────────────────────────

describe('compoundHandler — load_protocol', () => {
  it('routes load_protocol to ACP backend', async () => {
    const acp = mockAcp();
    acp.loadProtocol = vi.fn().mockResolvedValue(JSON.stringify({ loaded: true, name: 'test', title: 'Test' }));
    const ctx = makeCtx({ acp });
    const result = await compoundHandler({
      dance: [{ do: 'load_protocol', spec: 'acp: "0.2"\nname: test\ntitle: Test\nroles:\n  worker:\n    description: works\nphases:\n  main:\n    description: main phase' }],
    }, ctx);
    expect(result.results[0].ok).toBe(true);
    expect(result.results[0].data).toEqual({ loaded: true, name: 'test', title: 'Test' });
    expect(acp.loadProtocol).toHaveBeenCalled();
  });

  it('returns error when backend does not support load_protocol', async () => {
    const acp = mockAcp();
    // loadProtocol not defined on base mock
    const ctx = makeCtx({ acp });
    const result = await compoundHandler({
      dance: [{ do: 'load_protocol', spec: 'acp: "0.2"\nname: x' }],
    }, ctx);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toContain('not supported');
  });

  it('returns error when no ACP backend', async () => {
    const ctx = makeCtx();
    const result = await compoundHandler({
      dance: [{ do: 'load_protocol', spec: 'anything' }],
    }, ctx);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toBe('no ACP backend available');
  });

  it('propagates backend errors', async () => {
    const acp = mockAcp();
    acp.loadProtocol = vi.fn().mockResolvedValue(JSON.stringify({ error: 'Invalid spec: missing phases' }));
    const ctx = makeCtx({ acp });
    const result = await compoundHandler({
      dance: [{ do: 'load_protocol', spec: 'bad yaml' }],
    }, ctx);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toContain('Invalid spec');
  });

  it('can be used in a batch with other ACP ops', async () => {
    const acp = mockAcp();
    acp.loadProtocol = vi.fn().mockResolvedValue(JSON.stringify({ loaded: true, name: 'test', title: 'Test' }));
    const ctx = makeCtx({ acp });
    const result = await compoundHandler({
      dance: [
        { do: 'set_state', key: 'spec_status', value: 'activated' },
        { do: 'load_protocol', spec: 'acp: "0.2"\nname: test' },
        { do: 'publish', type: 'spec.activated' },
      ],
    }, ctx);
    expect(result.results).toHaveLength(3);
    expect(result.results.map(r => r.ok)).toEqual([true, true, true]);
  });
});

// ─── $last template resolution ──────────────────────────────────────

describe('compoundHandler — $last templates', () => {
  it('resolves $last across sequential ops', async () => {
    const acp = mockAcp();
    // get_state returns { key1: 'val1' }
    const ctx = makeCtx({ acp });
    const result = await compoundHandler({
      dance: [
        { do: 'get_state' },
        { do: 'set_state', key: 'echo', value: '$last.key1' },
      ],
    }, ctx);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].ok).toBe(true);
    expect(result.results[1].ok).toBe(true);
    expect(acp.setState).toHaveBeenCalledWith('echo', 'val1');
  });

  it('resolves $last as entire previous result', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp });
    const result = await compoundHandler({
      dance: [
        { do: 'get_state' },
        { do: 'set_state', key: 'snapshot', value: '$last' },
      ],
    }, ctx);
    expect(acp.setState).toHaveBeenCalledWith('snapshot', { key1: 'val1' });
  });

  it('resolves $last from env op results', async () => {
    const readHandler = mockHandler({ content: 'file data', path: 'input.txt' });
    const writeHandler = mockHandler({ written: true });
    const ctx: CompoundContext = {
      handlers: new Map([['read_file', readHandler], ['write_file', writeHandler]]),
    };
    await compoundHandler({
      dance: [
        { do: 'read_file', path: 'input.txt' },
        { do: 'write_file', path: 'copy.txt', content: '$last.content' },
      ],
    }, ctx);
    expect(writeHandler).toHaveBeenCalledWith({ path: 'copy.txt', content: 'file data' });
  });

  it('does not update $last on failed ops', async () => {
    const acp = mockAcp();
    const readHandler = vi.fn().mockRejectedValue(new Error('boom'));
    const ctx: CompoundContext = {
      handlers: new Map([['read_file', readHandler], ['write_file', mockHandler({ ok: true })]]),
      acp,
    };
    const result = await compoundHandler({
      dance: [
        { do: 'get_state' },          // → { key1: 'val1' }
        { do: 'read_file', path: 'x' }, // → error (does NOT update $last)
        { do: 'set_state', key: 'v', value: '$last.key1' },  // → should still be 'val1'
      ],
    }, ctx);
    expect(result.results[1].ok).toBe(false);
    expect(acp.setState).toHaveBeenCalledWith('v', 'val1');
  });
});

// ─── get_state with key/prefix ──────────────────────────────────────

describe('compoundHandler — get_state with key', () => {
  it('passes key param to getState', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp });
    await compoundHandler({
      dance: [{ do: 'get_state', key: 'research.project' }],
    }, ctx);
    expect(acp.getState).toHaveBeenCalledWith('research.project');
  });

  it('passes undefined when no key specified', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp });
    await compoundHandler({
      dance: [{ do: 'get_state' }],
    }, ctx);
    expect(acp.getState).toHaveBeenCalledWith(undefined);
  });

  it('passes glob pattern to getState', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp });
    await compoundHandler({
      dance: [{ do: 'get_state', key: 'research.*' }],
    }, ctx);
    expect(acp.getState).toHaveBeenCalledWith('research.*');
  });
});

// ─── Primitive filtering ────────────────────────────────────────────

describe('compoundHandler — primitives', () => {
  it('blocks env action not in allowed list', async () => {
    const ctx = makeCtx({ primitives: { env: ['read_file'], acp: ['publish'] } });
    const result = await compoundHandler({
      dance: [{ do: 'shell', command: 'rm -rf /' }],
    }, ctx);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toContain("not permitted");
  });

  it('allows env action in allowed list', async () => {
    const ctx = makeCtx({ primitives: { env: ['read_file'] } });
    const result = await compoundHandler({
      dance: [{ do: 'read_file', path: 'x' }],
    }, ctx);
    expect(result.results[0].ok).toBe(true);
  });

  it('blocks ACP action not in allowed list', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp, primitives: { acp: ['publish', 'get_state'] } });
    const result = await compoundHandler({
      dance: [{ do: 'claim', resource: 'x' }],
    }, ctx);
    expect(result.results[0].ok).toBe(false);
    expect(result.results[0].error).toContain("not permitted");
  });

  it('allows ACP action in allowed list', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp, primitives: { acp: ['publish'] } });
    const result = await compoundHandler({
      dance: [{ do: 'publish', type: 'x' }],
    }, ctx);
    expect(result.results[0].ok).toBe(true);
  });

  it('no primitives → all actions allowed', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp });
    const result = await compoundHandler({
      dance: [
        { do: 'shell', command: 'echo hi' },
        { do: 'publish', type: 'x' },
      ],
    }, ctx);
    expect(result.results.every(r => r.ok)).toBe(true);
  });

  it('mixed allowed and blocked in one batch', async () => {
    const acp = mockAcp();
    const ctx = makeCtx({ acp, primitives: { env: ['read_file'], acp: ['publish'] } });
    const result = await compoundHandler({
      dance: [
        { do: 'read_file', path: 'ok' },
        { do: 'shell', command: 'nope' },
        { do: 'publish', type: 'ok' },
        { do: 'claim', resource: 'nope' },
      ],
    }, ctx);
    expect(result.results.map(r => r.ok)).toEqual([true, false, true, false]);
  });
});
