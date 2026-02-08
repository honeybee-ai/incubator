import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getRedisClient, waitForReady, type Redis } from './db.js';
import { RedisEventStore } from './events.js';
import { RedisDiscoveryStore } from './discoveries.js';

let client: Redis;
let available = false;

try {
  client = getRedisClient('redis://localhost:6379');
  await waitForReady(client);
  available = true;
} catch {
  // Redis not available — tests will be skipped
}

describe.skipIf(!available)('RedisDiscoveryStore', () => {
  const ns = `test-discoveries-${Date.now()}`;

  beforeEach(async () => {
    const events = new RedisEventStore(client, ns);
    const discoveries = new RedisDiscoveryStore(client, ns, events);
    await events.load([], 0);
    await discoveries.load([]);
  });

  afterAll(async () => {
    await client.del(
      `incubator:${ns}:discoveries`,
      `incubator:${ns}:events`,
      `incubator:${ns}:cursor`,
    );
  });

  function setup() {
    const events = new RedisEventStore(client, ns);
    const discoveries = new RedisDiscoveryStore(client, ns, events);
    return { events, discoveries };
  }

  it('publishes discoveries', async () => {
    const { discoveries } = setup();
    const d = await discoveries.publish('naming convention', 'Use camelCase for variables', 'agent_1', 'naming');
    expect(d.topic).toBe('naming convention');
    expect(d.content).toBe('Use camelCase for variables');
    expect(d.category).toBe('naming');
    expect(d.publishedBy).toBe('agent_1');
  });

  it('searches by query text', async () => {
    const { discoveries } = setup();
    await discoveries.publish('naming', 'Use camelCase', 'agent_1');
    await discoveries.publish('pattern', 'Singleton pattern found', 'agent_2');
    await discoveries.publish('gotcha', 'Variable x is global camelCase', 'agent_1');

    const results = await discoveries.search('camelCase');
    expect(results.length).toBe(2);
  });

  it('searches case-insensitively', async () => {
    const { discoveries } = setup();
    await discoveries.publish('Naming', 'Use CamelCase', 'agent_1');
    const results = await discoveries.search('camelcase');
    expect(results.length).toBe(1);
  });

  it('filters by category', async () => {
    const { discoveries } = setup();
    await discoveries.publish('a', 'content a', 'agent_1', 'naming');
    await discoveries.publish('b', 'content b', 'agent_1', 'pattern');
    await discoveries.publish('c', 'content c', 'agent_1', 'naming');

    const results = await discoveries.search(undefined, 'naming');
    expect(results.length).toBe(2);
  });

  it('combines query and category', async () => {
    const { discoveries } = setup();
    await discoveries.publish('foo', 'uses camelCase', 'agent_1', 'naming');
    await discoveries.publish('bar', 'uses camelCase', 'agent_1', 'pattern');
    await discoveries.publish('baz', 'uses snake_case', 'agent_1', 'naming');

    const results = await discoveries.search('camelCase', 'naming');
    expect(results.length).toBe(1);
    expect(results[0].topic).toBe('foo');
  });

  it('returns all when no filters', async () => {
    const { discoveries } = setup();
    await discoveries.publish('a', 'x', 'agent_1');
    await discoveries.publish('b', 'y', 'agent_1');
    const results = await discoveries.search();
    expect(results.length).toBe(2);
  });

  it('publishes event on discovery', async () => {
    const { events, discoveries } = setup();
    await discoveries.publish('naming', 'camelCase', 'agent_1', 'naming');
    const { events: evts } = await events.getEvents();
    expect(evts.some(e => e.type === 'discovery.published')).toBe(true);
  });

  it('getAll returns all discoveries', async () => {
    const { discoveries } = setup();
    await discoveries.publish('a', 'x', 'agent_1');
    await discoveries.publish('b', 'y', 'agent_1');
    const all = await discoveries.getAll();
    expect(all.length).toBe(2);
  });

  it('load replaces all discoveries', async () => {
    const { discoveries } = setup();
    await discoveries.publish('old', 'data', 'agent_1');

    await discoveries.load([
      { id: '1', topic: 'new1', content: 'c1', publishedBy: 'a', publishedAt: new Date().toISOString() },
      { id: '2', topic: 'new2', content: 'c2', publishedBy: 'a', publishedAt: new Date().toISOString() },
    ]);

    const all = await discoveries.getAll();
    expect(all.length).toBe(2);
    expect(all[0].topic).toBe('new1');
  });
});
