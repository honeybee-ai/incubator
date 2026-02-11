import { describe, it, expect, vi } from 'vitest';
import { AgentRunner } from './runner.js';
import type { AgentConfig, ToolDef, ChatMessage, CompletionResult, TokenUsage } from './types.js';
import type { ToolClient } from './tool-client.js';

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
function cr(msg: ChatMessage, usage: TokenUsage = ZERO_USAGE): CompletionResult {
  return { message: msg, usage };
}

function makeTool(name: string, desc = ''): ToolDef {
  return {
    type: 'function',
    function: {
      name,
      description: desc || `${name} tool`,
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'path' } }, required: ['path'] },
    },
  };
}

// Mock Propolis client that tracks tool calls
function createMockPropolisClient(toolResults: Record<string, string> = {}, extraTools?: ToolDef[]): ToolClient {
  const toolDefs: ToolDef[] = extraTools ?? [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'path' } }, required: ['path'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write a file',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'path' }, content: { type: 'string', description: 'content' } }, required: ['path', 'content'] },
      },
    },
  ];

  return {
    getToolDefs: vi.fn().mockReturnValue(toolDefs),
    hasToolName: vi.fn((name: string) => toolDefs.some(t => t.function.name === name)),
    callTool: vi.fn((name: string) => Promise.resolve(toolResults[name] ?? `result for ${name}`)),
    close: vi.fn(),
  } as unknown as ToolClient;
}

function createMockRuntime() {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    beforeIteration: vi.fn().mockResolvedValue([]),
    onFileWrite: vi.fn().mockResolvedValue(null),
    onComplete: vi.fn(),
    fetchProtocol: vi.fn().mockResolvedValue(null),
    checkControl: vi.fn().mockResolvedValue({ halted: false, paused: false }),
    waitForResume: vi.fn().mockResolvedValue('resumed'),
    getLastInject: vi.fn().mockReturnValue(null),
    getDanceTools: vi.fn().mockReturnValue(null),
    callDanceTool: vi.fn().mockResolvedValue({ result: 'ok' }),
  };
}

function createConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agentId: 'test-agent',
    role: 'developer',
    provider: { type: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' },
    serverUrl: 'http://localhost:3100',
    namespace: 'default',
    maxIterations: 5,
    verbose: false,
    mode: 'drone',
    propolisTarget: 'stdio:--work-dir=/tmp',
    noAcp: false,
    ...overrides,
  };
}

describe('AgentRunner', () => {
  it('stops when LLM returns no tool calls', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();

    // Mock chatCompletion to return no tool calls
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockResolvedValueOnce(
      cr({ role: 'assistant', content: 'I have no tools to call.' })
    );

    const result = await runner.run(createConfig(), propolis as any, null, null);
    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(1);
  });

  it('stops when LLM says DONE', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();

    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockResolvedValueOnce(
      cr({
        role: 'assistant',
        content: 'Task complete. DONE.',
        tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: { path: 'test.txt' } } }],
      })
    );

    const result = await runner.run(createConfig(), propolis as any, null, null);
    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(1);
  });

  it('stops at max iterations', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();

    // Keep returning tool calls to exhaust iterations
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockResolvedValue(
      cr({
        role: 'assistant',
        content: 'Working...',
        tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: { path: 'test.txt' } } }],
      })
    );

    const result = await runner.run(createConfig({ maxIterations: 3 }), propolis as any, null, null);
    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(3);
  });

  it('intercepts file writes for auto-claims when runtime is active', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();
    const runtime = createMockRuntime();

    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockResolvedValueOnce(
      cr({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: '1', type: 'function', function: { name: 'write_file', arguments: { path: 'test.ts', content: 'hello' } } }],
      })
    ).mockResolvedValueOnce(
      cr({ role: 'assistant', content: 'DONE' })
    );

    await runner.run(createConfig(), propolis as any, null, runtime as any);
    expect(runtime.onFileWrite).toHaveBeenCalledWith('test.ts');
  });

  it('returns claim conflict to LLM when write is blocked', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();
    const runtime = createMockRuntime();
    runtime.onFileWrite.mockResolvedValueOnce('Cannot write to "test.ts": claimed by other-agent');

    vi.spyOn(await import('./providers.js'), 'chatCompletion')
      .mockResolvedValueOnce(
        cr({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: '1', type: 'function', function: { name: 'write_file', arguments: { path: 'test.ts', content: 'hello' } } }],
        })
      )
      .mockResolvedValueOnce(
        cr({ role: 'assistant', content: 'DONE' })
      );

    await runner.run(createConfig(), propolis as any, null, runtime as any);

    // The tool should NOT have been called on Propolis since claim was rejected
    expect(propolis.callTool).not.toHaveBeenCalledWith('write_file', expect.anything());
  });

  it('handles errors gracefully', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();

    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockRejectedValue(
      new Error('LLM connection failed')
    );

    const result = await runner.run(createConfig({ maxRetries: 0 }), propolis as any, null, null);
    expect(result.status).toBe('error');
    expect(result.error).toContain('LLM connection failed');
  });

  it('can be stopped externally', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();

    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockImplementation(() => {
      runner.stop();
      return Promise.resolve(cr({
        role: 'assistant' as const,
        content: 'working...',
        tool_calls: [{ id: '1', type: 'function' as const, function: { name: 'read_file', arguments: { path: 'x' } } }],
      }));
    });

    const result = await runner.run(createConfig(), propolis as any, null, null);
    expect(result.status).toBe('completed');
  });
});

