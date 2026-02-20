import type { ProviderConfig, ChatMessage, ToolCall, ToolDef, CompletionResult, TokenUsage } from './types.js';

// ─── Provider Catalog ────────────────────────────────────────────────
// Duplicated across Colony, incubator, and CLI. Keep in sync manually.
// 4-5 providers that rarely change — not worth a shared module.

export interface ProviderEntry {
  tier: 'fast' | 'smart' | 'local';
  baseUrl: string;
  format: 'openai' | 'anthropic' | 'ollama';
  defaultModel: string;
  envVar: string;
  cost: { prompt: number; completion: number };  // $ per million tokens
}

export const PROVIDER_CATALOG: Record<string, ProviderEntry> = {
  cerebras:  { tier: 'fast',  baseUrl: 'https://api.cerebras.ai',       format: 'openai',    defaultModel: 'gpt-oss-120b',              envVar: 'CEREBRAS_API_KEY',  cost: { prompt: 0.10, completion: 0.10 } },
  groq:      { tier: 'fast',  baseUrl: 'https://api.groq.com/openai',   format: 'openai',    defaultModel: 'llama-3.3-70b-versatile',   envVar: 'GROQ_API_KEY',      cost: { prompt: 0.27, completion: 0.27 } },
  openai:    { tier: 'smart', baseUrl: 'https://api.openai.com',        format: 'openai',    defaultModel: 'gpt-4o-mini',               envVar: 'OPENAI_API_KEY',    cost: { prompt: 2.50, completion: 10.00 } },
  anthropic: { tier: 'smart', baseUrl: 'https://api.anthropic.com',     format: 'anthropic', defaultModel: 'claude-sonnet-4-5-20250929', envVar: 'ANTHROPIC_API_KEY', cost: { prompt: 3.00, completion: 15.00 } },
  ollama:    { tier: 'local', baseUrl: 'http://localhost:11434',         format: 'ollama',    defaultModel: 'qwen3:32b',                 envVar: 'OLLAMA_HOST',       cost: { prompt: 0, completion: 0 } },
};

const PROVIDER_ALIASES: Record<string, string> = {
  fast: 'cerebras',
  smart: 'openai',
  local: 'ollama',
};

// ─── Provider resolution ────────────────────────────────────────────

export function resolveProvider(shorthand: string): ProviderConfig {
  // Resolve aliases: "fast" → "cerebras", "smart" → "openai", "local" → "ollama"
  let resolved = shorthand;
  if (PROVIDER_ALIASES[resolved]) {
    resolved = PROVIDER_ALIASES[resolved];
  }

  const slash = resolved.indexOf('/');
  let rawName: string;
  let model: string;

  if (slash === -1) {
    // Provider-only: "cerebras" → "cerebras/llama-3.3-70b"
    rawName = resolved;
    const catalog = PROVIDER_CATALOG[rawName];
    if (!catalog) {
      throw new Error(
        `Unknown provider "${rawName}". Known: ${Object.keys(PROVIDER_CATALOG).join(', ')}. Aliases: ${Object.keys(PROVIDER_ALIASES).join(', ')}.`
      );
    }
    model = catalog.defaultModel;
  } else {
    rawName = resolved.slice(0, slash);
    // Resolve alias in provider part too: "fast/custom-model"
    if (PROVIDER_ALIASES[rawName]) {
      rawName = PROVIDER_ALIASES[rawName];
    }
    model = resolved.slice(slash + 1);
    if (!model) {
      const catalog = PROVIDER_CATALOG[rawName];
      model = catalog?.defaultModel || 'gpt-oss-120b';
    }
  }

  const providerName = rawName;
  const catalog = PROVIDER_CATALOG[providerName];

  const type = providerName === 'ollama' ? 'ollama'
    : providerName === 'anthropic' ? 'anthropic'
    : 'openai'; // groq, cerebras, together, fireworks, etc. are all OpenAI-compatible

  // Support OLLAMA_HOST env var
  let baseUrl = catalog?.baseUrl ?? PROVIDER_CATALOG.openai.baseUrl;
  if (type === 'ollama' && process.env.OLLAMA_HOST) {
    const host = process.env.OLLAMA_HOST;
    baseUrl = host.startsWith('http') ? host : `http://${host}`;
  }

  // API key from env var (catalog knows the var name)
  const envVar = catalog?.envVar;
  let apiKey: string | undefined;
  if (envVar && process.env[envVar]) {
    apiKey = process.env[envVar];
  }

  return { type, baseUrl, apiKey, model, providerName };
}

