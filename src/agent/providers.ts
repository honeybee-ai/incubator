/**
 * Provider system for Incubator — wraps SDK with native SDK upgrade paths.
 *
 * Shared logic (catalog, resolution, completion, utils) comes from
 * @honeybee-ai/hivemind-sdk/providers. Incubator adds native SDK wrappers
 * for Cerebras, Groq, and Anthropic that use their official client libraries.
 */

import type { ProviderConfig, ChatMessage, ToolDef, CompletionResult, TokenUsage, CompletionOptions } from './types.js';

// ─── Re-exports from SDK ────────────────────────────────────────────

export {
  PROVIDER_CATALOG,
  PROVIDER_ALIASES,
  estimateCost,
  parseArguments,
  getToolCallArgs,
  extractToolCallsFromText,
} from '@honeybee-ai/hivemind-sdk/providers';

export type { ProviderEntry } from '@honeybee-ai/hivemind-sdk/providers';

import {
  resolveProvider as sdkResolveProvider,
  autoDetectProvider as sdkAutoDetectProvider,
  chatCompletion as sdkChatCompletion,
  parseArguments,
} from '@honeybee-ai/hivemind-sdk/providers';

// Wrap SDK resolveProvider to inject process.env as default getKey
export function resolveProvider(shorthand: string): ProviderConfig {
  return sdkResolveProvider(shorthand, (k) => process.env[k]);
}

// Wrap SDK autoDetectProvider to inject process.env as default getKey
export function autoDetectProvider(): ProviderConfig {
  return sdkAutoDetectProvider((k) => process.env[k]);
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

// ─── Chat completion with native SDK upgrade path ────────────────────

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;

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
      // Route to native SDKs when available, fall back to SDK base completion
      if (provider.type === 'anthropic' && provider.apiKey) {
        return await anthropicSdkCompletion(provider, messages, tools, opts.temperature);
      }
      if (provider.providerName === 'cerebras' && provider.apiKey) {
        return await cerebrasSdkCompletion(provider, messages, tools, opts.temperature);
      }
      if (provider.providerName === 'groq' && provider.apiKey) {
        return await groqSdkCompletion(provider, messages, tools, opts.temperature);
      }
      // All other providers use SDK base completion
      return await sdkChatCompletion(provider, messages, tools, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = msg.includes('(429)') || msg.toLowerCase().includes('rate limit');
      if (!isRateLimit || attempt === MAX_RETRIES) throw err;
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
      console.error(`[hive] Rate limited, retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

// ─── Native SDK completions (Cerebras, Groq, Anthropic) ──────────────

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
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: Record<string, unknown> } }> = [];

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