// ─── Sleep/Wake Tests ─────────────────────────────────────────────

describe('AgentRunner — sleep/wake', () => {
  it('sleeps and wakes when wakeOn is configured', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();
    const runtime = createMockRuntime();

    // First: agent responds with no tool calls (enters sleep)
    // After wake: agent responds with DONE
    let callCount = 0;
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(cr({ role: 'assistant', content: 'Waiting for events...' }));
      }
      return Promise.resolve(cr({ role: 'assistant', content: 'Got events. DONE' }));
    });

    runtime.waitForWake = vi.fn().mockResolvedValue(['Event from other: [player.action] attack']);

    const result = await runner.run(
      createConfig({ wakeOn: { types: ['player.action'] } }),
      propolis as any, null, runtime as any,
    );

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(2);
    expect(runtime.waitForWake).toHaveBeenCalledWith({ types: ['player.action'] });
  });

  it('exits when maxWakes is reached', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();
    const runtime = createMockRuntime();

    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockResolvedValue(
      cr({ role: 'assistant', content: 'No tools needed' })
    );

    runtime.waitForWake = vi.fn().mockResolvedValue(['Event from other: [test] data']);

    const result = await runner.run(
      createConfig({ wakeOn: { types: ['test'], maxWakes: 2 }, maxIterations: 20 }),
      propolis as any, null, runtime as any,
    );

    expect(result.status).toBe('completed');
    // 1 initial wake + 1 sleep/wake cycle = 2 calls
    expect(runtime.waitForWake).toHaveBeenCalledTimes(2);
  });

  it('exits on wake timeout (empty events)', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();
    const runtime = createMockRuntime();

    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockResolvedValue(
      cr({ role: 'assistant', content: 'Waiting...' })
    );

    // First call returns event (initial wake), second returns empty (timeout)
    runtime.waitForWake = vi.fn()
      .mockResolvedValueOnce(['Event from other: [test] data'])
      .mockResolvedValueOnce([]);

    const result = await runner.run(
      createConfig({ wakeOn: { types: ['test'], timeout: 100 } }),
      propolis as any, null, runtime as any,
    );

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(1);
  });

  it('DONE overrides wakeOn and exits immediately', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();
    const runtime = createMockRuntime();

    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockResolvedValue(
      cr({ role: 'assistant', content: 'All done. DONE' })
    );

    // Initial wake returns event, then LLM says DONE so no further sleeps
    runtime.waitForWake = vi.fn().mockResolvedValue(['Event from other: [test] data']);

    const result = await runner.run(
      createConfig({ wakeOn: { types: ['test'] } }),
      propolis as any, null, runtime as any,
    );

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(1);
    // Called once for initial wake only
    expect(runtime.waitForWake).toHaveBeenCalledTimes(1);
  });

  it('does not sleep without runtime', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();

    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockResolvedValue(
      cr({ role: 'assistant', content: 'No tools' })
    );

    const result = await runner.run(
      createConfig({ wakeOn: { types: ['test'] } }),
      propolis as any, null, null,
    );

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(1);
  });
});

