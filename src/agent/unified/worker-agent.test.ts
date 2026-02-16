import { describe, it, expect, vi } from 'vitest';
import { WorkerAgent } from './worker-agent.js';
import type { AgentContext, AgentEventType } from './types.js';
import type { ToolClient } from '../tool-client.js';
import type { ProviderConfig } from '../types.js';

function makeToolClient(): ToolClient {
  return {
    getToolDefs: vi.fn().mockReturnValue([]),
    hasToolName: vi.fn().mockReturnValue(false),
    callTool: vi.fn().mockResolvedValue('ok'),
    close: vi.fn(),
  } as unknown as ToolClient;
}

function makeCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    agentId: 'worker-1',
    role: 'dev',
    namespace: 'default',
    prompt: 'Do the thing.',
    incubatorUrl: 'http://localhost:3100',
    workDir: '/tmp',
    maxIterations: 5,
    verbose: false,
    ...overrides,
  };
}

const PROVIDER: ProviderConfig = { type: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' };

// We need to mock the AgentRunner.run to avoid real LLM calls
vi.mock('../runner.js', () => ({
  AgentRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue({
      agentId: 'worker-1',
      role: 'dev',
      status: 'completed',
      iterations: 3,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      iterationUsage: [],
    }),
    stop: vi.fn(),
  })),
}));

describe('WorkerAgent', () => {
  it('creates with correct properties', () => {
    const agent = new WorkerAgent('w-1', 'developer', {
      toolClient: makeToolClient(),
      provider: PROVIDER,
    });
    expect(agent.id).toBe('w-1');
    expect(agent.role).toBe('developer');
    expect(agent.type).toBe('worker');
    expect(agent.status).toBe('idle');
  });

  it('transitions through lifecycle states', async () => {
    const agent = new WorkerAgent('w-2', 'dev', {
      toolClient: makeToolClient(),
      provider: PROVIDER,
    });

    const states: string[] = [];
    const events: AgentEventType[] = [];

    agent.on('spawn', () => { states.push(agent.status); events.push('spawn'); });
    agent.on('ready', () => { events.push('ready'); });
    agent.on('complete', () => { events.push('complete'); });

    const result = await agent.run(makeCtx());

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(3);
    expect(result.usage.totalTokens).toBe(150);
    expect(events).toContain('spawn');
    expect(events).toContain('ready');
    expect(events).toContain('complete');
  });

  it('emits error event on runner failure', async () => {
    // Override mock for this test
    const { AgentRunner } = await import('../runner.js');
    (AgentRunner as any).mockImplementationOnce(() => ({
      run: vi.fn().mockRejectedValue(new Error('LLM exploded')),
      stop: vi.fn(),
    }));

    const agent = new WorkerAgent('w-3', 'dev', {
      toolClient: makeToolClient(),
      provider: PROVIDER,
    });

    let errorEvent = false;
    agent.on('error', () => { errorEvent = true; });

    const result = await agent.run(makeCtx());

    expect(result.status).toBe('error');
    expect(result.error).toBe('LLM exploded');
    expect(errorEvent).toBe(true);
    expect(agent.status).toBe('error');
  });

  it('stop() calls runner.stop()', async () => {
    const agent = new WorkerAgent('w-4', 'dev', {
      toolClient: makeToolClient(),
      provider: PROVIDER,
    });

    let stopEvent = false;
    agent.on('stop', () => { stopEvent = true; });

    await agent.stop('user requested');
    expect(agent.status).toBe('stopped');
    expect(stopEvent).toBe(true);
  });

  it('supports hook add/remove', () => {
    const agent = new WorkerAgent('w-5', 'dev', {
      toolClient: makeToolClient(),
      provider: PROVIDER,
    });

    agent.addHook({
      name: 'test-hook',
      point: 'PreToolUse',
      handler: async () => {},
    });

    // Doesn't throw
    agent.removeHook('test-hook');
    agent.removeHook('nonexistent');
  });

  it('handles runner returning error status', async () => {
    const { AgentRunner } = await import('../runner.js');
    (AgentRunner as any).mockImplementationOnce(() => ({
      run: vi.fn().mockResolvedValue({
        agentId: 'w-6',
        role: 'dev',
        status: 'error',
        iterations: 1,
        error: 'Max iterations hit',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
      stop: vi.fn(),
    }));

    const agent = new WorkerAgent('w-6', 'dev', {
      toolClient: makeToolClient(),
      provider: PROVIDER,
    });

    const result = await agent.run(makeCtx());
    expect(result.status).toBe('error');
    expect(agent.status).toBe('error');
  });
});