// ─── Connection checks ──────────────────────────────────────────────

export async function checkConnection(provider: ProviderConfig): Promise<boolean> {
  try {
    if (provider.type === 'ollama') {
      const res = await fetch(`${provider.baseUrl}/api/tags`);
      return res.ok;
    }
    if (provider.type === 'anthropic') {
      const res = await fetch(`${provider.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': provider.apiKey ?? '',
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: provider.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      });
      return res.status !== 0;
    }
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
  return true;
}

// ─── Provider SDK clients (lazy-initialized, cached per API key) ──────

const _sdkModules: Record<string, any> = {};
const _sdkClientCache = new Map<string, any>();

async function getCerebrasClient(apiKey: string) {
  const key = `cerebras:${apiKey}`;
  if (!_sdkClientCache.has(key)) {
    if (!_sdkModules.cerebras) {
      _sdkModules.cerebras = (await import('@cerebras/cerebras_cloud_sdk')).default;
    }
    _sdkClientCache.set(key, new _sdkModules.cerebras({ apiKey }));
  }
  return _sdkClientCache.get(key);
}

async function getGroqClient(apiKey: string) {
  const key = `groq:${apiKey}`;
  if (!_sdkClientCache.has(key)) {
    if (!_sdkModules.groq) {
      _sdkModules.groq = (await import('groq-sdk')).default;
    }
    _sdkClientCache.set(key, new _sdkModules.groq({ apiKey }));
  }
  return _sdkClientCache.get(key);
}

async function getAnthropicClient(apiKey: string) {
  const key = `anthropic:${apiKey}`;
  if (!_sdkClientCache.has(key)) {
    if (!_sdkModules.anthropic) {
      _sdkModules.anthropic = (await import('@anthropic-ai/sdk')).default;
    }
    _sdkClientCache.set(key, new _sdkModules.anthropic({ apiKey }));
  }
  return _sdkClientCache.get(key);
}

// ─── Chat completion ────────────────────────────────────────────────

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export interface CompletionOptions {
  temperature?: number;
  /** Disable model reasoning/thinking (e.g. gpt-oss disable_reasoning). */
  disableReasoning?: boolean;
  /** Reasoning effort level (e.g. 'low', 'medium', 'high'). */
  reasoningEffort?: string;
}

export async function chatCompletion(
  provider: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  temperature?: number,
  options?: CompletionOptions,
): Promise<CompletionResult> {
  const opts: CompletionOptions = { temperature, ...options };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Route to native SDKs when available, fall back to raw fetch
      if (provider.type === 'anthropic') {
        if (provider.apiKey) {
          return await anthropicSdkCompletion(provider, messages, tools, opts.temperature);
        }
        return await anthropicCompletion(provider, messages, tools, opts.temperature);
      }
      if (provider.type === 'ollama') {
        return await ollamaCompletion(provider, messages, tools, opts.temperature);
      }
      // Cerebras and Groq get native SDK handling
      if (provider.providerName === 'cerebras' && provider.apiKey) {
        return await cerebrasSdkCompletion(provider, messages, tools, opts.temperature);
      }
      if (provider.providerName === 'groq' && provider.apiKey) {
        return await groqSdkCompletion(provider, messages, tools, opts.temperature);
      }
      return await openaiCompletion(provider, messages, tools, opts.temperature, opts.disableReasoning, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = msg.includes('(429)') || msg.toLowerCase().includes('rate limit');
      if (!isRateLimit || attempt === MAX_RETRIES) throw err;
      // Exponential backoff with jitter
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
      console.error(`[hive] Rate limited, retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

// ─── Ollama (native /api/chat) ──────────────────────────────────────

async function ollamaCompletion(
  provider: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  temperature?: number,
): Promise<CompletionResult> {
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
    prompt_eval_count?: number;
    eval_count?: number;
  };

  const msg = data.message;
  if (!msg) throw new Error('Ollama returned no message');

  const message: ChatMessage = {
    role: 'assistant',
    content: msg.content || null,
  };

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    message.tool_calls = msg.tool_calls.map((tc, i) => ({
      id: `ollama_${Date.now()}_${i}`,
      type: 'function' as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));
  } else if (message.content) {
    // Fallback: some models emit tool calls as text instead of using native tool_calls.
    const extracted = extractToolCallsFromText(message.content, tools);
    if (extracted.length > 0) {
      message.tool_calls = extracted;
      message.content = null;
    }
  }

  const promptTokens = data.prompt_eval_count ?? 0;
  const completionTokens = data.eval_count ?? 0;
  const usage: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };

  return { message, usage };
}

// ─── OpenAI-compatible (/v1/chat/completions) ───────────────────────

async function openaiCompletion(
  provider: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  temperature?: number,
  disableReasoning?: boolean,
  opts?: CompletionOptions,
): Promise<CompletionResult> {
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
  if (tools.length > 0) {
    body.tools = tools;
    body.parallel_tool_calls = true;
  }
  if (temperature !== undefined) body.temperature = temperature;
  if (opts?.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;

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
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };

  const choice = data.choices?.[0]?.message;
  if (!choice) throw new Error('OpenAI returned no choices');

  // Strip Qwen <think>...</think> blocks from content
  let content = choice.content ?? null;
  if (content) {
    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || null;
  }

  const message: ChatMessage = {
    role: 'assistant',
    content,
  };

  if (choice.tool_calls && choice.tool_calls.length > 0) {
    message.tool_calls = choice.tool_calls.map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.function.name,
        arguments: parseArguments(tc.function.arguments),
      },
    }));
  } else if (message.content && tools.length > 0) {
    // Fallback: some models emit tool calls as text instead of structured tool_calls
    const extracted = extractToolCallsFromText(message.content, tools);
    if (extracted.length > 0) {
      message.tool_calls = extracted;
      message.content = null;
    }
  }

  const usage: TokenUsage = {
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    totalTokens: data.usage?.total_tokens ?? 0,
  };

  return { message, usage };
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
): Promise<CompletionResult> {
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

    anthropicMessages.push({ role: 'user', content: msg.content ?? '' });
  }

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
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };

  const message: ChatMessage = { role: 'assistant', content: null };
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

  if (textParts.length > 0) message.content = textParts.join('\n');
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const inputTokens = data.usage?.input_tokens ?? 0;
  const outputTokens = data.usage?.output_tokens ?? 0;
  const usage: TokenUsage = {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: inputTokens + outputTokens,
  };

  return { message, usage };
}