// ─── Error Handling & Resilience Tests ─────────────────────────────

describe('AgentRunner — resilience', () => {
  it('retries LLM call on failure', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();

    let callCount = 0;
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('Temporary failure');
      return Promise.resolve(cr({ role: 'assistant', content: 'Success! DONE' }));
    });

    const result = await runner.run(createConfig({ maxRetries: 3 }), propolis as any, null, null);
    expect(result.status).toBe('completed');
    expect(callCount).toBe(2);
  });

  it('fails after exhausting retries', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();

    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockRejectedValue(
      new Error('Persistent failure')
    );

    const result = await runner.run(createConfig({ maxRetries: 2 }), propolis as any, null, null);
    expect(result.status).toBe('error');
    expect(result.error).toContain('Persistent failure');
  });

  it('exits when maxTotalTokens is exceeded', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();

    const highUsage: TokenUsage = { promptTokens: 500, completionTokens: 500, totalTokens: 1000 };
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockResolvedValue(
      cr({
        role: 'assistant',
        content: 'Working...',
        tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: { path: 'x' } } }],
      }, highUsage)
    );

    const result = await runner.run(
      createConfig({ maxIterations: 100, maxTotalTokens: 1500 }),
      propolis as any, null, null,
    );

    expect(result.status).toBe('completed');
    // Should stop after 2 iterations (1000 tokens first, then check at 2nd iteration start = 1000 >= 1500? no; after 2nd = 2000 >= 1500 at 3rd check → exits)
    expect(result.iterations).toBeLessThanOrEqual(3);
  });

  it('exits when maxRuntime is exceeded', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();

    let callCount = 0;
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Simulate time passing by faking Date.now
        const originalNow = Date.now;
        Date.now = () => originalNow() + 999999;
        try {
          return cr({
            role: 'assistant',
            content: 'Working...',
            tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: { path: 'x' } } }],
          });
        } finally {
          // Restore immediately - the runtime check will use the patched value
          setTimeout(() => { Date.now = originalNow; }, 0);
        }
      }
      return cr({ role: 'assistant', content: 'DONE' });
    });

    const result = await runner.run(
      createConfig({ maxIterations: 100, maxRuntime: 1 }),
      propolis as any, null, null,
    );

    expect(result.status).toBe('completed');
  });

  it('handles SIGTERM by setting stop flag', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();

    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockImplementation(async () => {
      // Send SIGTERM during execution
      process.emit('SIGTERM', 'SIGTERM');
      return cr({
        role: 'assistant',
        content: 'Working...',
        tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: { path: 'x' } } }],
      });
    });

    const result = await runner.run(createConfig(), propolis as any, null, null);
    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(1);
  });
});

// ─── Tool Filtering Tests ──────────────────────────────────────────

function createMockIncubatorClient(tools: ToolDef[]): ToolClient {
  return {
    getToolDefs: vi.fn().mockReturnValue(tools),
    hasToolName: vi.fn((name: string) => tools.some(t => t.function.name === name)),
    callTool: vi.fn((_name: string) => Promise.resolve('ok')),
    close: vi.fn(),
  } as unknown as ToolClient;
}

