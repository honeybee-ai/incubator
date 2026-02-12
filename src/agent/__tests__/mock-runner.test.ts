import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runMockAgent } from '../mock-runner.js';
import type { AgentConfig } from '../types.js';
import type { ToolClient } from '../tool-client.js';
import type { DirectRuntime } from '../acp/direct-runtime.js';
import type { MockBehavior } from '../../orchestrator.js';

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    agentId: 'mock_abc123',
    role: 'tester',
    provider: { type: 'ollama', baseUrl: '', model: 'mock' },
    serverUrl: 'direct://localhost',
    namespace: 'test',
    maxIterations: 10,
    verbose: false,
    mode: 'worker',
    workDir: '/tmp',
    noAcp: false,
    ...overrides,
  };
}

function makeMockRuntime(): DirectRuntime & Record<string, ReturnType<typeof vi.fn>> {
  return {
    publishEvent: vi.fn().mockResolvedValue({ id: 'evt-1', type: 'test.done', data: { ok: true } }),
    claimResource: vi.fn().mockResolvedValue({ resource: 'file:main.ts', holder: 'mock_abc123' }),
    releaseResource: vi.fn().mockResolvedValue({ resource: 'file:main.ts', released: true }),
    getState: vi.fn().mockResolvedValue({ status: 'running', count: '5' }),
    setState: vi.fn().mockResolvedValue({ key: 'status', value: 'done' }),
    callDanceTool: vi.fn().mockRejectedValue(new Error('Unknown dance tool')),
    disconnect: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeMockToolClient(tools?: Record<string, unknown>): ToolClient {
  const toolMap = tools ?? {
    read_file: { content: 'hello world' },
    write_file: { success: true },
    run: { exitCode: 0, output: 'done' },
  };
  return {
    getToolDefs: () => Object.keys(toolMap).map(name => ({
      type: 'function' as const,
      function: { name, description: '', parameters: { type: 'object', properties: {}, required: [] } },
    })),
    hasToolName: (name: string) => name in toolMap,
    callTool: vi.fn(async (name: string) => {
      if (name in toolMap) return JSON.stringify(toolMap[name]);
      throw new Error(`Unknown tool: ${name}`);
    }),
    close: vi.fn(async () => {}),
  };
}

describe('runMockAgent', () => {
  let config: AgentConfig;

  beforeEach(() => {
    config = makeConfig();
  });

  it('executes ACP actions in sequence', async () => {
    const runtime = makeMockRuntime();
    const behavior: MockBehavior = {
      actions: [
        { tool: 'publish', args: { type: 'task.started', data: { task: 'test' } } },
        { tool: 'set_state', args: { key: 'status', value: 'done' } },
      ],
    };

    const result = await runMockAgent(behavior, config, null, runtime);
    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(2);
    expect(runtime.publishEvent).toHaveBeenCalledWith('task.started', { task: 'test' });
    expect(runtime.setState).toHaveBeenCalledWith('status', 'done');
  });

  it('executes claim and release', async () => {
    const runtime = makeMockRuntime();
    const behavior: MockBehavior = {
      actions: [
        { tool: 'claim', args: { resource: 'file:main.ts' } },
        { tool: 'release', args: { resource: 'file:main.ts' } },
      ],
    };

    const result = await runMockAgent(behavior, config, null, runtime);
    expect(result.status).toBe('completed');
    expect(runtime.claimResource).toHaveBeenCalledWith('file:main.ts', undefined);
    expect(runtime.releaseResource).toHaveBeenCalledWith('file:main.ts');
  });

  it('dispatches env tools to toolClient', async () => {
    const toolClient = makeMockToolClient();
    const behavior: MockBehavior = {
      actions: [
        { tool: 'read_file', args: { path: 'main.ts' } },
      ],
    };

    const result = await runMockAgent(behavior, config, toolClient, null);
    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(1);
    expect(toolClient.callTool).toHaveBeenCalledWith('read_file', { path: 'main.ts' });
  });

  it('resolves $last template from previous result', async () => {
    const runtime = makeMockRuntime();
    const behavior: MockBehavior = {
      actions: [
        { tool: 'get_state', args: {} },
        { tool: 'set_state', args: { key: 'echo', value: '$last.status' } },
      ],
    };

    const result = await runMockAgent(behavior, config, null, runtime);
    expect(result.status).toBe('completed');
    // get_state returns { status: 'running', count: '5' }
    // $last.status should resolve to 'running'
    expect(runtime.setState).toHaveBeenCalledWith('echo', 'running');
  });

  it('resolves $last without path (whole result)', async () => {
    const runtime = makeMockRuntime();
    const behavior: MockBehavior = {
      actions: [
        { tool: 'get_state', args: {} },
        { tool: 'publish', args: { type: 'state.echo', data: { state: '$last' } } },
      ],
    };

    await runMockAgent(behavior, config, null, runtime);
    // $last should be the entire get_state result
    const publishCall = runtime.publishEvent.mock.calls[0];
    expect(publishCall[0]).toBe('state.echo');
    expect(publishCall[1].state).toEqual({ status: 'running', count: '5' });
  });

  it('resolves nested $last.foo.bar paths', async () => {
    const runtime = makeMockRuntime();
    // Override to return nested data
    runtime.publishEvent.mockResolvedValueOnce({ id: 'evt-1', data: { nested: { deep: 42 } } });
    const behavior: MockBehavior = {
      actions: [
        { tool: 'publish', args: { type: 'test', data: {} } },
        { tool: 'set_state', args: { key: 'deep_val', value: '$last.data.nested.deep' } },
      ],
    };

    await runMockAgent(behavior, config, null, runtime);
    expect(runtime.setState).toHaveBeenCalledWith('deep_val', 42);
  });

  it('respects maxIterations', async () => {
    const runtime = makeMockRuntime();
    const behavior: MockBehavior = {
      actions: [
        { tool: 'publish', args: { type: 'tick', data: {} } },
      ],
      maxIterations: 3,
    };

    const result = await runMockAgent(behavior, config, null, runtime);
    expect(result.iterations).toBe(3);
    expect(runtime.publishEvent).toHaveBeenCalledTimes(3);
  });

  it('cycles through actions when maxIterations > actions.length', async () => {
    const runtime = makeMockRuntime();
    const behavior: MockBehavior = {
      actions: [
        { tool: 'publish', args: { type: 'a', data: {} } },
        { tool: 'publish', args: { type: 'b', data: {} } },
      ],
      maxIterations: 5,
    };

    const result = await runMockAgent(behavior, config, null, runtime);
    expect(result.iterations).toBe(5);
    const types = runtime.publishEvent.mock.calls.map((c: any) => c[0]);
    expect(types).toEqual(['a', 'b', 'a', 'b', 'a']);
  });

  it('handles empty actions array', async () => {
    const result = await runMockAgent(
      { actions: [] },
      config,
      null,
      null,
    );
    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(0);
  });

  it('continues after tool error (does not abort)', async () => {
    const runtime = makeMockRuntime();
    runtime.publishEvent.mockRejectedValueOnce(new Error('store error'));

    const behavior: MockBehavior = {
      actions: [
        { tool: 'publish', args: { type: 'fail', data: {} } },
        { tool: 'set_state', args: { key: 'after', value: 'ok' } },
      ],
    };

    const result = await runMockAgent(behavior, config, null, runtime);
    // Should have run both iterations
    expect(result.iterations).toBe(2);
    // Error from first action recorded but second still ran
    expect(result.status).toBe('error');
    expect(result.error).toContain('store error');
    expect(runtime.setState).toHaveBeenCalledWith('after', 'ok');
  });

  it('throws for unknown tool with no toolClient or runtime', async () => {
    const behavior: MockBehavior = {
      actions: [
        { tool: 'nonexistent', args: {} },
      ],
    };

    const result = await runMockAgent(behavior, config, null, null);
    expect(result.status).toBe('error');
    expect(result.error).toContain('Unknown tool');
  });

  it('emits telemetry events', async () => {
    const runtime = makeMockRuntime();
    const telemetry = { record: vi.fn() } as any;
    const behavior: MockBehavior = {
      actions: [
        { tool: 'publish', args: { type: 'test', data: {} } },
      ],
    };

    await runMockAgent(behavior, config, null, runtime, telemetry);

    // Should have tool_call + agent_complete
    const calls = telemetry.record.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][0]).toBe('tool_call');
    expect(calls[0][1]).toMatchObject({ agentId: 'mock_abc123', tool: 'publish', success: true, mock: true });
    expect(calls[1][0]).toBe('agent_complete');
    expect(calls[1][1]).toMatchObject({ agentId: 'mock_abc123', role: 'tester', exitReason: 'completed', mock: true });
  });

  it('emits error telemetry on tool failure', async () => {
    const runtime = makeMockRuntime();
    runtime.publishEvent.mockRejectedValueOnce(new Error('boom'));
    const telemetry = { record: vi.fn() } as any;
    const behavior: MockBehavior = {
      actions: [
        { tool: 'publish', args: { type: 'test', data: {} } },
      ],
    };

    await runMockAgent(behavior, config, null, runtime, telemetry);

    const toolCall = telemetry.record.mock.calls[0];
    expect(toolCall[0]).toBe('tool_call');
    expect(toolCall[1].success).toBe(false);
    expect(toolCall[1].error).toContain('boom');
  });

  it('returns zero token usage (no LLM calls)', async () => {
    const result = await runMockAgent(
      { actions: [] },
      config,
      null,
      null,
    );
    expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it('respects iterationDelay', async () => {
    const runtime = makeMockRuntime();
    const behavior: MockBehavior = {
      actions: [
        { tool: 'publish', args: { type: 'a', data: {} } },
        { tool: 'publish', args: { type: 'b', data: {} } },
      ],
      iterationDelay: 50,
    };

    const start = Date.now();
    await runMockAgent(behavior, config, null, runtime);
    const elapsed = Date.now() - start;

    // Should have waited ~50ms between actions (1 delay for 2 actions)
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('dispatches dance tools with dance: prefix', async () => {
    const runtime = makeMockRuntime();
    runtime.callDanceTool.mockResolvedValueOnce({ result: 'danced!' });
    const behavior: MockBehavior = {
      actions: [
        { tool: 'dance:make_move', args: { move: 'e2e4' } },
      ],
    };

    const result = await runMockAgent(behavior, config, null, runtime);
    expect(result.status).toBe('completed');
    expect(runtime.callDanceTool).toHaveBeenCalledWith('make_move', { move: 'e2e4' });
  });

  it('tries dance dispatch for unknown tools before failing', async () => {
    const runtime = makeMockRuntime();
    runtime.callDanceTool.mockResolvedValueOnce({ result: 'ok' });
    const behavior: MockBehavior = {
      actions: [
        { tool: 'custom_tool', args: { x: 1 } },
      ],
    };

    const result = await runMockAgent(behavior, config, null, runtime);
    expect(result.status).toBe('completed');
    expect(runtime.callDanceTool).toHaveBeenCalledWith('custom_tool', { x: 1 });
  });

  it('mixed ACP + env tool sequence', async () => {
    const runtime = makeMockRuntime();
    const toolClient = makeMockToolClient();
    const behavior: MockBehavior = {
      actions: [
        { tool: 'claim', args: { resource: 'file:src/api.ts' } },
        { tool: 'read_file', args: { path: 'src/api.ts' } },
        { tool: 'set_state', args: { key: 'reviewed', value: 'true' } },
        { tool: 'release', args: { resource: 'file:src/api.ts' } },
      ],
    };

    const result = await runMockAgent(behavior, config, toolClient, runtime);
    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(4);
    expect(runtime.claimResource).toHaveBeenCalled();
    expect(toolClient.callTool).toHaveBeenCalledWith('read_file', { path: 'src/api.ts' });
    expect(runtime.setState).toHaveBeenCalled();
    expect(runtime.releaseResource).toHaveBeenCalled();
  });

  it('resolves $last templates in nested objects', async () => {
    const runtime = makeMockRuntime();
    runtime.getState.mockResolvedValueOnce({ items: ['a', 'b'] });
    const behavior: MockBehavior = {
      actions: [
        { tool: 'get_state', args: {} },
        { tool: 'publish', args: { type: 'done', data: { items: '$last.items' } } },
      ],
    };

    await runMockAgent(behavior, config, null, runtime);
    const publishCall = runtime.publishEvent.mock.calls[0];
    expect(publishCall[1].items).toEqual(['a', 'b']);
  });

  it('resolves $last templates in arrays', async () => {
    const runtime = makeMockRuntime();
    runtime.getState.mockResolvedValueOnce({ x: 1, y: 2 });
    const behavior: MockBehavior = {
      actions: [
        { tool: 'get_state', args: {} },
        { tool: 'publish', args: { type: 'done', data: { values: ['$last.x', '$last.y'] } } },
      ],
    };

    await runMockAgent(behavior, config, null, runtime);
    const publishCall = runtime.publishEvent.mock.calls[0];
    expect(publishCall[1].values).toEqual([1, 2]);
  });
});
