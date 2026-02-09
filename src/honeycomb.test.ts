import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TopicRouter } from './honeycomb.js';
import { LocalBus } from './bus.js';
import { createStores } from './server.js';
import type { Stores } from './stores/interfaces.js';
import type { ProtocolSpec } from '@agentcoordinationprotocol/spec';

function makeSpec(topics?: { publishes?: string[]; subscribes?: string[] }): ProtocolSpec {
  return {
    acp: '1.0',
    name: 'test',
    title: 'Test',
    roles: { worker: { description: 'works' } },
    phases: { done: { description: 'done', terminal: true } },
    ...(topics ? { topics } : {}),
  };
}

describe('TopicRouter', () => {
  let bus: LocalBus;
  let storesMap: Map<string, Stores>;
  let router: TopicRouter;

  beforeEach(() => {
    bus = new LocalBus();
    storesMap = new Map();
    const getStores = (ns: string): Stores => {
      let s = storesMap.get(ns);
      if (!s) {
        s = createStores();
        storesMap.set(ns, s);
      }
      return s;
    };
    router = new TopicRouter(getStores, bus);
  });

  // ─── registerProtocol ──────────────────────────────────────

  it('registers published and subscribed topics from spec', () => {
    const spec = makeSpec({ publishes: ['code_changed'], subscribes: ['dep_updated'] });
    router.registerProtocol('frontend', spec);

    const topics = router.getTopics('frontend');
    expect(topics.publishes).toEqual(['code_changed']);
    expect(topics.subscribes).toEqual(['dep_updated']);
  });

  it('idempotent registerProtocol clears previous topics', () => {
    const spec1 = makeSpec({ publishes: ['a'], subscribes: ['b'] });
    router.registerProtocol('ns', spec1);

    const spec2 = makeSpec({ publishes: ['c'] });
    router.registerProtocol('ns', spec2);

    const topics = router.getTopics('ns');
    expect(topics.publishes).toEqual(['c']);
    expect(topics.subscribes).toEqual([]);
  });

  it('handles spec without topics gracefully', () => {
    const spec = makeSpec();
    router.registerProtocol('ns', spec);
    const topics = router.getTopics('ns');
    expect(topics.publishes).toEqual([]);
    expect(topics.subscribes).toEqual([]);
  });

  // ─── Event routing ─────────────────────────────────────────

  it('routes events from publisher to subscriber', async () => {
    // Setup: frontend publishes code_changed, backend subscribes to it
    const frontendSpec = makeSpec({ publishes: ['code_changed'] });
    const backendSpec = makeSpec({ subscribes: ['code_changed'] });

    // Create stores first so installNotifications can work
    const frontendStores = createStores();
    const backendStores = createStores();
    storesMap.set('frontend', frontendStores);
    storesMap.set('backend', backendStores);

    // Wire bus notifications into frontend stores (simulating what NamespaceRegistry does)
    const originalPublish = frontendStores.events.publish.bind(frontendStores.events);
    frontendStores.events.publish = async (type: string, data: unknown, agentId: string) => {
      const event = await originalPublish(type, data, agentId);
      bus.publish('frontend', event);
      return event;
    };

    router.registerProtocol('frontend', frontendSpec);
    router.registerProtocol('backend', backendSpec);

    // Publish event in frontend
    await frontendStores.events.publish('code_changed', { files: ['api.ts'] }, 'agent_fe');

    // Wait for async routing
    await new Promise(r => setTimeout(r, 50));

    // Verify event appears in backend
    const result = await backendStores.events.getEvents();
    expect(result.events.length).toBe(1);
    expect(result.events[0].type).toBe('code_changed');
    expect(result.events[0].publishedBy).toBe('honeycomb:frontend');
    expect((result.events[0].data as Record<string, unknown>)._source).toBe('frontend');
    expect((result.events[0].data as Record<string, unknown>).files).toEqual(['api.ts']);
  });

  it('does not route events for non-published topics', async () => {
    const frontendSpec = makeSpec({ publishes: ['code_changed'] });
    const backendSpec = makeSpec({ subscribes: ['code_changed'] });

    const frontendStores = createStores();
    const backendStores = createStores();
    storesMap.set('frontend', frontendStores);
    storesMap.set('backend', backendStores);

    const originalPublish = frontendStores.events.publish.bind(frontendStores.events);
    frontendStores.events.publish = async (type: string, data: unknown, agentId: string) => {
      const event = await originalPublish(type, data, agentId);
      bus.publish('frontend', event);
      return event;
    };

    router.registerProtocol('frontend', frontendSpec);
    router.registerProtocol('backend', backendSpec);

    // Publish a non-topic event
    await frontendStores.events.publish('internal_only', { detail: 'x' }, 'agent_fe');

    await new Promise(r => setTimeout(r, 50));

    const result = await backendStores.events.getEvents();
    expect(result.events.length).toBe(0);
  });

  it('prevents infinite routing loops', async () => {
    // Both namespaces publish and subscribe to the same topic
    const spec = makeSpec({ publishes: ['ping'], subscribes: ['ping'] });

    const nsA = createStores();
    const nsB = createStores();
    storesMap.set('ns-a', nsA);
    storesMap.set('ns-b', nsB);

    const originalA = nsA.events.publish.bind(nsA.events);
    nsA.events.publish = async (type: string, data: unknown, agentId: string) => {
      const event = await originalA(type, data, agentId);
      bus.publish('ns-a', event);
      return event;
    };

    const originalB = nsB.events.publish.bind(nsB.events);
    nsB.events.publish = async (type: string, data: unknown, agentId: string) => {
      const event = await originalB(type, data, agentId);
      bus.publish('ns-b', event);
      return event;
    };

    router.registerProtocol('ns-a', spec);
    router.registerProtocol('ns-b', spec);

    // Publish from ns-a
    await nsA.events.publish('ping', { msg: 'hello' }, 'agent_a');

    await new Promise(r => setTimeout(r, 100));

    // ns-b should have exactly 1 routed event
    const resultB = await nsB.events.getEvents();
    expect(resultB.events.length).toBe(1);
    expect(resultB.events[0].publishedBy).toBe('honeycomb:ns-a');

    // ns-a should have only its original event (the routed event from ns-b
    // should be skipped because it has honeycomb: prefix)
    const resultA = await nsA.events.getEvents();
    expect(resultA.events.length).toBe(1);
    expect(resultA.events[0].publishedBy).toBe('agent_a');
  });

  it('does not route back to self', async () => {
    const spec = makeSpec({ publishes: ['update'], subscribes: ['update'] });

    const nsStores = createStores();
    storesMap.set('self-ns', nsStores);

    const originalPublish = nsStores.events.publish.bind(nsStores.events);
    nsStores.events.publish = async (type: string, data: unknown, agentId: string) => {
      const event = await originalPublish(type, data, agentId);
      bus.publish('self-ns', event);
      return event;
    };

    router.registerProtocol('self-ns', spec);

    await nsStores.events.publish('update', { x: 1 }, 'agent');

    await new Promise(r => setTimeout(r, 50));

    // Should only have the original event, no self-routed copy
    const result = await nsStores.events.getEvents();
    expect(result.events.length).toBe(1);
    expect(result.events[0].publishedBy).toBe('agent');
  });

  // ─── Runtime management ────────────────────────────────────

  it('runtime subscribe/unsubscribe', () => {
    router.subscribe('ns', 'my_topic');
    expect(router.getTopics('ns').subscribes).toContain('my_topic');
    expect(router.getSubscribersForTopic('my_topic')).toContain('ns');

    router.unsubscribe('ns', 'my_topic');
    expect(router.getTopics('ns').subscribes).not.toContain('my_topic');
    expect(router.getSubscribersForTopic('my_topic')).toEqual([]);
  });

  it('runtime publish/unpublish', () => {
    router.publish('ns', 'my_topic');
    expect(router.getTopics('ns').publishes).toContain('my_topic');

    router.unpublish('ns', 'my_topic');
    expect(router.getTopics('ns').publishes).not.toContain('my_topic');
  });

  // ─── Cleanup ───────────────────────────────────────────────

  it('clearNamespace removes all registrations', () => {
    const spec = makeSpec({ publishes: ['a'], subscribes: ['b'] });
    router.registerProtocol('ns', spec);

    expect(router.getTopics('ns').publishes).toEqual(['a']);
    expect(router.getSubscribersForTopic('b')).toEqual(['ns']);

    router.clearNamespace('ns');

    expect(router.getTopics('ns').publishes).toEqual([]);
    expect(router.getTopics('ns').subscribes).toEqual([]);
    expect(router.getSubscribersForTopic('b')).toEqual([]);
  });

  it('clearNamespace is safe when namespace has no registrations', () => {
    // Should not throw
    router.clearNamespace('nonexistent');
    expect(router.getTopics('nonexistent').publishes).toEqual([]);
  });

  // ─── Query ─────────────────────────────────────────────────

  it('getSubscribersForTopic returns all subscribers', () => {
    router.subscribe('ns-a', 'topic1');
    router.subscribe('ns-b', 'topic1');
    router.subscribe('ns-c', 'topic2');

    const subs = router.getSubscribersForTopic('topic1');
    expect(subs).toContain('ns-a');
    expect(subs).toContain('ns-b');
    expect(subs).not.toContain('ns-c');
  });

  it('getTopics returns empty for unknown namespace', () => {
    const topics = router.getTopics('unknown');
    expect(topics).toEqual({ publishes: [], subscribes: [] });
  });
});