describe('AgentRunner — tool filtering', () => {
  it('filters propolis tools by toolFilter whitelist', async () => {
    const runner = new AgentRunner();
    // 11 propolis tools
    const allTools = [
      'read_file', 'write_file', 'list_files', 'glob', 'grep',
      'exec', 'patch_file', 'git_status', 'git_diff', 'git_commit', 'git_log',
    ].map(n => makeTool(n));

    const propolis = createMockPropolisClient({}, allTools);

    let capturedTools: ToolDef[] = [];
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockImplementation(
      (_p: any, _m: any, tools: any) => {
        capturedTools = tools;
        return Promise.resolve(cr({ role: 'assistant', content: 'DONE' }));
      }
    );

    await runner.run(
      createConfig({ toolFilter: ['read_file', 'write_file', 'list_files'] }),
      propolis as any, null, null,
    );

    expect(capturedTools).toHaveLength(3);
    expect(capturedTools.map(t => t.function.name).sort()).toEqual(['list_files', 'read_file', 'write_file']);
  });

  it('passes all propolis tools when toolFilter is null', async () => {
    const runner = new AgentRunner();
    const allTools = ['read_file', 'write_file', 'glob'].map(n => makeTool(n));
    const propolis = createMockPropolisClient({}, allTools);

    let capturedTools: ToolDef[] = [];
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockImplementation(
      (_p: any, _m: any, tools: any) => {
        capturedTools = tools;
        return Promise.resolve(cr({ role: 'assistant', content: 'DONE' }));
      }
    );

    await runner.run(createConfig({ toolFilter: null }), propolis as any, null, null);

    expect(capturedTools).toHaveLength(3);
  });

  it('filters incubator tools with coordination=lite', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient({}, [makeTool('read_file')]);

    // 7 incubator tools (4 are "lite")
    const incTools = [
      'incubator_claim', 'incubator_releaseClaim', 'incubator_setState', 'incubator_publishEvent',
      'incubator_getState', 'incubator_listClaims', 'incubator_getProtocol',
    ].map(n => makeTool(n));
    const incubator = createMockIncubatorClient(incTools);

    let capturedTools: ToolDef[] = [];
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockImplementation(
      (_p: any, _m: any, tools: any) => {
        capturedTools = tools;
        return Promise.resolve(cr({ role: 'assistant', content: 'DONE' }));
      }
    );

    await runner.run(
      createConfig({ noAcp: true, coordination: 'lite' }),
      propolis as any, incubator as any, null,
    );

    // 1 propolis + 4 lite incubator = 5
    expect(capturedTools).toHaveLength(5);
    const incNames = capturedTools.slice(1).map(t => t.function.name).sort();
    expect(incNames).toEqual([
      'incubator_claim', 'incubator_publishEvent', 'incubator_releaseClaim', 'incubator_setState',
    ]);
  });

  it('excludes all incubator tools with coordination=none', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient({}, [makeTool('read_file')]);

    const incTools = ['incubator_claim', 'incubator_setState'].map(n => makeTool(n));
    const incubator = createMockIncubatorClient(incTools);

    let capturedTools: ToolDef[] = [];
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockImplementation(
      (_p: any, _m: any, tools: any) => {
        capturedTools = tools;
        return Promise.resolve(cr({ role: 'assistant', content: 'DONE' }));
      }
    );

    await runner.run(
      createConfig({ noAcp: true, coordination: 'none' }),
      propolis as any, incubator as any, null,
    );

    // Only propolis tool
    expect(capturedTools).toHaveLength(1);
    expect(capturedTools[0].function.name).toBe('read_file');
  });

  it('filters incubator tools with coordination as array', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient({}, [makeTool('read_file')]);

    const incTools = [
      'incubator_claim', 'incubator_releaseClaim', 'incubator_setState',
      'incubator_publishEvent', 'incubator_getState',
    ].map(n => makeTool(n));
    const incubator = createMockIncubatorClient(incTools);

    let capturedTools: ToolDef[] = [];
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockImplementation(
      (_p: any, _m: any, tools: any) => {
        capturedTools = tools;
        return Promise.resolve(cr({ role: 'assistant', content: 'DONE' }));
      }
    );

    await runner.run(
      createConfig({ noAcp: true, coordination: ['incubator_claim', 'incubator_getState'] }),
      propolis as any, incubator as any, null,
    );

    // 1 propolis + 2 picked incubator = 3
    expect(capturedTools).toHaveLength(3);
    const incNames = capturedTools.slice(1).map(t => t.function.name).sort();
    expect(incNames).toEqual(['incubator_claim', 'incubator_getState']);
  });

  it('includes all incubator tools with coordination=full', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient({}, [makeTool('read_file')]);

    const incTools = ['incubator_claim', 'incubator_setState', 'incubator_getState'].map(n => makeTool(n));
    const incubator = createMockIncubatorClient(incTools);

    let capturedTools: ToolDef[] = [];
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockImplementation(
      (_p: any, _m: any, tools: any) => {
        capturedTools = tools;
        return Promise.resolve(cr({ role: 'assistant', content: 'DONE' }));
      }
    );

    await runner.run(
      createConfig({ noAcp: true, coordination: 'full' }),
      propolis as any, incubator as any, null,
    );

    // 1 propolis + 3 incubator = 4
    expect(capturedTools).toHaveLength(4);
  });

  it('combines propolis toolFilter with coordination=lite', async () => {
    const runner = new AgentRunner();
    const allTools = ['read_file', 'write_file', 'glob', 'grep', 'exec'].map(n => makeTool(n));
    const propolis = createMockPropolisClient({}, allTools);

    const incTools = [
      'incubator_claim', 'incubator_releaseClaim', 'incubator_setState',
      'incubator_publishEvent', 'incubator_getState', 'incubator_listClaims',
    ].map(n => makeTool(n));
    const incubator = createMockIncubatorClient(incTools);

    let capturedTools: ToolDef[] = [];
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockImplementation(
      (_p: any, _m: any, tools: any) => {
        capturedTools = tools;
        return Promise.resolve(cr({ role: 'assistant', content: 'DONE' }));
      }
    );

    await runner.run(
      createConfig({
        noAcp: true,
        toolFilter: ['read_file', 'glob'],
        coordination: 'lite',
      }),
      propolis as any, incubator as any, null,
    );

    // 2 propolis (filtered) + 4 lite incubator = 6
    expect(capturedTools).toHaveLength(6);
    const names = capturedTools.map(t => t.function.name);
    expect(names).toContain('read_file');
    expect(names).toContain('glob');
    expect(names).not.toContain('write_file');
    expect(names).toContain('incubator_claim');
    expect(names).not.toContain('incubator_getState');
  });
});

