import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebhookManager } from './webhooks.js';
import type { IncubatorEvent } from './types.js';
import { createHmac } from 'node:crypto';

// Track fetch calls
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls.length = 0;
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: url.toString(), init: init ?? {} });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function makeBus() {
  const listeners = new Map<string, Set<(event: IncubatorEvent) => void>>();
  return {
    publish(namespace: string, event: IncubatorEvent) {
      const set = listeners.get(namespace);
      if (set) for (const fn of set) fn(event);
    },
    subscribe(namespace: string, listener: (event: IncubatorEvent) => void) {
      if (!listeners.has(namespace)) listeners.set(namespace, new Set());
      listeners.get(namespace)!.add(listener);
      return () => { listeners.get(namespace)?.delete(listener); };
    },
    close: async () => {},
  };
}

function makeEvent(type: string, data: unknown = {}): IncubatorEvent {
  return {
    id: 1,
    type,
    data,
    publishedBy: 'agent-1',
    publishedAt: new Date().toISOString(),
  };
}

describe('WebhookManager', () => {
  it('fires webhook on matching event', async () => {
    const bus = makeBus();
    const manager = new WebhookManager();

    manager.register('default', [
      { url: 'https://example.com/hook', events: ['task.complete'] },
    ], bus);

    bus.publish('default', makeEvent('task.complete', { task: 'build' }));

    // Wait for async fire
    await new Promise(r => setTimeout(r, 50));

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://example.com/hook');
    const body = JSON.parse(fetchCalls[0].init.body as string);
    expect(body.event).toBe('task.complete');
    expect(body.data.task).toBe('build');

    manager.close();
  });

  it('skips non-matching event types', async () => {
    const bus = makeBus();
    const manager = new WebhookManager();

    manager.register('default', [
      { url: 'https://example.com/hook', events: ['task.complete'] },
    ], bus);

    bus.publish('default', makeEvent('task.started'));

    await new Promise(r => setTimeout(r, 50));

    expect(fetchCalls).toHaveLength(0);

    manager.close();
  });

  it('fires on all events when no filter specified', async () => {
    const bus = makeBus();
    const manager = new WebhookManager();

    manager.register('default', [
      { url: 'https://example.com/hook' }, // no events filter
    ], bus);

    bus.publish('default', makeEvent('anything.goes'));

    await new Promise(r => setTimeout(r, 50));

    expect(fetchCalls).toHaveLength(1);

    manager.close();
  });

  it('includes HMAC-SHA256 signature when secret provided', async () => {
    const bus = makeBus();
    const manager = new WebhookManager();
    const secret = 'my-webhook-secret';

    manager.register('default', [
      { url: 'https://example.com/hook', secret },
    ], bus);

    bus.publish('default', makeEvent('test.event', { foo: 'bar' }));

    await new Promise(r => setTimeout(r, 50));

    expect(fetchCalls).toHaveLength(1);
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers['X-Webhook-Signature']).toBeDefined();

    // Verify HMAC matches
    const body = fetchCalls[0].init.body as string;
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    expect(headers['X-Webhook-Signature']).toBe(expected);

    manager.close();
  });

  it('failure does not throw (fire-and-forget)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as typeof fetch;

    const bus = makeBus();
    const manager = new WebhookManager();

    manager.register('default', [
      { url: 'https://example.com/hook' },
    ], bus);

    // Should not throw
    bus.publish('default', makeEvent('test.event'));
    await new Promise(r => setTimeout(r, 50));

    manager.close();
  });

  it('close unsubscribes from bus', async () => {
    const bus = makeBus();
    const manager = new WebhookManager();

    manager.register('default', [
      { url: 'https://example.com/hook' },
    ], bus);

    manager.close();

    bus.publish('default', makeEvent('test.event'));
    await new Promise(r => setTimeout(r, 50));

    expect(fetchCalls).toHaveLength(0);
  });

  it('includes custom headers', async () => {
    const bus = makeBus();
    const manager = new WebhookManager();

    manager.register('default', [
      { url: 'https://example.com/hook', headers: { 'X-Custom': 'test-value' } },
    ], bus);

    bus.publish('default', makeEvent('test.event'));
    await new Promise(r => setTimeout(r, 50));

    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers['X-Custom']).toBe('test-value');

    manager.close();
  });
});