// ─── SDK-based completions (Cerebras, Groq, Anthropic) ──────────────

async function cerebrasSdkCompletion(
  provider: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  temperature?: number,
): Promise<CompletionResult> {
  const client = await getCerebrasClient(provider.apiKey!);
  const body: Record<string, unknown> = {
    model: provider.model,
    messages: messages.map(m => {
      const msg: Record<string, unknown> = { role: m.role };
      if (m.content !== undefined) msg.content = m.content;
      if (m.tool_calls) msg.tool_calls = m.tool_calls.map(tc => ({
        id: tc.id, type: 'function',
        function: { name: tc.function.name, arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments) },
      }));
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      return msg;
    }),
  };
  if (tools.length > 0) { body.tools = tools; body.parallel_tool_calls = true; }
  if (temperature !== undefined) body.temperature = temperature;

  const response = await client.chat.completions.create(body);
  const choice = response.choices?.[0]?.message;
  if (!choice) throw new Error('Cerebras SDK returned no choices');

  let content = choice.content ?? null;
  if (content) content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || null;

  const message: ChatMessage = { role: 'assistant', content };
  if (choice.tool_calls && choice.tool_calls.length > 0) {
    message.tool_calls = choice.tool_calls.map((tc: any) => ({
      id: tc.id, type: 'function' as const,
      function: { name: tc.function.name, arguments: parseArguments(tc.function.arguments) },
    }));
  } else if (message.content && tools.length > 0) {
    const extracted = extractToolCallsFromText(message.content, tools);
    if (extracted.length > 0) { message.tool_calls = extracted; message.content = null; }
  }

  return {
    message,
    usage: {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    },
  };
}

async function groqSdkCompletion(
  provider: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  temperature?: number,
): Promise<CompletionResult> {
  const client = await getGroqClient(provider.apiKey!);
  const body: Record<string, unknown> = {
    model: provider.model,
    messages: messages.map(m => {
      const msg: Record<string, unknown> = { role: m.role };
      if (m.content !== undefined) msg.content = m.content;
      if (m.tool_calls) msg.tool_calls = m.tool_calls.map(tc => ({
        id: tc.id, type: 'function',
        function: { name: tc.function.name, arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments) },
      }));
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      return msg;
    }),
  };
  if (tools.length > 0) { body.tools = tools; body.parallel_tool_calls = true; }
  if (temperature !== undefined) body.temperature = temperature;

  const response = await client.chat.completions.create(body);
  const choice = response.choices?.[0]?.message;
  if (!choice) throw new Error('Groq SDK returned no choices');

  let content = choice.content ?? null;
  if (content) content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || null;

  const message: ChatMessage = { role: 'assistant', content };
  if (choice.tool_calls && choice.tool_calls.length > 0) {
    message.tool_calls = choice.tool_calls.map((tc: any) => ({
      id: tc.id, type: 'function' as const,
      function: { name: tc.function.name, arguments: parseArguments(tc.function.arguments) },
    }));
  } else if (message.content && tools.length > 0) {
    const extracted = extractToolCallsFromText(message.content, tools);
    if (extracted.length > 0) { message.tool_calls = extracted; message.content = null; }
  }

  return {
    message,
    usage: {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    },
  };
}