// ─── Dance Tool Tests ────────────────────────────────────────────────

describe('AgentRunner — dance tools', () => {
  it('exposes only dance tools when available (no env/acp tools)', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient({}, [makeTool('read_file')]);
    const runtime = createMockRuntime();

    const danceDefs: ToolDef[] = [
      makeTool('make_move', 'Make a game move'),
      makeTool('get_hand', 'Get current hand'),
    ];
    runtime.getDanceTools.mockReturnValue(danceDefs);

    let capturedTools: ToolDef[] = [];
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockImplementation(
      (_p: any, _m: any, tools: any) => {
        capturedTools = tools;
        return Promise.resolve(cr({ role: 'assistant', content: 'DONE' }));
      }
    );

    await runner.run(createConfig(), propolis as any, null, runtime as any);

    const names = capturedTools.map(t => t.function.name);
    // Dance tools are exclusive — no env or ACP tools
    expect(names).toEqual(['make_move', 'get_hand']);
    expect(names).not.toContain('read_file');
    expect(names).not.toContain('publish_event');
  });

  it('routes dance tool calls via runtime.callDanceTool', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient({}, [makeTool('read_file')]);
    const runtime = createMockRuntime();

    const danceDefs: ToolDef[] = [makeTool('make_move', 'Make a game move')];
    runtime.getDanceTools.mockReturnValue(danceDefs);
    runtime.callDanceTool.mockResolvedValue({ result: { card: 'Ace' } });

    vi.spyOn(await import('./providers.js'), 'chatCompletion')
      .mockResolvedValueOnce(cr({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: '1', type: 'function', function: { name: 'make_move', arguments: { action: 'hit' } } }],
      }))
      .mockResolvedValueOnce(cr({ role: 'assistant', content: 'DONE' }));

    await runner.run(createConfig(), propolis as any, null, runtime as any);

    expect(runtime.callDanceTool).toHaveBeenCalledWith('make_move', { action: 'hit' });
    // Should NOT have called propolis for this tool
    expect(propolis.callTool).not.toHaveBeenCalledWith('make_move', expect.anything());
  });

  it('injects dance state context on wake', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();
    const runtime = createMockRuntime();

    runtime.getLastInject.mockReturnValueOnce('Your hand: [A, K, Q]. Pot: 500.');

    let callCount = 0;
    let capturedMessages: any[] = [];
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockImplementation(
      (_p: any, msgs: any) => {
        callCount++;
        capturedMessages = [...msgs];
        if (callCount === 1) {
          return Promise.resolve(cr({ role: 'assistant', content: 'Waiting...' }));
        }
        return Promise.resolve(cr({ role: 'assistant', content: 'Got it. DONE' }));
      }
    );

    runtime.waitForWake = vi.fn().mockResolvedValue(['Event from dealer: [deal] cards dealt']);

    const result = await runner.run(
      createConfig({ wakeOn: { types: ['deal'] } }),
      propolis as any, null, runtime as any,
    );

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(2);

    // Check that the inject was added as a SYSTEM message before the wake events
    const injectMsg = capturedMessages.find(
      (m: any) => m.role === 'user' && m.content?.includes('Your hand: [A, K, Q]')
    );
    expect(injectMsg).toBeDefined();
    expect(injectMsg.content).toBe('[SYSTEM] Your hand: [A, K, Q]. Pot: 500.');
  });

  it('derives wakeOn from protocol wait field', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();
    const runtime = createMockRuntime();

    // Protocol has wait field for the role
    runtime.fetchProtocol.mockResolvedValue({
      protocol: { name: 'game', title: 'Card Game' },
      role: { name: 'player', description: 'A player' },
      current_phase: 'play',
      instructions: 'Play the game',
      phases: { play: { description: 'Play phase' } },
      wait: { types: ['dealer.action'], max_timeout: 30000 },
    });

    let callCount = 0;
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(cr({ role: 'assistant', content: 'Waiting for dealer...' }));
      }
      return Promise.resolve(cr({ role: 'assistant', content: 'DONE' }));
    });

    runtime.waitForWake = vi.fn().mockResolvedValue(['Event from dealer: [dealer.action] dealt']);

    // No explicit wakeOn in config
    const result = await runner.run(
      createConfig({ wakeOn: undefined }),
      propolis as any, null, runtime as any,
    );

    expect(result.status).toBe('completed');
    // Should have slept and woken — derived wakeOn from spec
    expect(runtime.waitForWake).toHaveBeenCalledWith(expect.objectContaining({
      types: ['dealer.action'],
      timeout: 30000,
    }));
  });

  it('explicit wakeOn overrides spec wait field', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient();
    const runtime = createMockRuntime();

    runtime.fetchProtocol.mockResolvedValue({
      protocol: { name: 'game', title: 'Card Game' },
      role: { name: 'player', description: 'A player' },
      current_phase: 'play',
      instructions: 'Play the game',
      phases: { play: { description: 'Play phase' } },
      wait: { types: ['dealer.action'], max_timeout: 30000 },
    });

    let callCount = 0;
    vi.spyOn(await import('./providers.js'), 'chatCompletion').mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(cr({ role: 'assistant', content: 'Waiting...' }));
      }
      return Promise.resolve(cr({ role: 'assistant', content: 'DONE' }));
    });

    runtime.waitForWake = vi.fn().mockResolvedValue(['Event from x: [custom.event] data']);

    // Explicit wakeOn should take priority
    const result = await runner.run(
      createConfig({ wakeOn: { types: ['custom.event'], timeout: 5000 } }),
      propolis as any, null, runtime as any,
    );

    expect(result.status).toBe('completed');
    expect(runtime.waitForWake).toHaveBeenCalledWith(expect.objectContaining({
      types: ['custom.event'],
      timeout: 5000,
    }));
  });

  it('handles dance tool call errors gracefully', async () => {
    const runner = new AgentRunner();
    const propolis = createMockPropolisClient({}, [makeTool('read_file')]);
    const runtime = createMockRuntime();

    const danceDefs: ToolDef[] = [makeTool('make_move', 'Make a game move')];
    runtime.getDanceTools.mockReturnValue(danceDefs);
    runtime.callDanceTool.mockRejectedValue(new Error('WebSocket not connected'));

    vi.spyOn(await import('./providers.js'), 'chatCompletion')
      .mockResolvedValueOnce(cr({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: '1', type: 'function', function: { name: 'make_move', arguments: { action: 'hit' } } }],
      }))
      .mockResolvedValueOnce(cr({ role: 'assistant', content: 'DONE' }));

    const result = await runner.run(createConfig(), propolis as any, null, runtime as any);

    expect(result.status).toBe('completed');
    // The error should have been returned as a tool result, not thrown
    expect(runtime.callDanceTool).toHaveBeenCalled();
  });
});
