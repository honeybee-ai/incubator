import { describe, it, expect, vi } from 'vitest';
import { loadDances, danceToolDefs, buildAcpHelper, callDanceTool, runInject } from './dances.js';
import type { DanceModule, DanceAcpHelper } from './dances.js';

// ─── Helpers ────────────────────────────────────────────────────

/** Build a mock dance module without import(). */
function mockDanceModule(exports: Record<string, unknown>): DanceModule {
  const tools = new Map();
  let inject;

  for (const [name, exp] of Object.entries(exports)) {
    if (name === 'inject' && typeof exp === 'function') {
      inject = exp;
      continue;
    }
    if (name === 'default') continue;
    if (exp && typeof exp === 'object' && 'handler' in (exp as Record<string, unknown>)) {
      const t = exp as Record<string, unknown>;
      tools.set(name, {
        description: t.description,
        params: t.params ?? {},
        handler: t.handler,
      });
    }
  }
  return { inject, tools };
}

function mockAcpHelper(): DanceAcpHelper {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    claim: vi.fn().mockResolvedValue('claim-1'),
    release: vi.fn().mockResolvedValue(undefined),
    setState: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── danceToolDefs ──────────────────────────────────────────────

describe('danceToolDefs', () => {
  it('converts dance tools to LLM ToolDef format', () => {
    const mod = mockDanceModule({
      make_move: {
        description: 'Place your mark',
        params: { cell: { type: 'integer', description: 'Cell 0-8' } },
        handler: async () => ({ result: 'ok' }),
      },
    });

    const defs = danceToolDefs(mod);
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toBe('make_move');
    expect(defs[0].function.description).toBe('Place your mark');
    expect(defs[0].function.parameters.properties).toHaveProperty('cell');
    expect(defs[0].function.parameters.required).toEqual(['cell']);
  });

  it('handles tools with no params', () => {
    const mod = mockDanceModule({
      get_status: {
        description: 'Get game status',
        handler: async () => ({ result: 'playing' }),
      },
    });

    const defs = danceToolDefs(mod);
    expect(defs[0].function.parameters.properties).toEqual({});
    expect(defs[0].function.parameters.required).toEqual([]);
  });

  it('generates tool defs that can be used as-is by LLM', () => {
    const mod = mockDanceModule({
      inject: ({ state }: { state: Record<string, string> }) => `Board: ${state.board}`,
      make_move: {
        description: 'Place your mark on an empty cell',
        params: {
          cell: { type: 'integer', description: 'Cell index 0-8' },
        },
        handler: async () => ({ result: 'ok' }),
      },
      resign: {
        description: 'Resign the game',
        handler: async () => ({ result: 'resigned' }),
      },
    });

    const defs = danceToolDefs(mod);
    expect(defs).toHaveLength(2);

    const names = defs.map(d => d.function.name);
    expect(names).toContain('make_move');
    expect(names).toContain('resign');
    // inject is NOT a tool
    expect(names).not.toContain('inject');
  });

  it('fills empty description for params without one', () => {
    const mod = mockDanceModule({
      tool: {
        description: 'A tool',
        params: { x: { type: 'string' } },
        handler: async () => ({ result: 'ok' }),
      },
    });

    const defs = danceToolDefs(mod);
    expect(defs[0].function.parameters.properties.x.description).toBe('');
  });
});

// ─── callDanceTool ──────────────────────────────────────────────

describe('callDanceTool', () => {
  const mockAcp = mockAcpHelper();
  const getState = vi.fn().mockResolvedValue({ board: '["","",""]', turn: 'X' });

  it('executes handler with full context', async () => {
    const handler = vi.fn().mockResolvedValue({ result: { moved: true } });
    const mod = mockDanceModule({
      make_move: { description: 'Move', params: {}, handler },
    });

    const result = await callDanceTool(mod, 'make_move', { cell: 4 }, 'player_x', 'agent-1', getState, mockAcp);

    expect(result).toEqual({ result: { moved: true } });
    expect(handler).toHaveBeenCalledWith({
      args: { cell: 4 },
      state: { board: '["","",""]', turn: 'X' },
      agent: { role: 'player_x', agentId: 'agent-1' },
      acp: mockAcp,
    });
  });

  it('returns error for unknown tool', async () => {
    const mod = mockDanceModule({});
    const result = await callDanceTool(mod, 'nonexistent', {}, 'role', 'id', getState, mockAcp);
    expect(result).toEqual({ error: 'Unknown dance tool: nonexistent' });
  });

  it('catches handler exceptions', async () => {
    const mod = mockDanceModule({
      bad_tool: {
        description: 'Throws',
        handler: async () => { throw new Error('boom'); },
      },
    });

    const result = await callDanceTool(mod, 'bad_tool', {}, 'role', 'id', getState, mockAcp);
    expect(result).toEqual({ error: 'boom' });
  });

  it('provides fresh state per call', async () => {
    const states = [{ a: '1' }, { a: '2' }];
    let callCount = 0;
    const freshState = vi.fn().mockImplementation(async () => states[callCount++]);

    const handler = vi.fn().mockResolvedValue({ result: 'ok' });
    const mod = mockDanceModule({
      tool: { description: 'test', handler },
    });

    await callDanceTool(mod, 'tool', {}, 'r', 'id', freshState, mockAcpHelper());
    await callDanceTool(mod, 'tool', {}, 'r', 'id', freshState, mockAcpHelper());

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0].state).toEqual({ a: '1' });
    expect(handler.mock.calls[1][0].state).toEqual({ a: '2' });
  });

  it('catches non-Error throws', async () => {
    const mod = mockDanceModule({
      bad: {
        description: 'Throws string',
        handler: async () => { throw 'raw string'; },
      },
    });

    const result = await callDanceTool(mod, 'bad', {}, 'r', 'id', getState, mockAcp);
    expect(result).toEqual({ error: 'raw string' });
  });
});