async function anthropicSdkCompletion(
  provider: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  temperature?: number,
): Promise<CompletionResult> {
  const client = await getAnthropicClient(provider.apiKey!);

  // Extract system message
  let system: string | undefined;
  const anthropicMessages: Array<{ role: string; content: any }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') { system = msg.content ?? undefined; continue; }
    if (msg.role === 'assistant') {
      const content: any[] = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use', id: tc.id ?? `call_${Date.now()}`, name: tc.function.name,
            input: typeof tc.function.arguments === 'string' ? parseArguments(tc.function.arguments) : tc.function.arguments,
          });
        }
      }
      anthropicMessages.push({ role: 'assistant', content });
      continue;
    }
    if (msg.role === 'tool') {
      const toolResult = { type: 'tool_result' as const, tool_use_id: msg.tool_call_id ?? '', content: msg.content ?? '' };
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) {
        last.content.push(toolResult);
      } else {
        anthropicMessages.push({ role: 'user', content: [toolResult] });
      }
      continue;
    }
    anthropicMessages.push({ role: 'user', content: msg.content ?? '' });
  }

  const anthropicTools = tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  const params: Record<string, unknown> = {
    model: provider.model,
    max_tokens: 4096,
    messages: anthropicMessages,
  };
  if (system) params.system = system;
  if (anthropicTools.length > 0) params.tools = anthropicTools;
  if (temperature !== undefined) params.temperature = temperature;

  const response = await client.messages.create(params);

  const chatMsg: ChatMessage = { role: 'assistant', content: null };
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id, type: 'function',
        function: { name: block.name, arguments: block.input as Record<string, unknown> },
      });
    }
  }

  if (textParts.length > 0) chatMsg.content = textParts.join('\n');
  if (toolCalls.length > 0) chatMsg.tool_calls = toolCalls;

  return {
    message: chatMsg,
    usage: {
      promptTokens: response.usage?.input_tokens ?? 0,
      completionTokens: response.usage?.output_tokens ?? 0,
      totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
    },
  };
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

/**
 * Extract tool calls from text content when a model doesn't use native tool calling.
 */
function extractToolCallsFromText(
  text: string,
  tools: ToolDef[],
): ToolCall[] {
  const toolNames = new Set(tools.map(t => t.function.name));
  const results: ToolCall[] = [];

  const jsonCandidates = extractJsonBlocks(text);

  for (const candidate of jsonCandidates) {
    try {
      const parsed = JSON.parse(candidate);
      const items = Array.isArray(parsed) ? parsed : [parsed];

      for (let item of items) {
        // Handle double-encoded JSON strings (model outputs stringified tool calls)
        if (typeof item === 'string') {
          try { item = JSON.parse(item); } catch { continue; }
        }
        if (!item || typeof item !== 'object') continue;

        if (typeof item.name === 'string' && toolNames.has(item.name)) {
          results.push({
            id: `text_${Date.now()}_${results.length}`,
            type: 'function',
            function: {
              name: item.name,
              arguments: item.arguments ?? item.parameters ?? {},
            },
          });
        }
      }
    } catch { /* not valid JSON */ }
  }

  return results;
}

/** Extract potential JSON blocks from text (fenced or bare). */
function extractJsonBlocks(text: string): string[] {
  const blocks: string[] = [];

  // Fenced code blocks: ```json ... ``` or ``` ... ```
  const fenced = text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g);
  for (const m of fenced) {
    blocks.push(m[1].trim());
  }

  // Bare JSON: find outermost { } or [ ] blocks
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') {
      const close = text[i] === '{' ? '}' : ']';
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === text[i]) depth++;
        else if (text[j] === close) depth--;
        j++;
      }
      if (depth === 0) {
        blocks.push(text.slice(i, j));
        i = j - 1;
      }
    }
  }

  return blocks;
}
