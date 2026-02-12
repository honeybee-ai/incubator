import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentPool, type PoolContext } from './agent-pool.js';
import { createStores } from './server.js';
import { LocalBus } from './bus.js';
import { NamespaceRegistry } from './namespaces.js';
import type { Stores } from './stores/interfaces.js';
import type { NotificationBus } from './bus.js';

// Mock the agent runner to avoid real LLM calls
vi.mock('./agent/runner.js', () => ({
  AgentRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue({
      agentId: 'test_agent',
      role: 'writer',
      status: 'completed',
      iterations: 3,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    }),
    stop: vi.fn(),
  })),
}));

// Mock provider resolution
vi.mock('./agent/providers.js', () => ({
  resolveProvider: vi.fn(() => ({
    type: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'qwen3:8b',
  })),
}));

// Mock native tool client
vi.mock('./agent/native-client.js', () => ({
  NativeToolClient: vi.fn().mockImplementation(() => ({
    getToolDefs: vi.fn(() => []),
    hasToolName: vi.fn(() => false),
    callTool: vi.fn(async () => '{}'),
    close: vi.fn(async () => {}),
  })),
}));

// Mock guard loader
vi.mock('./propolis/guard.js', () => ({
  loadGuard: vi.fn(() => null),
}));

/** Create a mock PluginManager that reports tool entries available. */
function makeMockPluginManager(hasTools = true) {
  return {
    hasToolEntries: vi.fn(() => hasTools),
    getToolEntries: vi.fn(() => hasTools ? [
      {
        def: { type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {}, required: [] } } },
        schema: {},
        handler: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
      },
    ] : []),
    getHandlerMap: vi.fn(() => new Map()),
    getToolNames: vi.fn(() => new Set(['read_file'])),
    getLoadedNames: vi.fn(() => ['propolis']),
    destroyAll: vi.fn(async () => {}),
  };
}

function makePoolContext(overrides?: Partial<PoolContext>): PoolContext {
  const bus = new LocalBus();
  const registry = new NamespaceRegistry();
  registry.setBus(bus);
  const stores = registry.get('default');

  return {
    stores,
    bus,
    registry,
    namespace: 'default',
    workDir: '/tmp/test',
    guard: null,
    verbose: false,
    provider: 'ollama/qwen3:8b',
    pluginManager: makeMockPluginManager() as any,
    ...overrides,
  };
}

describe('AgentPool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts an agent and returns agentId', async () => {
    const pool = new AgentPool();
    const ctx = makePoolContext();

    const agentId = await pool.startAgent({ role: 'writer' }, ctx);
    expect(agentId).toMatch(/^writer_[0-9a-f]{6}$/);
    expect(pool.size).toBe(1);
  });

  it('getAgents() returns running agent info', async () => {
    const pool = new AgentPool();
    const ctx = makePoolContext();

    await pool.startAgent({ role: 'writer' }, ctx);
    await pool.startAgent({ role: 'researcher' }, ctx);

    const agents = pool.getAgents();
    expect(agents.length).toBe(2);
    expect(agents[0].type).toBe('worker');
    expect(agents.find(a => a.role === 'writer')).toBeDefined();
    expect(agents.find(a => a.role === 'researcher')).toBeDefined();
  });

  it('agents resolve with AgentResult', async () => {
    const pool = new AgentPool();
    const ctx = makePoolContext();

    await pool.startAgent({ role: 'writer' }, ctx);
    const results = await pool.waitForAll();

    expect(results.length).toBe(1);
    expect(results[0].status).toBe('completed');
  });

  it('killAgent() stops a running agent', async () => {
    const pool = new AgentPool();
    const ctx = makePoolContext();

    const agentId = await pool.startAgent({ role: 'writer' }, ctx);
    await pool.killAgent(agentId);

    // Agent should be removed from pool
    expect(pool.getAgents().length).toBe(0);
  });

  it('shutdown() stops all agents', async () => {
    const pool = new AgentPool();
    const ctx = makePoolContext();

    await pool.startAgent({ role: 'writer' }, ctx);
    await pool.startAgent({ role: 'researcher' }, ctx);

    await pool.shutdown();
    expect(pool.size).toBe(0);
  });

  it('multiple agents run concurrently', async () => {
    const pool = new AgentPool();
    const ctx = makePoolContext();

    const id1 = await pool.startAgent({ role: 'writer' }, ctx);
    const id2 = await pool.startAgent({ role: 'writer' }, ctx);

    expect(id1).not.toBe(id2);
    expect(pool.size).toBe(2);

    const results = await pool.waitForAll();
    expect(results.length).toBe(2);
  });

  it('agent errors do not crash the pool', async () => {
    // Override runner mock to reject
    const { AgentRunner } = await import('./agent/runner.js');
    (AgentRunner as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      run: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
      stop: vi.fn(),
    }));

    const pool = new AgentPool();
    const ctx = makePoolContext();

    await pool.startAgent({ role: 'writer' }, ctx);

    // Should not throw
    const results = await pool.waitForAll();
    expect(results.length).toBe(1);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toBe('LLM unavailable');
  });

  it('passes tool filter from agent spec', async () => {
    const { NativeToolClient } = await import('./agent/native-client.js');
    const pool = new AgentPool();
    const ctx = makePoolContext();

    await pool.startAgent({ role: 'reader', tools: ['read_file', 'list_dir'] }, ctx);

    // NativeToolClient should have been called with entries + filter
    expect(NativeToolClient).toHaveBeenCalledWith(
      expect.any(Array),
      ['read_file', 'list_dir'],
    );
  });

  it('uses NullToolClient when no plugin manager', async () => {
    const pool = new AgentPool();
    const ctx = makePoolContext({ pluginManager: undefined });

    const agentId = await pool.startAgent({ role: 'writer' }, ctx);
    expect(agentId).toMatch(/^writer_/);
  });

  it('uses NullToolClient when plugin manager has no tools', async () => {
    const pool = new AgentPool();
    const ctx = makePoolContext({ pluginManager: makeMockPluginManager(false) as any });

    const { NativeToolClient } = await import('./agent/native-client.js');
    const agentId = await pool.startAgent({ role: 'writer' }, ctx);
    expect(agentId).toMatch(/^writer_/);
    // NativeToolClient should NOT have been called (falls through to NullToolClient)
    expect(NativeToolClient).not.toHaveBeenCalled();
  });
});
