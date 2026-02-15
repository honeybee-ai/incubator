import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { AgentConfig, TokenUsage, CompletionResult, ChatMessage } from './types.js';
import type { ToolClient } from './tool-client.js';
import { AgentRunner } from './runner.js';

// vi.hoisted runs in the hoisted scope — safe to reference in vi.mock factory
const { mockChatCompletion } = vi.hoisted(() => ({
  mockChatCompletion: vi.fn(),
}));

vi.mock('./providers.js', () => ({
  chatCompletion: mockChatCompletion,
  getToolCallArgs: (tc: { function: { arguments: unknown } }) => tc.function.arguments,
  resolveProvider: vi.fn(),
}));

const USAGE: TokenUsage = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };
function cr(msg: ChatMessage, usage: TokenUsage = USAGE): CompletionResult {
  return { message: msg, usage };
}

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    agentId: 'audit_test_agent',
    role: 'tester',
    provider: { type: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' },
    serverUrl: 'direct://localhost',
    namespace: 'test',
    maxIterations: 1,
    verbose: false,
    mode: 'worker',
    workDir: '/tmp',
    noAcp: true,
    ...overrides,
  };
}

function makeToolClient(): ToolClient {
  return {
    getToolDefs: vi.fn(() => []),
    hasToolName: vi.fn(() => false),
    callTool: vi.fn(async () => '{}'),
    close: vi.fn(async () => {}),
  } as unknown as ToolClient;
}

function makeTelemetry() {
  return {
    record: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(async () => {}),
    localEnabled: true,
    cloudEnabled: false,
    auditEnabled: false,
    nectarEnabled: false,
    windowCount: 0,
    nectarQueueLength: 0,
    getSnapshot: vi.fn(() => null),
  } as any;
}

