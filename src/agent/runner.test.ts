import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseRoleCount, AgentRunner } from './runner.js';
import type { ProviderConfig, RunnerConfig } from './types.js';

describe('parseRoleCount', () => {
  it('returns 1 for undefined', () => {
    expect(parseRoleCount(undefined)).toBe(1);
  });

  it('returns the number for plain number', () => {
    expect(parseRoleCount(3)).toBe(3);
  });

  it('returns the number for string number', () => {
    expect(parseRoleCount('5')).toBe(5);
  });

  it('returns minimum for "N+" format', () => {
    expect(parseRoleCount('2+')).toBe(2);
    expect(parseRoleCount('3+')).toBe(3);
  });

  it('returns max for "N-M" range format', () => {
    expect(parseRoleCount('0-1')).toBe(1);
    expect(parseRoleCount('2-5')).toBe(5);
  });

  it('returns at least 1', () => {
    expect(parseRoleCount(0)).toBe(1);
    expect(parseRoleCount('0')).toBe(1);
    expect(parseRoleCount('0+')).toBe(1);
  });

  it('handles edge cases', () => {
    expect(parseRoleCount('abc')).toBe(1);
    expect(parseRoleCount('')).toBe(1);
  });
});

describe('AgentRunner', () => {
  const defaultProvider: ProviderConfig = {
    type: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'test-model',
  };

  afterEach(() => { vi.restoreAllMocks(); });

  function makeConfig(overrides?: Partial<RunnerConfig>): RunnerConfig {
    return {
      defaultProvider,
      serverUrl: 'http://localhost:3100',
      maxIterations: 5,
      verbose: false,
      ...overrides,
    };
  }

  it('runs a full ReAct loop: tool call → result → text → done', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = String(url);

      // Protocol fetch
      if (urlStr.includes('/api/protocol')) {
        return {
          ok: true,
          json: async () => ({
            loaded: true,
            spec: {
              name: 'test',
              title: 'Test',
              roles: { worker: { description: 'Worker' } },
              phases: { work: { description: 'Work phase' } },
            },
          }),
        };
      }

      // Ollama chat API
      if (urlStr.includes('/api/chat')) {
        callCount++;
        if (callCount === 1) {
          // First call: return a tool call
          return {
            ok: true,
            json: async () => ({
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                  function: { name: 'incubator_getState', arguments: { key: 'phase' } },
                }],
              },
            }),
          };
        }
        // Second call: return text (done)
        return {
          ok: true,
          json: async () => ({
            message: { role: 'assistant', content: 'Work complete. DONE' },
          }),
        };
      }

      // REST API call (tool execution)
      return { text: async () => '{"found":true,"entry":{"key":"phase","value":"work"}}' };
    }));

    const runner = new AgentRunner(makeConfig());
    const result = await runner.spawnAgent({
      agentId: 'test_worker',
      role: 'worker',
      provider: defaultProvider,
      serverUrl: 'http://localhost:3100',
      maxIterations: 10,
    });

    expect(result.status).toBe('completed');
    expect(result.agentId).toBe('test_worker');
    expect(result.iterations).toBe(2);
  });

  it('respects maxIterations limit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/protocol')) {
        return {
          ok: true,
          json: async () => ({ loaded: false }),
        };
      }
      if (urlStr.includes('/api/chat')) {
        return {
          ok: true,
          json: async () => ({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                function: { name: 'incubator_getState', arguments: { key: 'phase' } },
              }],
            },
          }),
        };
      }
      return { text: async () => '{"found":false}' };
    }));

    const runner = new AgentRunner(makeConfig({ maxIterations: 3 }));
    const result = await runner.spawnAgent({
      agentId: 'test_worker',
      role: 'worker',
      provider: defaultProvider,
      serverUrl: 'http://localhost:3100',
      maxIterations: 3,
    });

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(3);
  });

  it('stop() flag breaks the loop gracefully', async () => {
    let callCount = 0;
    const runner = new AgentRunner(makeConfig());

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/protocol')) {
        return { ok: true, json: async () => ({ loaded: false }) };
      }
      if (urlStr.includes('/api/chat')) {
        callCount++;
        if (callCount >= 2) runner.stop(); // Stop after 2nd iteration
        return {
          ok: true,
          json: async () => ({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                function: { name: 'incubator_getState', arguments: { key: 'x' } },
              }],
            },
          }),
        };
      }
      return { text: async () => '{}' };
    }));

    const result = await runner.spawnAgent({
      agentId: 'test_worker',
      role: 'worker',
      provider: defaultProvider,
      serverUrl: 'http://localhost:3100',
      maxIterations: 50,
    });

    expect(result.status).toBe('completed');
    expect(result.iterations).toBeLessThanOrEqual(3);
  });

  it('handles LLM errors gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/protocol')) {
        return { ok: true, json: async () => ({ loaded: false }) };
      }
      if (urlStr.includes('/api/chat')) {
        return { ok: false, status: 500, text: async () => 'Internal server error' };
      }
      return { text: async () => '{}' };
    }));

    const runner = new AgentRunner(makeConfig());
    const result = await runner.spawnAgent({
      agentId: 'test_worker',
      role: 'worker',
      provider: defaultProvider,
      serverUrl: 'http://localhost:3100',
      maxIterations: 5,
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Ollama error');
  });

  it('multi-iteration: 2 tool calls before text response', async () => {
    let chatCalls = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/protocol')) {
        return { ok: true, json: async () => ({ loaded: false }) };
      }
      if (urlStr.includes('/api/chat')) {
        chatCalls++;
        if (chatCalls <= 2) {
          return {
            ok: true,
            json: async () => ({
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                  function: { name: 'incubator_getState', arguments: { key: `key_${chatCalls}` } },
                }],
              },
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            message: { role: 'assistant', content: 'All done.' },
          }),
        };
      }
      return { text: async () => '{"found":false}' };
    }));

    const runner = new AgentRunner(makeConfig());
    const result = await runner.spawnAgent({
      agentId: 'test_worker',
      role: 'worker',
      provider: defaultProvider,
      serverUrl: 'http://localhost:3100',
      maxIterations: 10,
    });

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(3); // 2 tool calls + 1 text
  });

  it('spawnFromProtocol parses roles and spawns agents', async () => {
    // Write a real temp spec file
    const specContent = JSON.stringify({
      acp: '1.0',
      name: 'test-protocol',
      title: 'Test Protocol',
      roles: {
        worker: { description: 'Does work', count: '2+' },
        coordinator: { description: 'Manages things', count: '0-1' },
      },
      phases: {
        start: { description: 'Starting' },
        done: { description: 'Done', terminal: true },
      },
    });
    const tmpFile = join(tmpdir(), `test-spec-${Date.now()}.acp.json`);
    writeFileSync(tmpFile, specContent);

    // Minimal fetch mock that ends agents quickly
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/protocol')) {
        return { ok: true, json: async () => ({ loaded: false }) };
      }
      if (urlStr.includes('/api/chat')) {
        return {
          ok: true,
          json: async () => ({
            message: { role: 'assistant', content: 'DONE' },
          }),
        };
      }
      return { text: async () => '{}' };
    }));

    try {
      const runner = new AgentRunner(makeConfig());
      const results = await runner.spawnFromProtocol(tmpFile);

      // 2+ workers → 2, 0-1 coordinator → 1 = 3 total
      expect(results).toHaveLength(3);
      const workerResults = results.filter(r => r.role === 'worker');
      const coordResults = results.filter(r => r.role === 'coordinator');
      expect(workerResults).toHaveLength(2);
      expect(coordResults).toHaveLength(1);

      // All should have unique agentIds
      const ids = results.map(r => r.agentId);
      expect(new Set(ids).size).toBe(3);
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  });
});
