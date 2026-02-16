import { describe, it, expect, vi } from 'vitest';
import { HookEngine } from './hooks.js';
import type { HookContext, AgentHook } from './types.js';

const CTX: HookContext = { agentId: 'test-1', role: 'dev', iteration: 1 };

describe('HookEngine', () => {
  it('runs hooks in priority order (ascending)', async () => {
    const engine = new HookEngine();
    const order: number[] = [];

    engine.add({
      name: 'c',
      point: 'PreToolUse',
      priority: 300,
      handler: async () => { order.push(300); },
    });
    engine.add({
      name: 'a',
      point: 'PreToolUse',
      priority: 10,
      handler: async () => { order.push(10); },
    });
    engine.add({
      name: 'b',
      point: 'PreToolUse',
      priority: 100,
      handler: async () => { order.push(100); },
    });

    await engine.run('PreToolUse', CTX, { toolName: 'read_file', args: {} });
    expect(order).toEqual([10, 100, 300]);
  });

  it('uses default priority 100', async () => {
    const engine = new HookEngine();
    const order: string[] = [];

    engine.add({
      name: 'default-pri',
      point: 'PreToolUse',
      handler: async () => { order.push('default'); },
    });
    engine.add({
      name: 'low-pri',
      point: 'PreToolUse',
      priority: 50,
      handler: async () => { order.push('low'); },
    });

    await engine.run('PreToolUse', CTX, { toolName: 'test', args: {} });
    expect(order).toEqual(['low', 'default']);
  });

  it('PreToolUse: first block wins', async () => {
    const engine = new HookEngine();

    engine.add({
      name: 'blocker1',
      point: 'PreToolUse',
      priority: 10,
      handler: async () => ({ block: 'Blocked by first' }),
    });
    engine.add({
      name: 'blocker2',
      point: 'PreToolUse',
      priority: 20,
      handler: async () => ({ block: 'Blocked by second' }),
    });

    const result = await engine.run('PreToolUse', CTX, { toolName: 'test', args: {} });
    expect(result?.block).toBe('Blocked by first');
  });

  it('PreToolUse: modified args propagate to next hook', async () => {
    const engine = new HookEngine();
    const seen: Record<string, unknown>[] = [];

    engine.add({
      name: 'modifier',
      point: 'PreToolUse',
      priority: 10,
      handler: async () => ({ args: { path: '/modified' } }),
    });
    engine.add({
      name: 'observer',
      point: 'PreToolUse',
      priority: 20,
      handler: async (_ctx, payload) => { seen.push({ ...payload.args }); },
    });

    await engine.run('PreToolUse', CTX, { toolName: 'test', args: { path: '/original' } });
    expect(seen[0]).toEqual({ path: '/modified' });
  });

  it('PostToolUse: last result wins', async () => {
    const engine = new HookEngine();

    engine.add({
      name: 'first',
      point: 'PostToolUse',
      priority: 10,
      handler: async () => ({ result: 'first-result' }),
    });
    engine.add({
      name: 'second',
      point: 'PostToolUse',
      priority: 20,
      handler: async () => ({ result: 'second-result' }),
    });

    const result = await engine.run('PostToolUse', CTX, {
      toolName: 'test',
      args: {},
      result: 'original',
      durationMs: 10,
    });
    expect(result?.result).toBe('second-result');
  });

  it('PreIteration: first block wins, injects concatenate', async () => {
    const engine = new HookEngine();

    engine.add({
      name: 'injecter1',
      point: 'PreIteration',
      priority: 10,
      handler: async () => ({ inject: 'context-A' }),
    });
    engine.add({
      name: 'blocker',
      point: 'PreIteration',
      priority: 20,
      handler: async () => ({ block: 'Budget exceeded', inject: 'context-B' }),
    });

    const result = await engine.run('PreIteration', CTX, { messages: [], totalTokens: 0 });
    expect(result?.block).toBe('Budget exceeded');
    expect(result?.inject).toBe('context-A\ncontext-B');
  });

  it('PostIteration: first stop wins', async () => {
    const engine = new HookEngine();

    engine.add({
      name: 'stopper1',
      point: 'PostIteration',
      priority: 10,
      handler: async () => ({ stop: 'Loop detected' }),
    });
    engine.add({
      name: 'stopper2',
      point: 'PostIteration',
      priority: 20,
      handler: async () => ({ stop: 'Token limit' }),
    });

    const result = await engine.run('PostIteration', CTX, {
      content: null,
      hasToolCalls: false,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      totalTokens: 0,
    });
    expect(result?.stop).toBe('Loop detected');
  });

  it('OnError: first recover wins', async () => {
    const engine = new HookEngine();

    engine.add({
      name: 'recoverer',
      point: 'OnError',
      priority: 10,
      handler: async () => ({ recover: true }),
    });

    const result = await engine.run('OnError', CTX, {
      error: new Error('test'),
      phase: 'tool_call',
    });
    expect(result?.recover).toBe(true);
  });

  it('swallows hook errors', async () => {
    const engine = new HookEngine();
    const called: string[] = [];

    engine.add({
      name: 'thrower',
      point: 'PreToolUse',
      priority: 10,
      handler: async () => { throw new Error('hook crash'); },
    });
    engine.add({
      name: 'survivor',
      point: 'PreToolUse',
      priority: 20,
      handler: async () => { called.push('survived'); },
    });

    // Should not throw
    await engine.run('PreToolUse', CTX, { toolName: 'test', args: {} });
    expect(called).toEqual(['survived']);
  });

  it('returns undefined when no hooks registered', async () => {
    const engine = new HookEngine();
    const result = await engine.run('PreToolUse', CTX, { toolName: 'test', args: {} });
    expect(result).toBeUndefined();
  });

  it('returns undefined when hooks return nothing', async () => {
    const engine = new HookEngine();
    engine.add({
      name: 'noop',
      point: 'PreToolUse',
      handler: async () => {},
    });

    const result = await engine.run('PreToolUse', CTX, { toolName: 'test', args: {} });
    expect(result).toBeUndefined();
  });

  it('replaces hook with same name', () => {
    const engine = new HookEngine();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    engine.add({ name: 'my-hook', point: 'PreToolUse', handler: handler1 });
    engine.add({ name: 'my-hook', point: 'PreToolUse', handler: handler2 });

    expect(engine.getHooks('PreToolUse')).toHaveLength(1);
  });

  it('removes hook by name across all points', () => {
    const engine = new HookEngine();
    engine.add({ name: 'x', point: 'PreToolUse', handler: async () => {} });
    engine.add({ name: 'x', point: 'PostToolUse', handler: async () => {} });

    engine.remove('x');

    expect(engine.getHooks('PreToolUse')).toHaveLength(0);
    expect(engine.getHooks('PostToolUse')).toHaveLength(0);
  });

  it('has() returns true for registered hook', () => {
    const engine = new HookEngine();
    engine.add({ name: 'exists', point: 'PreToolUse', handler: async () => {} });

    expect(engine.has('exists')).toBe(true);
    expect(engine.has('missing')).toBe(false);
  });

  it('clear() removes all hooks', () => {
    const engine = new HookEngine();
    engine.add({ name: 'a', point: 'PreToolUse', handler: async () => {} });
    engine.add({ name: 'b', point: 'PostToolUse', handler: async () => {} });

    engine.clear();

    expect(engine.getHooks('PreToolUse')).toHaveLength(0);
    expect(engine.getHooks('PostToolUse')).toHaveLength(0);
  });

  it('handles mixed hook points independently', async () => {
    const engine = new HookEngine();
    const calls: string[] = [];

    engine.add({
      name: 'pre',
      point: 'PreToolUse',
      handler: async () => { calls.push('pre'); },
    });
    engine.add({
      name: 'post',
      point: 'PostToolUse',
      handler: async () => { calls.push('post'); },
    });

    await engine.run('PreToolUse', CTX, { toolName: 'test', args: {} });
    expect(calls).toEqual(['pre']);

    await engine.run('PostToolUse', CTX, { toolName: 'test', args: {}, result: '', durationMs: 0 });
    expect(calls).toEqual(['pre', 'post']);
  });
});
