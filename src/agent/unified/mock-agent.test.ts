import { describe, it, expect, vi } from 'vitest';
import { MockAgent } from './mock-agent.js';
import type { AgentContext, AgentEventType } from './types.js';
import type { MockBehavior } from '../../orchestrator.js';

function makeCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    agentId: 'mock-1',
    role: 'tester',
    namespace: 'default',
    prompt: 'Test things.',
    incubatorUrl: 'http://localhost:3100',
    workDir: '/tmp',
    verbose: false,
    ...overrides,
  };
}

function makeRuntime() {
  return {
    publishEvent: vi.fn().mockResolvedValue({ id: 'evt-1' }),
    claimResource: vi.fn().mockResolvedValue({ resource: 'file:test' }),
    releaseResource: vi.fn().mockResolvedValue({ released: true }),
    getState: vi.fn().mockResolvedValue({}),
    setState: vi.fn().mockResolvedValue({ key: 'k', value: 'v' }),
    callDanceTool: vi.fn().mockRejectedValue(new Error('Not a dance tool')),
    disconnect: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('MockAgent', () => {
  it('creates with correct properties', () => {
    const agent = new MockAgent('m-1', 'tester', {
      behavior: { actions: [] },
    });
    expect(agent.id).toBe('m-1');
    expect(agent.role).toBe('tester');
    expect(agent.type).toBe('mock');
    expect(agent.status).toBe('idle');
  });

  it('runs mock behavior and returns result', async () => {
    const runtime = makeRuntime();
    const behavior: MockBehavior = {
      actions: [
        { tool: 'publish', args: { type: 'test.start', data: {} } },
        { tool: 'set_state', args: { key: 'status', value: 'done' } },
      ],
    };

    const agent = new MockAgent('m-2', 'tester', {
      behavior,
      runtime,
    });

    const events: AgentEventType[] = [];
    agent.on('spawn', () => events.push('spawn'));
    agent.on('ready', () => events.push('ready'));
    agent.on('complete', () => events.push('complete'));

    const result = await agent.run(makeCtx());

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(2);
    expect(result.usage.totalTokens).toBe(0); // Mock = no LLM
    expect(events).toContain('spawn');
    expect(events).toContain('ready');
    expect(events).toContain('complete');
    expect(agent.status).toBe('stopped');
  });

  it('transitions to error on mock failure', async () => {
    const runtime = makeRuntime();
    runtime.publishEvent.mockRejectedValueOnce(new Error('store crash'));

    const behavior: MockBehavior = {
      actions: [
        { tool: 'publish', args: { type: 'fail', data: {} } },
      ],
    };

    const agent = new MockAgent('m-3', 'tester', { behavior, runtime });
    const result = await agent.run(makeCtx());

    // runMockAgent continues after errors but reports error status
    expect(result.status).toBe('error');
  });

  it('handles empty actions', async () => {
    const agent = new MockAgent('m-4', 'tester', {
      behavior: { actions: [] },
    });

    const result = await agent.run(makeCtx());
    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(0);
  });

  it('stop() sets stopped status', async () => {
    const agent = new MockAgent('m-5', 'tester', {
      behavior: { actions: [] },
    });

    let stopEvent = false;
    agent.on('stop', () => { stopEvent = true; });

    await agent.stop('done testing');
    expect(agent.status).toBe('stopped');
    expect(stopEvent).toBe(true);
  });

  it('supports hook add/remove', () => {
    const agent = new MockAgent('m-6', 'tester', {
      behavior: { actions: [] },
    });

    agent.addHook({
      name: 'test-hook',
      point: 'PreToolUse',
      handler: async () => {},
    });

    agent.removeHook('test-hook');
    agent.removeHook('nonexistent');
  });
});
