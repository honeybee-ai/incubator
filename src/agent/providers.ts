import type { ProviderConfig, ChatMessage, ToolCall, ToolDef, CompletionResult, TokenUsage } from './types.js';

// ─── Provider resolution ────────────────────────────────────────────

const DEFAULT_URLS: Record<string, string> = {
  ollama: 'http://localhost:11434',
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  groq: 'https://api.groq.com/openai',
  cerebras: 'https://api.cerebras.ai',
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
    : 'openai'; // groq, together, fireworks, etc. are all OpenAI-compatible

  // Support OLLAMA_HOST env var
  let baseUrl = DEFAULT_URLS[providerName] ?? DEFAULT_URLS.openai;
  if (type === 'ollama' && process.env.OLLAMA_HOST) {
    const host = process.env.OLLAMA_HOST;
    baseUrl = host.startsWith('http') ? host : `http://${host}`;
  }

  let apiKey: string | undefined;
  if (providerName === 'cerebras') {
    apiKey = process.env.CEREBRAS_API_KEY;
  } else if (providerName === 'groq') {
    apiKey = process.env.GROQ_API_KEY;
  } else if (type === 'openai') {
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
      if (provider.type === 'anthropic') {
        return await anthropicCompletion(provider, messages, tools, opts.temperature);
      }
      if (provider.type === 'ollama') {
        return await ollamaCompletion(provider, messages, tools, opts.temperature);
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

      for (const item of items) {
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
