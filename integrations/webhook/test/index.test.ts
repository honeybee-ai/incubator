import { describe, it, expect, vi, beforeEach } from 'vitest';
import createWebhookIntegration from '../src/index.js';
import type { IntegrationContext, IntegrationEvent } from '@honeybee-ai/integration-sdk';

function createCtx(config: Record<string, string> = {}): IntegrationContext {
  return {
    namespace: 'default',
    config,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    publishEvent: vi.fn(),
  };
}

function createEvent(type = 'test.event', data: unknown = { key: 'value' }): IntegrationEvent {
  return {
    type,
    data,
    agentId: 'agent_1',
    namespace: 'default',
    timestamp: Date.now(),
  };
}

describe('webhook integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates an integration with correct name', () => {
    const integration = createWebhookIntegration();
    expect(integration.name).toBe('webhook');
    expect(typeof integration.start).toBe('function');
    expect(typeof integration.stop).toBe('function');
    expect(typeof integration.onEvent).toBe('function');
  });

  it('throws if WEBHOOK_URL is missing', async () => {
    const integration = createWebhookIntegration();
    const ctx = createCtx({});
    await expect(integration.start(ctx)).rejects.toThrow('WEBHOOK_URL config is required');
  });

  it('starts successfully with WEBHOOK_URL', async () => {
    const integration = createWebhookIntegration();
    const ctx = createCtx({ WEBHOOK_URL: 'https://example.com/hook' });
    await integration.start(ctx);
    expect(ctx.logger.info).toHaveBeenCalledWith('Webhook endpoint: https://example.com/hook');
  });

  it('sends event to webhook URL', async () => {
    const integration = createWebhookIntegration();
    const ctx = createCtx({ WEBHOOK_URL: 'https://example.com/hook' });
    await integration.start(ctx);

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', mockFetch);

    await integration.onEvent!(createEvent());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers['X-Honeybee-Event']).toBe('test.event');

    const body = JSON.parse(opts.body);
    expect(body.type).toBe('test.event');
    expect(body.data).toEqual({ key: 'value' });
    expect(body.agent_id).toBe('agent_1');
  });

  it('adds HMAC signature when WEBHOOK_SECRET is set', async () => {
    const integration = createWebhookIntegration();
    const ctx = createCtx({
      WEBHOOK_URL: 'https://example.com/hook',
      WEBHOOK_SECRET: 'mysecret',
    });
    await integration.start(ctx);

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', mockFetch);

    await integration.onEvent!(createEvent());

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['X-Honeybee-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('filters events by EVENT_TYPES', async () => {
    const integration = createWebhookIntegration();
    const ctx = createCtx({
      WEBHOOK_URL: 'https://example.com/hook',
      EVENT_TYPES: 'claim.created,state.updated',
    });
    await integration.start(ctx);

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', mockFetch);

    // Filtered out
    await integration.onEvent!(createEvent('other.event'));
    expect(mockFetch).not.toHaveBeenCalled();

    // Passes filter
    await integration.onEvent!(createEvent('claim.created'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('handles fetch errors gracefully', async () => {
    const integration = createWebhookIntegration();
    const ctx = createCtx({ WEBHOOK_URL: 'https://example.com/hook' });
    await integration.start(ctx);

    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));
    vi.stubGlobal('fetch', mockFetch);

    // Should not throw
    await integration.onEvent!(createEvent());
    expect(ctx.logger.error).toHaveBeenCalledWith('Webhook error: network error');
  });

  it('logs warning on non-ok response', async () => {
    const integration = createWebhookIntegration();
    const ctx = createCtx({
      WEBHOOK_URL: 'https://example.com/hook',
      VERBOSE: 'true',
    });
    await integration.start(ctx);

    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });
    vi.stubGlobal('fetch', mockFetch);

    await integration.onEvent!(createEvent());
    expect(ctx.logger.warn).toHaveBeenCalledWith('Webhook returned 500: Server Error');
  });

  it('handles timeout via AbortError', async () => {
    const integration = createWebhookIntegration();
    const ctx = createCtx({
      WEBHOOK_URL: 'https://example.com/hook',
      WEBHOOK_TIMEOUT: '100',
    });
    await integration.start(ctx);

    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const mockFetch = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal('fetch', mockFetch);

    await integration.onEvent!(createEvent());
    expect(ctx.logger.error).toHaveBeenCalledWith('Webhook timeout (100ms)');
  });

  it('stops cleanly', async () => {
    const integration = createWebhookIntegration();
    const ctx = createCtx({ WEBHOOK_URL: 'https://example.com/hook' });
    await integration.start(ctx);
    await integration.stop();
    // No error means success
  });
});