// ─── runInject ──────────────────────────────────────────────────

describe('runInject', () => {
  it('returns formatted string from inject function', () => {
    const mod = mockDanceModule({
      inject: ({ state, agent }: { state: Record<string, string>; agent: { role: string } }) =>
        `Turn: ${state.turn}, Role: ${agent.role}`,
    });

    const result = runInject(mod, { turn: 'X' }, 'player_x', 'agent-1');
    expect(result).toBe('Turn: X, Role: player_x');
  });

  it('returns null when no inject', () => {
    const mod = mockDanceModule({
      some_tool: { description: 'x', handler: async () => ({ result: 'ok' }) },
    });
    expect(runInject(mod, {}, 'role', 'id')).toBeNull();
  });

  it('catches inject errors gracefully', () => {
    const mod = mockDanceModule({
      inject: () => { throw new Error('parse failed'); },
    });

    const result = runInject(mod, {}, 'role', 'id');
    expect(result).toBe('[inject error: parse failed]');
  });

  it('passes agentId to inject', () => {
    const mod = mockDanceModule({
      inject: ({ agent }: { agent: { role: string; agentId: string } }) =>
        `id=${agent.agentId}`,
    });

    const result = runInject(mod, {}, 'role', 'agent-42');
    expect(result).toBe('id=agent-42');
  });
});

// ─── buildAcpHelper ─────────────────────────────────────────────

describe('buildAcpHelper', () => {
  it('wraps store functions with namespace and agentId', async () => {
    const stores = {
      publishEvent: vi.fn().mockResolvedValue(undefined),
      claimResource: vi.fn().mockResolvedValue('claim-abc'),
      releaseResource: vi.fn().mockResolvedValue(undefined),
      setState: vi.fn().mockResolvedValue(undefined),
    };

    const helper = buildAcpHelper(stores, 'test-ns', 'agent-1');

    await helper.publish('move', { cell: 4 });
    expect(stores.publishEvent).toHaveBeenCalledWith('test-ns', 'move', { cell: 4 }, 'agent-1');

    const claimId = await helper.claim('turn');
    expect(claimId).toBe('claim-abc');
    expect(stores.claimResource).toHaveBeenCalledWith('test-ns', 'turn', 'agent-1');

    await helper.release('claim-abc');
    expect(stores.releaseResource).toHaveBeenCalledWith('test-ns', 'claim-abc');

    await helper.setState('board', '[]');
    expect(stores.setState).toHaveBeenCalledWith('test-ns', 'board', '[]');
  });

  it('publish works without data', async () => {
    const stores = {
      publishEvent: vi.fn().mockResolvedValue(undefined),
      claimResource: vi.fn().mockResolvedValue('c'),
      releaseResource: vi.fn().mockResolvedValue(undefined),
      setState: vi.fn().mockResolvedValue(undefined),
    };

    const helper = buildAcpHelper(stores, 'ns', 'a1');
    await helper.publish('ping');
    expect(stores.publishEvent).toHaveBeenCalledWith('ns', 'ping', undefined, 'a1');
  });
});

// ─── loadDances (import validation) ─────────────────────────────

describe('loadDances', () => {
  it('rejects non-function inject', async () => {
    vi.doMock('/tmp/bad-inject-dance.js', () => ({
      inject: 'not a function',
    }));

    await expect(loadDances('/tmp/bad-inject-dance.js')).rejects.toThrow(
      'Dance file: "inject" must be a function',
    );

    vi.doUnmock('/tmp/bad-inject-dance.js');
  });

  it('rejects tool without handler', async () => {
    vi.doMock('/tmp/no-handler-dance.js', () => ({
      broken: { description: 'no handler' },
    }));

    await expect(loadDances('/tmp/no-handler-dance.js')).rejects.toThrow(
      'Dance file: tool "broken" must have a handler function',
    );

    vi.doUnmock('/tmp/no-handler-dance.js');
  });

  it('rejects tool without description', async () => {
    vi.doMock('/tmp/no-desc-dance.js', () => ({
      broken: { handler: async () => ({ result: 'ok' }) },
    }));

    await expect(loadDances('/tmp/no-desc-dance.js')).rejects.toThrow(
      'Dance file: tool "broken" must have a description string',
    );

    vi.doUnmock('/tmp/no-desc-dance.js');
  });

  it('loads valid dance module', async () => {
    vi.doMock('/tmp/valid-dance.js', () => ({
      default: 'ignored',
      inject: ({ state }: { state: Record<string, string> }) => `Board: ${state.board}`,
      move: {
        description: 'Make a move',
        params: { cell: { type: 'integer', description: 'Cell 0-8' } },
        handler: async () => ({ result: 'ok' }),
      },
    }));

    const mod = await loadDances('/tmp/valid-dance.js');
    expect(mod.inject).toBeDefined();
    expect(mod.tools.size).toBe(1);
    expect(mod.tools.has('move')).toBe(true);
    expect(mod.tools.get('move')!.description).toBe('Make a move');

    vi.doUnmock('/tmp/valid-dance.js');
  });

  it('skips non-object exports', async () => {
    vi.doMock('/tmp/mixed-dance.js', () => ({
      VERSION: '1.0',
      COUNT: 42,
      valid_tool: {
        description: 'Works',
        handler: async () => ({ result: 'ok' }),
      },
    }));

    const mod = await loadDances('/tmp/mixed-dance.js');
    expect(mod.tools.size).toBe(1);
    expect(mod.tools.has('valid_tool')).toBe(true);

    vi.doUnmock('/tmp/mixed-dance.js');
  });
});
