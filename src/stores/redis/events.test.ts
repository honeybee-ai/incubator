import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getRedisClient, waitForReady, type Redis } from './db.js';
import { RedisEventStore } from './events.js';

let client: Redis;
let available = false;

try {
  client = getRedisClient('redis://localhost:6379');
  await waitForReady(client);
  available = true;
} catch {
  // Redis not available — tests will be skipped
}

describe.skipIf(!available)('RedisEventStore', () => {
  const ns = `test-events-${Date.now()}`;

  beforeEach(async () => {
    const store = new RedisEventStore(client, ns);
    await store.load([], 0);
  });

  afterAll(async () => {
    await client.del(`incubator:${ns}:events`, `incubator:${ns}:cursor`);
  });

  it('publishes events with monotonic IDs', async () => {
    const store = new RedisEventStore(client, ns);
    const e1 = await store.publish('test', { msg: 'hello' }, 'agent_1');
    const e2 = await store.publish('test', { msg: 'world' }, 'agent_2');
    expect(e1.id).toBe(1);
    expect(e2.id).toBe(2);
    expect(e1.publishedBy).toBe('agent_1');
  });

  it('gets all events', async () => {
    const store = new RedisEventStore(client, ns);
    await store.publish('a', {}, 'agent_1');
    await store.publish('b', {}, 'agent_1');
    const result = await store.getEvents();
    expect(result.events.length).toBe(2);
    expect(result.cursor).toBe(2);
  });

  it('gets events since cursor', async () => {
    const store = new RedisEventStore(client, ns);
    await store.publish('a', {}, 'agent_1');
    await store.publish('b', {}, 'agent_1');
    await store.publish('c', {}, 'agent_1');
    const result = await store.getEvents(1);
    expect(result.events.length).toBe(2);
    expect(result.events[0].type).toBe('b');
  });

  it('filters by type', async () => {
    const store = new RedisEventStore(client, ns);
    await store.publish('conflict', {}, 'agent_1');
    await store.publish('completed', {}, 'agent_1');
    await store.publish('conflict', {}, 'agent_2');
    const result = await store.getEvents(undefined, 'conflict');
    expect(result.events.length).toBe(2);
  });

  it('combines since and type filters', async () => {
    const store = new RedisEventStore(client, ns);
    await store.publish('conflict', { n: 1 }, 'agent_1');
    await store.publish('completed', { n: 2 }, 'agent_1');
    await store.publish('conflict', { n: 3 }, 'agent_2');
    const result = await store.getEvents(1, 'conflict');
    expect(result.events.length).toBe(1);
    expect(result.events[0].data).toEqual({ n: 3 });
  });

  it('getCursor returns current cursor', async () => {
    const store = new RedisEventStore(client, ns);
    expect(await store.getCursor()).toBe(0);
    await store.publish('a', {}, 'agent_1');
    expect(await store.getCursor()).toBe(1);
  });

  it('getAll returns all events', async () => {
    const store = new RedisEventStore(client, ns);
    await store.publish('a', {}, 'agent_1');
    await store.publish('b', {}, 'agent_1');
    const all = await store.getAll();
    expect(all.length).toBe(2);
  });

  it('load replaces all events and cursor', async () => {
    const store = new RedisEventStore(client, ns);
    await store.publish('old', {}, 'agent_1');

    await store.load([
      { id: 1, type: 'new', data: { x: 1 }, publishedBy: 'a', publishedAt: new Date().toISOString() },
      { id: 2, type: 'new', data: { x: 2 }, publishedBy: 'a', publishedAt: new Date().toISOString() },
    ], 5);

    const all = await store.getAll();
    expect(all.length).toBe(2);
    expect(await store.getCursor()).toBe(5);
  });
});