describe('AgentRunner audit instrumentation', () => {
  const originalEnv = process.env.NECTAR_CAPTURE;

  beforeEach(() => {
    mockChatCompletion.mockReset();
    mockChatCompletion.mockResolvedValue(cr({ role: 'assistant', content: 'DONE' }));
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NECTAR_CAPTURE;
    } else {
      process.env.NECTAR_CAPTURE = originalEnv;
    }
  });

  it('generates UUID-format runId and traceId in telemetry calls', async () => {
    process.env.NECTAR_CAPTURE = 'true';
    const telemetry = makeTelemetry();
    const runner = new AgentRunner();

    await runner.run(makeConfig(), makeToolClient(), null, null, null, telemetry);

    const calls = telemetry.record.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(3);

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const [, meta] of calls) {
      if (meta?.runId) {
        expect(meta.runId).toMatch(uuidPattern);
      }
      if (meta?.traceId) {
        expect(meta.traceId).toMatch(uuidPattern);
      }
    }
  });

  it('records llm_prompt and llm_response when NECTAR_CAPTURE=true', async () => {
    process.env.NECTAR_CAPTURE = 'true';
    const telemetry = makeTelemetry();
    const runner = new AgentRunner();

    await runner.run(makeConfig(), makeToolClient(), null, null, null, telemetry);

    const eventTypes = telemetry.record.mock.calls.map((c: unknown[]) => c[0]);
    expect(eventTypes).toContain('llm_prompt');
    expect(eventTypes).toContain('llm_response');
  });

  it('does NOT record llm_prompt/llm_response when NECTAR_CAPTURE is unset', async () => {
    delete process.env.NECTAR_CAPTURE;
    const telemetry = makeTelemetry();
    const runner = new AgentRunner();

    await runner.run(makeConfig(), makeToolClient(), null, null, null, telemetry);

    const eventTypes = telemetry.record.mock.calls.map((c: unknown[]) => c[0]);
    expect(eventTypes).not.toContain('llm_prompt');
    expect(eventTypes).not.toContain('llm_response');
    expect(eventTypes).toContain('llm_call');
    expect(eventTypes).toContain('agent_complete');
  });

  it('llm_prompt has _payload with serialized messages array', async () => {
    process.env.NECTAR_CAPTURE = 'true';
    const telemetry = makeTelemetry();
    const runner = new AgentRunner();

    await runner.run(makeConfig(), makeToolClient(), null, null, null, telemetry);

    const promptCall = telemetry.record.mock.calls.find(
      (c: unknown[]) => c[0] === 'llm_prompt',
    );
    expect(promptCall).toBeDefined();
    const meta = promptCall![1] as Record<string, unknown>;
    expect(meta._payload).toBeDefined();
    expect(typeof meta._payload).toBe('string');
    const parsed = JSON.parse(meta._payload as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(2); // system + user
  });

  it('llm_response has _payload with content', async () => {
    process.env.NECTAR_CAPTURE = 'true';
    const telemetry = makeTelemetry();
    const runner = new AgentRunner();

    await runner.run(makeConfig(), makeToolClient(), null, null, null, telemetry);

    const responseCall = telemetry.record.mock.calls.find(
      (c: unknown[]) => c[0] === 'llm_response',
    );
    expect(responseCall).toBeDefined();
    const meta = responseCall![1] as Record<string, unknown>;
    expect(meta._payload).toBeDefined();
    const parsed = JSON.parse(meta._payload as string);
    expect(parsed).toHaveProperty('content');
  });

  it('runId is consistent across all events in a single run', async () => {
    process.env.NECTAR_CAPTURE = 'true';
    const telemetry = makeTelemetry();
    const runner = new AgentRunner();

    await runner.run(makeConfig(), makeToolClient(), null, null, null, telemetry);

    const runIds = telemetry.record.mock.calls
      .map((c: unknown[]) => (c[1] as Record<string, unknown>)?.runId)
      .filter(Boolean);

    expect(runIds.length).toBeGreaterThanOrEqual(3);
    const uniqueRunIds = new Set(runIds);
    expect(uniqueRunIds.size).toBe(1);
  });

  it('traceId changes between iterations', async () => {
    process.env.NECTAR_CAPTURE = 'true';
    const telemetry = makeTelemetry();
    const runner = new AgentRunner();
    const toolClient = makeToolClient();

    mockChatCompletion
      .mockResolvedValueOnce(cr({
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: { path: 'x.ts' } } }],
      }))
      .mockResolvedValueOnce(cr({ role: 'assistant', content: 'DONE' }));

    await runner.run(makeConfig({ maxIterations: 2 }), toolClient, null, null, null, telemetry);

    const llmCallTraceIds = telemetry.record.mock.calls
      .filter((c: unknown[]) => c[0] === 'llm_call')
      .map((c: unknown[]) => (c[1] as Record<string, unknown>).traceId);

    expect(llmCallTraceIds.length).toBeGreaterThanOrEqual(2);
    expect(llmCallTraceIds[0]).not.toBe(llmCallTraceIds[1]);
  });

  it('NECTAR_CAPTURE=1 also enables audit capture', async () => {
    process.env.NECTAR_CAPTURE = '1';
    const telemetry = makeTelemetry();
    const runner = new AgentRunner();

    await runner.run(makeConfig(), makeToolClient(), null, null, null, telemetry);

    const eventTypes = telemetry.record.mock.calls.map((c: unknown[]) => c[0]);
    expect(eventTypes).toContain('llm_prompt');
    expect(eventTypes).toContain('llm_response');
  });

  it('standard telemetry events include runId and traceId even without NECTAR_CAPTURE', async () => {
    delete process.env.NECTAR_CAPTURE;
    const telemetry = makeTelemetry();
    const runner = new AgentRunner();

    await runner.run(makeConfig(), makeToolClient(), null, null, null, telemetry);

    const llmCall = telemetry.record.mock.calls.find(
      (c: unknown[]) => c[0] === 'llm_call',
    );
    expect(llmCall).toBeDefined();
    const meta = llmCall![1] as Record<string, unknown>;
    expect(meta.runId).toBeDefined();
    expect(meta.traceId).toBeDefined();

    const agentComplete = telemetry.record.mock.calls.find(
      (c: unknown[]) => c[0] === 'agent_complete',
    );
    expect(agentComplete).toBeDefined();
    expect((agentComplete![1] as Record<string, unknown>).runId).toBeDefined();
  });
});
