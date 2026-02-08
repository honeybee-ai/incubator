import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getRedisClient, waitForReady, type Redis } from './db.js';
import { RedisStateStore } from './state.js';

let client: Redis;
let available = false;

try {
  client = getRedisClient('redis://localhost:6379');
  await waitForReady(client);
  available = true;
} catch {
  // Redis not available — tests will be skipped
}

describe.skipIf(!available)('RedisStateStore', () => {
  const ns = `test-state-${Date.now()}`;

  beforeEach(async () => {
    const store = new RedisStateStore(client, ns);
    await store.load([]);
  });

  afterAll(async () => {
    await client.del(`incubator:${ns}:state`);
  });

  it('sets and gets values', async () => {
    const store = new RedisStateStore(client, ns);
    await store.set('key1', 'value1', 'agent_1');
    const entry = await store.get('key1');
    expect(entry).not.toBeNull();
    expect(entry!.value).toBe('value1');
    expect(entry!.setBy).toBe('agent_1');
  });

  it('returns null for missing keys', async () => {
    const store = new RedisStateStore(client, ns);
    expect(await store.get('missing')).toBeNull();
  });

  it('overwrites with last-writer-wins', async () => {
    const store = new RedisStateStore(client, ns);
    await store.set('key1', 'v1', 'agent_1');
    await store.set('key1', 'v2', 'agent_2');
    const entry = await store.get('key1');
    expect(entry!.value).toBe('v2');
    expect(entry!.setBy).toBe('agent_2');
  });

  it('preserves original setAt on update', async () => {
    const store = new RedisStateStore(client, ns);
    await store.set('key1', 'v1', 'agent_1');
    const original = (await store.get('key1'))!.setAt;
    await store.set('key1', 'v2', 'agent_2');
    expect((await store.get('key1'))!.setAt).toBe(original);
  });

  it('deletes values', async () => {
    const store = new RedisStateStore(client, ns);
    await store.set('key1', 'v1', 'agent_1');
    expect(await store.delete('key1')).toBe(true);
    expect(await store.get('key1')).toBeNull();
    expect(await store.delete('key1')).toBe(false);
  });

  it('queries by pattern', async () => {
    const store = new RedisStateStore(client, ns);
    await store.set('agent_1.status', 'running', 'agent_1');
    await store.set('agent_2.status', 'idle', 'agent_2');
    await store.set('config.timeout', 5000, 'agent_1');
    const results = await store.query('agent_*');
    expect(results.length).toBe(2);
  });

  it('queries by category', async () => {
    const store = new RedisStateStore(client, ns);
    await store.set('k1', 'v1', 'a', 'config');
    await store.set('k2', 'v2', 'a', 'progress');
    await store.set('k3', 'v3', 'a', 'config');
    const results = await store.query(undefined, 'config');
    expect(results.length).toBe(2);
  });

  it('expires entries with TTL', async () => {
    const store = new RedisStateStore(client, ns);
    await store.set('temp', 'value', 'agent_1', undefined, 1);
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    expect(await store.get('temp')).toBeNull();
  });

  it('getAll returns all non-expired entries', async () => {
    const store = new RedisStateStore(client, ns);
    await store.set('a', 1, 'agent_1');
    await store.set('b', 2, 'agent_1');
    const all = await store.getAll();
    expect(all.length).toBe(2);
  });

  it('load replaces all entries', async () => {
    const store = new RedisStateStore(client, ns);
    await store.set('old', 'data', 'agent_1');

    await store.load([
      { key: 'new1', value: 'v1', setBy: 'a', setAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { key: 'new2', value: 'v2', setBy: 'a', setAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ]);

    expect(await store.get('old')).toBeNull();
    expect((await store.get('new1'))!.value).toBe('v1');
    expect((await store.get('new2'))!.value).toBe('v2');
  });
});
