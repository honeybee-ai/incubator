import { describe, it, expect, afterAll } from 'vitest';
import { getRedisClient, waitForReady, type Redis } from './db.js';
import { RedisBus } from '../../bus.js';
import type { IncubatorEvent } from '../../types.js';

let pubClient: Redis;
let available = false;

try {
  pubClient = getRedisClient('redis://localhost:6379');
  await waitForReady(pubClient);
  available = true;
} catch {
  // Redis not available — tests will be skipped
}

function makeEvent(id: number, type = 'test'): IncubatorEvent {
  return { id, type, data: { n: id }, publishedBy: 'agent', publishedAt: new Date().toISOString() };
}

describe.skipIf(!available)('RedisBus', () => {
  const buses: RedisBus[] = [];

  function createBus(): RedisBus {
    const subClient = pubClient.duplicate();
    const bus = new RedisBus(pubClient, subClient);
    buses.push(bus);
    return bus;
  }

  afterAll(async () => {
    for (const bus of buses) {
      await bus.close();
    }
  });

  it('delivers events to subscriber', async () => {
    const bus = createBus();
    const received: IncubatorEvent[] = [];

    bus.subscribe('test-deliver', (e) => received.push(e));
    // Small delay for Redis subscribe to propagate
    await new Promise(r => setTimeout(r, 100));

    bus.publish('test-deliver', makeEvent(1));
    await new Promise(r => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(1);
  });

  it('isolates namespaces', async () => {
    const bus = createBus();
    const ns1: IncubatorEvent[] = [];
    const ns2: IncubatorEvent[] = [];

    bus.subscribe('test-iso-1', (e) => ns1.push(e));
    bus.subscribe('test-iso-2', (e) => ns2.push(e));
    await new Promise(r => setTimeout(r, 100));

    bus.publish('test-iso-1', makeEvent(1));
    bus.publish('test-iso-2', makeEvent(2));
    await new Promise(r => setTimeout(r, 100));

    expect(ns1).toHaveLength(1);
    expect(ns1[0].id).toBe(1);
    expect(ns2).toHaveLength(1);
    expect(ns2[0].id).toBe(2);
  });

  it('delivers events cross-bus (cross-process simulation)', async () => {
    const bus1 = createBus();
    const bus2 = createBus();
    const received: IncubatorEvent[] = [];

    bus2.subscribe('test-cross', (e) => received.push(e));
    await new Promise(r => setTimeout(r, 100));

    bus1.publish('test-cross', makeEvent(42));
    await new Promise(r => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(42);
  });

  it('unsubscribe stops delivery', async () => {
    const bus = createBus();
    const received: IncubatorEvent[] = [];

    const unsub = bus.subscribe('test-unsub', (e) => received.push(e));
    await new Promise(r => setTimeout(r, 100));

    bus.publish('test-unsub', makeEvent(1));
    await new Promise(r => setTimeout(r, 100));
    expect(received).toHaveLength(1);

    unsub();
    await new Promise(r => setTimeout(r, 100));

    bus.publish('test-unsub', makeEvent(2));
    await new Promise(r => setTimeout(r, 100));
    expect(received).toHaveLength(1);
  });
});
