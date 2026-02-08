import type { ProviderConfig, ChatMessage, ToolCall, ToolDef } from './types.js';

// ─── Provider resolution ────────────────────────────────────────────

const DEFAULT_URLS: Record<string, string> = {
  ollama: 'http://localhost:11434',
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
};

export function resolveProvider(shorthand: string): ProviderConfig {
  const slash = shorthand.indexOf('/');
  if (slash === -1) {
    throw new Error(
      `Invalid provider shorthand "${shorthand}". Use format: provider/model (e.g. ollama/qwen3:32b, openai/gpt-4o, anthropic/claude-sonnet-4-5-20250929)`
    );
  }
  const providerName = shorthand.slice(0, slash);
  const model = shorthand.slice(slash + 1);
  if (!model) {
    throw new Error(`Missing model in provider shorthand "${shorthand}"`);
  }

  const type = providerName === 'ollama' ? 'ollama'
    : providerName === 'anthropic' ? 'anthropic'
    : 'openai'; // openai, groq, together, fireworks, mistral, etc.

  const baseUrl = DEFAULT_URLS[providerName] ?? DEFAULT_URLS.openai;

  // Read API keys from environment
  let apiKey: string | undefined;
  if (type === 'openai') {
    apiKey = process.env.OPENAI_API_KEY;
  } else if (type === 'anthropic') {
    apiKey = process.env.ANTHROPIC_API_KEY;
  }

  return { type, baseUrl, apiKey, model };
}

// ─── Connection checks ──────────────────────────────────────────────

