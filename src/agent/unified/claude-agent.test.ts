import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeAgent } from './claude-agent.js';
import type { AgentContext, AgentEventType } from './types.js';

function makeCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    agentId: 'claude-1',
    role: 'architect',
    namespace: 'default',
    prompt: 'Design the system.',
    incubatorUrl: 'http://localhost:3100',
    workDir: '/tmp/project',
    verbose: false,
    ...overrides,
  };
}

// Mock the SDK — dynamic import needs vi.mock
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(async function* ({ prompt }: { prompt: string }) {
    // Simulate 2 iterations
    yield {
      type: 'assistant',
      message: { content: [{ text: `Processing: ${prompt.slice(0, 20)}` }] },
    };
    yield {
      type: 'assistant',
      message: { content: [{ text: 'Done.' }] },
    };
  }),
}));

describe('ClaudeAgent', () => {
  it('creates with correct properties', () => {
    const agent = new ClaudeAgent('c-1', 'architect');
    expect(agent.id).toBe('c-1');
    expect(agent.role).toBe('architect');
    expect(agent.type).toBe('claude');
    expect(agent.status).toBe('idle');
  });

  it('runs with mocked SDK and returns result', async () => {
    const agent = new ClaudeAgent('c-2', 'architect');

    const events: AgentEventType[] = [];
    agent.on('spawn', () => events.push('spawn'));
    agent.on('ready', () => events.push('ready'));
    agent.on('complete', () => events.push('complete'));
    agent.on('iteration_start', () => events.push('iteration_start'));

    const result = await agent.run(makeCtx());

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(2);
    expect(events).toContain('spawn');
    expect(events).toContain('ready');
    expect(events).toContain('complete');
    expect(events).toContain('iteration_start');
  });

  it('passes correct env vars to SDK', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const queryMock = vi.mocked(sdk.query);
    queryMock.mockClear();

    const agent = new ClaudeAgent('c-3', 'reviewer');
    await agent.run(makeCtx({
      agentId: 'c-3',
      role: 'reviewer',
      namespace: 'test-ns',
      incubatorUrl: 'https://horus.ellyseum.dev:8080',
      env: { CUSTOM: 'value' },
    }));

    expect(queryMock).toHaveBeenCalledTimes(1);
    const callArgs = queryMock.mock.calls[0][0];
    expect(callArgs.options.env).toMatchObject({
      INCUBATOR_URL: 'https://horus.ellyseum.dev:8080',
      ACP_NAMESPACE: 'test-ns',
      ACP_AGENT_ID: 'c-3',
      ACP_ROLE: 'reviewer',
      CUSTOM: 'value',
    });
  });

  it('passes model and workDir to SDK', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const queryMock = vi.mocked(sdk.query);
    queryMock.mockClear();

    const agent = new ClaudeAgent('c-4', 'dev');
    await agent.run(makeCtx({
      model: 'claude-sonnet-4-5-20250929',
      workDir: '/home/user/project',
    }));

    const callArgs = queryMock.mock.calls[0][0];
    expect(callArgs.options.model).toBe('claude-sonnet-4-5-20250929');
    expect(callArgs.options.cwd).toBe('/home/user/project');
  });

  it('handles stop() by aborting iteration', async () => {
    const agent = new ClaudeAgent('c-5', 'dev');

    let stopEvent = false;
    agent.on('stop', () => { stopEvent = true; });

    await agent.stop('user cancelled');
    expect(agent.status).toBe('stopped');
    expect(stopEvent).toBe(true);
  });

  it('supports custom allowedTools', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const queryMock = vi.mocked(sdk.query);
    queryMock.mockClear();

    const agent = new ClaudeAgent('c-6', 'dev', {
      allowedTools: ['Read', 'Bash'],
    });
    await agent.run(makeCtx());

    const callArgs = queryMock.mock.calls[0][0];
    expect(callArgs.options.allowedTools).toEqual(['Read', 'Bash']);
  });

  it('supports custom maxTurns', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const queryMock = vi.mocked(sdk.query);
    queryMock.mockClear();

    const agent = new ClaudeAgent('c-7', 'dev', { maxTurns: 25 });
    await agent.run(makeCtx());

    const callArgs = queryMock.mock.calls[0][0];
    expect(callArgs.options.maxTurns).toBe(25);
  });

  it('handles SDK error gracefully', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    vi.mocked(sdk.query).mockImplementationOnce(async function* () {
      throw new Error('API rate limit');
    });

    const agent = new ClaudeAgent('c-8', 'dev');
    let errorEvent = false;
    agent.on('error', () => { errorEvent = true; });

    const result = await agent.run(makeCtx());
    expect(result.status).toBe('error');
    expect(result.error).toBe('API rate limit');
    expect(errorEvent).toBe(true);
  });

  it('adds ACP MCP server when pluginDir specified', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const queryMock = vi.mocked(sdk.query);
    queryMock.mockClear();

    const agent = new ClaudeAgent('c-9', 'dev', {
      pluginDir: '/opt/acp-plugin',
    });
    await agent.run(makeCtx());

    const callArgs = queryMock.mock.calls[0][0];
    expect(callArgs.options.mcpServers).toBeDefined();
    expect(callArgs.options.mcpServers.acp).toBeDefined();
    expect(callArgs.options.mcpServers.acp.command).toBe('node');
    expect(callArgs.options.mcpServers.acp.args[0]).toContain('mcp-server.js');
  });

  it('supports hook add/remove', () => {
    const agent = new ClaudeAgent('c-10', 'dev');

    agent.addHook({
      name: 'test-hook',
      point: 'PreToolUse',
      handler: async () => {},
    });

    agent.removeHook('test-hook');
    agent.removeHook('nonexistent');
  });
});
