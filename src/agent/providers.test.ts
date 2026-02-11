import { describe, it, expect } from 'vitest';
import { resolveProvider, getToolCallArgs } from './providers.js';

describe('resolveProvider', () => {
  it('parses ollama shorthand', () => {
    const p = resolveProvider('ollama/qwen3:8b');
    expect(p.type).toBe('ollama');
    expect(p.model).toBe('qwen3:8b');
    expect(p.baseUrl).toBe('http://localhost:11434');
    expect(p.apiKey).toBeUndefined();
  });

  it('parses openai shorthand', () => {
    const p = resolveProvider('openai/gpt-4o');
    expect(p.type).toBe('openai');
    expect(p.model).toBe('gpt-4o');
    expect(p.baseUrl).toBe('https://api.openai.com');
  });

  it('parses anthropic shorthand', () => {
    const p = resolveProvider('anthropic/claude-sonnet-4-5-20250929');
    expect(p.type).toBe('anthropic');
    expect(p.model).toBe('claude-sonnet-4-5-20250929');
    expect(p.baseUrl).toBe('https://api.anthropic.com');
  });

  it('treats unknown providers as openai-compatible', () => {
    const p = resolveProvider('groq/llama3');
    expect(p.type).toBe('openai');
    expect(p.model).toBe('llama3');
  });

  it('parses cerebras shorthand', () => {
    const p = resolveProvider('cerebras/llama-4-scout-17b-16e-instruct');
    expect(p.type).toBe('openai');
    expect(p.model).toBe('llama-4-scout-17b-16e-instruct');
    expect(p.baseUrl).toBe('https://api.cerebras.ai');
  });

  it('resolves CEREBRAS_API_KEY env var', () => {
    const orig = process.env.CEREBRAS_API_KEY;
    process.env.CEREBRAS_API_KEY = 'csk-test-key';
    try {
      const p = resolveProvider('cerebras/llama-4-scout-17b-16e-instruct');
      expect(p.apiKey).toBe('csk-test-key');
    } finally {
      if (orig) process.env.CEREBRAS_API_KEY = orig;
      else delete process.env.CEREBRAS_API_KEY;
    }
  });

  it('uses groq base URL for groq provider', () => {
    const p = resolveProvider('groq/llama-3.3-70b-versatile');
    expect(p.baseUrl).toBe('https://api.groq.com/openai');
    expect(p.type).toBe('openai');
  });

  it('throws on missing slash', () => {
    expect(() => resolveProvider('ollama')).toThrow('Invalid provider shorthand');
  });

  it('throws on missing model', () => {
    expect(() => resolveProvider('ollama/')).toThrow('Missing model');
  });

  it('respects OLLAMA_HOST env var', () => {
    const orig = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = '192.168.1.50:11434';
    try {
      const p = resolveProvider('ollama/qwen3:8b');
      expect(p.baseUrl).toBe('http://192.168.1.50:11434');
    } finally {
      if (orig) process.env.OLLAMA_HOST = orig;
      else delete process.env.OLLAMA_HOST;
    }
  });

  it('respects OLLAMA_HOST with http prefix', () => {
    const orig = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = 'http://myhost:11434';
    try {
      const p = resolveProvider('ollama/qwen3:8b');
      expect(p.baseUrl).toBe('http://myhost:11434');
    } finally {
      if (orig) process.env.OLLAMA_HOST = orig;
      else delete process.env.OLLAMA_HOST;
    }
  });
});

describe('getToolCallArgs', () => {
  it('parses string arguments', () => {
    const tc = { function: { name: 'test', arguments: '{"key":"value"}' } };
    expect(getToolCallArgs(tc)).toEqual({ key: 'value' });
  });

  it('passes through object arguments', () => {
    const tc = { function: { name: 'test', arguments: { key: 'value' } } };
    expect(getToolCallArgs(tc)).toEqual({ key: 'value' });
  });

  it('returns empty object for invalid JSON', () => {
    const tc = { function: { name: 'test', arguments: 'not json' } };
    expect(getToolCallArgs(tc)).toEqual({});
  });
});
