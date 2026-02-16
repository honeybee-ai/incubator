import { describe, it, expect, vi } from 'vitest';
import { createAgent } from './factory.js';
import type { AgentSpec } from '../../orchestrator.js';
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

const PROVIDER: ProviderConfig = { type: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' };

// Mock the runner to prevent real LLM calls
vi.mock('../runner.js', () => ({
  AgentRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue({
      agentId: 'test',
      role: 'dev',
      status: 'completed',
      iterations: 1,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    }),
    stop: vi.fn(),
  })),
}));

describe('createAgent', () => {
  it('creates WorkerAgent for type: worker', () => {
    const spec: AgentSpec = { role: 'developer', type: 'worker' };
    const agent = createAgent(spec, 'w-1', {
      workerDeps: { toolClient: makeToolClient(), provider: PROVIDER },
    });

    expect(agent.id).toBe('w-1');
    expect(agent.role).toBe('developer');
    expect(agent.type).toBe('worker');
    expect(agent.status).toBe('idle');
  });

  it('creates WorkerAgent by default (no type)', () => {
    const spec: AgentSpec = { role: 'dev' };
    const agent = createAgent(spec, 'w-2', {
      workerDeps: { toolClient: makeToolClient(), provider: PROVIDER },
    });

    expect(agent.type).toBe('worker');
  });

  it('creates MockAgent for type: mock', () => {
    const spec: AgentSpec = {
      role: 'tester',
      type: 'mock',
      mock: {
        actions: [
          { tool: 'publish', args: { type: 'test.done' } },
        ],
      },
    };

    const agent = createAgent(spec, 'm-1', {});
    expect(agent.type).toBe('mock');
    expect(agent.role).toBe('tester');
  });

  it('creates MockAgent with empty behavior when mock field missing', () => {
    const spec: AgentSpec = { role: 'tester', type: 'mock' };
    const agent = createAgent(spec, 'm-2', {});

    expect(agent.type).toBe('mock');
  });

  it('creates ClaudeAgent for type: claude', () => {
    const spec: AgentSpec = { role: 'architect', type: 'claude' };
    const agent = createAgent(spec, 'c-1', {
      claudeOptions: { pluginDir: '/opt/acp' },
    });

    expect(agent.type).toBe('claude');
    expect(agent.role).toBe('architect');
  });

  it('creates WorkerAgent fallback for type: drone', () => {
    const spec: AgentSpec = { role: 'scanner', type: 'drone' };
    const agent = createAgent(spec, 'd-1', {
      workerDeps: { toolClient: makeToolClient(), provider: PROVIDER },
    });

    // Phase 2: DroneAgent. For now, falls back to worker.
    expect(agent.type).toBe('worker');
  });

  it('throws on unknown type', () => {
    const spec = { role: 'unknown', type: 'quantum' as any };
    expect(() => createAgent(spec, 'q-1', {})).toThrow('Unknown agent type: quantum');
  });

  it('throws when worker deps missing', () => {
    const spec: AgentSpec = { role: 'dev', type: 'worker' };
    expect(() => createAgent(spec, 'w-3', {})).toThrow('workerDeps');
  });

  it('throws when drone deps missing', () => {
    const spec: AgentSpec = { role: 'dev', type: 'drone' };
    expect(() => createAgent(spec, 'd-2', {})).toThrow('workerDeps');
  });

  it('applies default hooks to all agent types', () => {
    const hookHandler = vi.fn();
    const defaultHooks = [{
      name: 'telemetry',
      point: 'PostToolUse' as const,
      handler: hookHandler,
    }];

    // Worker
    const worker = createAgent({ role: 'dev' }, 'w-h1', {
      workerDeps: { toolClient: makeToolClient(), provider: PROVIDER },
      defaultHooks,
    });

    // Mock
    const mock = createAgent({ role: 'tester', type: 'mock' }, 'm-h1', {
      defaultHooks,
    });

    // Claude
    const claude = createAgent({ role: 'arch', type: 'claude' }, 'c-h1', {
      defaultHooks,
    });

    // All should have hooks (verified by not throwing on removeHook)
    worker.removeHook('telemetry');
    mock.removeHook('telemetry');
    claude.removeHook('telemetry');
  });
});
