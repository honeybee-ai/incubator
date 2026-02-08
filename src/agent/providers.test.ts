import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveProvider, chatCompletion, checkConnection, checkModel, getToolCallArgs } from './providers.js';
import type { ProviderConfig, ChatMessage, ToolDef } from './types.js';

const mockTools: ToolDef[] = [{
  type: 'function',
  function: {
    name: 'test_tool',
    description: 'A test tool',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'test' } },
      required: ['key'],
    },
  },
}];

describe('resolveProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('parses ollama shorthand', () => {
    const p = resolveProvider('ollama/qwen3:32b');
    expect(p.type).toBe('ollama');
    expect(p.model).toBe('qwen3:32b');
    expect(p.baseUrl).toBe('http://localhost:11434');
    expect(p.apiKey).toBeUndefined();
  });

  it('parses openai shorthand and reads OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const p = resolveProvider('openai/gpt-4o');
    expect(p.type).toBe('openai');
    expect(p.model).toBe('gpt-4o');
    expect(p.baseUrl).toBe('https://api.openai.com');
    expect(p.apiKey).toBe('sk-test');
  });

  it('parses anthropic shorthand and reads ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const p = resolveProvider('anthropic/claude-sonnet-4-5-20250929');
    expect(p.type).toBe('anthropic');
    expect(p.model).toBe('claude-sonnet-4-5-20250929');
    expect(p.baseUrl).toBe('https://api.anthropic.com');
    expect(p.apiKey).toBe('sk-ant-test');
  });

  it('treats unknown providers as openai-compatible', () => {
    const p = resolveProvider('groq/llama-3.3-70b-versatile');
    expect(p.type).toBe('openai');
    expect(p.model).toBe('llama-3.3-70b-versatile');
  });

  it('throws on missing slash', () => {
    expect(() => resolveProvider('ollama')).toThrow('Invalid provider shorthand');
  });

  it('throws on missing model', () => {
    expect(() => resolveProvider('ollama/')).toThrow('Missing model');
  });
});

describe('chatCompletion — Ollama', () => {
  const provider: ProviderConfig = { type: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' };
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
  ];

  afterEach(() => { vi.restoreAllMocks(); });

  it('handles text response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { role: 'assistant', content: 'Hi there!' } }),
    }));

    const result = await chatCompletion(provider, messages, []);
    expect(result.role).toBe('assistant');
    expect(result.content).toBe('Hi there!');
    expect(result.tool_calls).toBeUndefined();
  });

  it('handles tool call response with object arguments', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            function: { name: 'test_tool', arguments: { key: 'value' } },
          }],
        },
      }),
    }));

    const result = await chatCompletion(provider, messages, mockTools);
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls![0].function.name).toBe('test_tool');
    // Ollama returns arguments as object
    expect(result.tool_calls![0].function.arguments).toEqual({ key: 'value' });
    // Generated id
    expect(result.tool_calls![0].id).toMatch(/^ollama_/);
  });

  it('throws on error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'model not found',
    }));

    await expect(chatCompletion(provider, messages, [])).rejects.toThrow('Ollama error (500)');
  });
});

describe('chatCompletion — OpenAI', () => {
  const provider: ProviderConfig = { type: 'openai', baseUrl: 'https://api.openai.com', apiKey: 'sk-test', model: 'gpt-4o' };
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Hello' },
  ];

  afterEach(() => { vi.restoreAllMocks(); });

  it('handles text response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'Hello!' } }],
      }),
    }));

    const result = await chatCompletion(provider, messages, []);
    expect(result.content).toBe('Hello!');
  });

  it('handles tool call with string arguments (parsed to object)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_abc',
              type: 'function',
              function: { name: 'test_tool', arguments: '{"key":"value"}' },
            }],
          },
        }],
      }),
    }));

    const result = await chatCompletion(provider, messages, mockTools);
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls![0].id).toBe('call_abc');
    // OpenAI string arguments are parsed to object
    expect(result.tool_calls![0].function.arguments).toEqual({ key: 'value' });
  });

  it('sends Authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await chatCompletion(provider, messages, []);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers['Authorization']).toBe('Bearer sk-test');
  });
});

describe('chatCompletion — Anthropic', () => {
  const provider: ProviderConfig = { type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-5-20250929' };

  afterEach(() => { vi.restoreAllMocks(); });

  it('converts system message and handles text response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'Hello from Claude!' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: 'Hi' },
    ];
    const result = await chatCompletion(provider, messages, []);

    expect(result.content).toBe('Hello from Claude!');

    // Verify system was sent separately
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.system).toBe('Be helpful');
    // System message should not appear in messages array
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
  });

  it('handles tool_use response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          { type: 'text', text: 'Let me check that.' },
          { type: 'tool_use', id: 'toolu_abc', name: 'test_tool', input: { key: 'value' } },
        ],
      }),
    }));

    const result = await chatCompletion(provider, [{ role: 'user', content: 'test' }], mockTools);
    expect(result.content).toBe('Let me check that.');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls![0].id).toBe('toolu_abc');
    expect(result.tool_calls![0].function.name).toBe('test_tool');
    expect(result.tool_calls![0].function.arguments).toEqual({ key: 'value' });
  });

  it('converts tool results to tool_result blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'Done.' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const messages: ChatMessage[] = [
      { role: 'user', content: 'test' },
      {
        role: 'assistant',
        content: 'checking',
        tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'test_tool', arguments: { key: 'v' } } }],
      },
      { role: 'tool', content: '{"result": true}', tool_call_id: 'toolu_1' },
    ];

    await chatCompletion(provider, messages, mockTools);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);

    // Assistant message should have tool_use block
    expect(body.messages[1].role).toBe('assistant');
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'toolu_1', name: 'test_tool', input: { key: 'v' } },
    ]);

    // Tool result should be in a user message with tool_result block
    expect(body.messages[2].role).toBe('user');
    expect(body.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"result": true}' },
    ]);
  });

  it('sends correct headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await chatCompletion(provider, [{ role: 'user', content: 'hi' }], []);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });
});

describe('checkConnection', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns true for reachable Ollama', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const result = await checkConnection({ type: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' });
    expect(result).toBe(true);
  });

  it('returns false on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await checkConnection({ type: 'ollama', baseUrl: 'http://localhost:11434', model: 'test' });
    expect(result).toBe(false);
  });
});

describe('checkModel', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('finds model in Ollama tags', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'qwen3:32b' }, { name: 'llama3:8b' }] }),
    }));
    const result = await checkModel({ type: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3:32b' });
    expect(result).toBe(true);
  });

  it('returns false for missing Ollama model', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3:8b' }] }),
    }));
    const result = await checkModel({ type: 'ollama', baseUrl: 'http://localhost:11434', model: 'nonexistent' });
    expect(result).toBe(false);
  });

  it('always returns true for OpenAI', async () => {
    const result = await checkModel({ type: 'openai', baseUrl: 'https://api.openai.com', model: 'gpt-4o' });
    expect(result).toBe(true);
  });
});

describe('getToolCallArgs', () => {
  it('handles string arguments', () => {
    const tc = { function: { name: 'test', arguments: '{"key":"value"}' } };
    expect(getToolCallArgs(tc)).toEqual({ key: 'value' });
  });

  it('handles object arguments', () => {
    const tc = { function: { name: 'test', arguments: { key: 'value' } } };
    expect(getToolCallArgs(tc)).toEqual({ key: 'value' });
  });

  it('handles malformed JSON string', () => {
    const tc = { function: { name: 'test', arguments: 'not json' } };
    expect(getToolCallArgs(tc)).toEqual({});
  });
});