export async function checkConnection(provider: ProviderConfig): Promise<boolean> {
  try {
    if (provider.type === 'ollama') {
      const res = await fetch(`${provider.baseUrl}/api/tags`);
      return res.ok;
    }
    if (provider.type === 'anthropic') {
      // No simple ping endpoint — just check reachability
      const res = await fetch(`${provider.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': provider.apiKey ?? '',
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: provider.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      });
      // 200 or 401 both mean the API is reachable
      return res.status !== 0;
    }
    // OpenAI-compatible: GET /v1/models
    const headers: Record<string, string> = {};
    if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
    const res = await fetch(`${provider.baseUrl}/v1/models`, { headers });
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

export async function checkModel(provider: ProviderConfig): Promise<boolean> {
  if (provider.type === 'ollama') {
    try {
      const res = await fetch(`${provider.baseUrl}/api/tags`);
      if (!res.ok) return false;
      const data = await res.json() as { models?: Array<{ name: string }> };
      const models = data.models ?? [];
      return models.some(m => m.name === provider.model || m.name === `${provider.model}:latest`);
    } catch {
      return false;
    }
  }
  // For OpenAI/Anthropic, skip model check — the API will error if model doesn't exist
  return true;
}

// ─── Chat completion ────────────────────────────────────────────────

export async function chatCompletion(
  provider: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  temperature?: number,
): Promise<ChatMessage> {
  if (provider.type === 'anthropic') {
    return anthropicCompletion(provider, messages, tools, temperature);
  }
  if (provider.type === 'ollama') {
    return ollamaCompletion(provider, messages, tools, temperature);
  }
  return openaiCompletion(provider, messages, tools, temperature);
}

// ─── Ollama (native /api/chat) ──────────────────────────────────────

async function ollamaCompletion(
  provider: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  temperature?: number,
): Promise<ChatMessage> {
  const body: Record<string, unknown> = {
    model: provider.model,
    messages: messages.map(m => {
      const msg: Record<string, unknown> = { role: m.role, content: m.content ?? '' };
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      return msg;
    }),
    stream: false,
    options: {},
  };
  if (tools.length > 0) body.tools = tools;
  if (temperature !== undefined) (body.options as Record<string, unknown>).temperature = temperature;

  const res = await fetch(`${provider.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama error (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    message?: {
      role: string;
      content?: string;
      tool_calls?: Array<{
        function: { name: string; arguments: Record<string, unknown> | string };
      }>;
    };
  };

  const msg = data.message;
  if (!msg) throw new Error('Ollama returned no message');

  const result: ChatMessage = {
    role: 'assistant',
    content: msg.content || null,
  };

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    result.tool_calls = msg.tool_calls.map((tc, i) => ({
      id: `ollama_${Date.now()}_${i}`,
      type: 'function' as const,
      function: {
        name: tc.function.name,
        // Ollama returns arguments as object, normalize to keep it as object
        arguments: tc.function.arguments,
      },
    }));
  }

  return result;
}

// ─── OpenAI-compatible (/v1/chat/completions) ───────────────────────

async function openaiCompletion(
  provider: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  temperature?: number,
): Promise<ChatMessage> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

  const body: Record<string, unknown> = {
    model: provider.model,
    messages: messages.map(m => {
      const msg: Record<string, unknown> = { role: m.role };
      if (m.content !== undefined) msg.content = m.content;
      if (m.tool_calls) msg.tool_calls = m.tool_calls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments),
        },
      }));
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      return msg;
    }),
  };
  if (tools.length > 0) body.tools = tools;
  if (temperature !== undefined) body.temperature = temperature;

  const res = await fetch(`${provider.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI error (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    choices: Array<{
      message: {
        role: string;
        content?: string | null;
        tool_calls?: Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }>;
      };
    }>;
  };

  const choice = data.choices?.[0]?.message;
  if (!choice) throw new Error('OpenAI returned no choices');

  const result: ChatMessage = {
    role: 'assistant',
    content: choice.content ?? null,
  };

  if (choice.tool_calls && choice.tool_calls.length > 0) {
    result.tool_calls = choice.tool_calls.map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.function.name,
        // OpenAI returns arguments as JSON string — parse to object
        arguments: parseArguments(tc.function.arguments),
      },
    }));
  }

  return result;
}

// ─── Anthropic (/v1/messages) ───────────────────────────────────────

interface AnthropicToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

type AnthropicContentBlock = AnthropicToolUse | AnthropicTextBlock;

async function anthropicCompletion(
  provider: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  temperature?: number,
): Promise<ChatMessage> {
  // Convert OpenAI format → Anthropic format
  // System prompt is separate in Anthropic API
  let system: string | undefined;
  const anthropicMessages: Array<{ role: string; content: string | AnthropicContentBlock[] }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = msg.content ?? undefined;
      continue;
    }

    if (msg.role === 'assistant') {
      const content: AnthropicContentBlock[] = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id ?? `call_${Date.now()}`,
            name: tc.function.name,
            input: typeof tc.function.arguments === 'string'
              ? parseArguments(tc.function.arguments)
              : tc.function.arguments,
          });
        }
      }
      anthropicMessages.push({ role: 'assistant', content });
      continue;
    }

    if (msg.role === 'tool') {
      // Anthropic uses tool_result blocks inside a user message
      // Group consecutive tool results into one user message
      const last = anthropicMessages[anthropicMessages.length - 1];
      const toolResult = {
        type: 'tool_result' as const,
        tool_use_id: msg.tool_call_id ?? '',
        content: msg.content ?? '',
      };
      if (last?.role === 'user' && Array.isArray(last.content)) {
        (last.content as unknown[]).push(toolResult);
      } else {
        anthropicMessages.push({ role: 'user', content: [toolResult] as unknown as AnthropicContentBlock[] });
      }
      continue;
    }

    // user message
    anthropicMessages.push({ role: 'user', content: msg.content ?? '' });
  }

  // Convert tool defs to Anthropic format
  const anthropicTools = tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  const body: Record<string, unknown> = {
    model: provider.model,
    max_tokens: 4096,
    messages: anthropicMessages,
  };
  if (system) body.system = system;
  if (anthropicTools.length > 0) body.tools = anthropicTools;
  if (temperature !== undefined) body.temperature = temperature;

  const res = await fetch(`${provider.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic error (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    content: AnthropicContentBlock[];
    stop_reason?: string;
  };

  // Convert Anthropic response → ChatMessage
  const result: ChatMessage = { role: 'assistant', content: null };
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of data.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: block.input,
        },
      });
    }
  }

  if (textParts.length > 0) result.content = textParts.join('\n');
  if (toolCalls.length > 0) result.tool_calls = toolCalls;

  return result;
}

// ─── Utilities ──────────────────────────────────────────────────────

function parseArguments(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

export function getToolCallArgs(tc: ToolCall): Record<string, unknown> {
  if (typeof tc.function.arguments === 'string') {
    return parseArguments(tc.function.arguments);
  }
  return tc.function.arguments;
}
