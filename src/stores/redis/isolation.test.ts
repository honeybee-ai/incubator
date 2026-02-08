import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getRedisClient, waitForReady, type Redis } from './db.js';
import { RedisStateStore } from './state.js';
import { RedisEventStore } from './events.js';
import { RedisClaimStore } from './claims.js';
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

describe.skipIf(!available)('Redis namespace isolation', () => {
  const nsA = `test-iso-a-${Date.now()}`;
  const nsB = `test-iso-b-${Date.now()}`;

  beforeEach(async () => {
    // Clean both namespaces
    for (const ns of [nsA, nsB]) {
      await client.del(
        `incubator:${ns}:state`,
        `incubator:${ns}:events`,
        `incubator:${ns}:cursor`,
        `incubator:${ns}:claims`,
        `incubator:${ns}:discoveries`,
      );
    }
  });

  afterAll(async () => {
    for (const ns of [nsA, nsB]) {
      await client.del(
        `incubator:${ns}:state`,
        `incubator:${ns}:events`,
        `incubator:${ns}:cursor`,
        `incubator:${ns}:claims`,
        `incubator:${ns}:discoveries`,
      );
    }
  });

  it('state: namespaces are isolated', async () => {
    const stateA = new RedisStateStore(client, nsA);
    const stateB = new RedisStateStore(client, nsB);

    await stateA.set('key', 'value-a', 'agent_1');
    await stateB.set('key', 'value-b', 'agent_2');

    expect((await stateA.get('key'))!.value).toBe('value-a');
    expect((await stateB.get('key'))!.value).toBe('value-b');

    await stateA.delete('key');
    expect(await stateA.get('key')).toBeNull();
    expect((await stateB.get('key'))!.value).toBe('value-b');
  });

  it('events: namespaces are isolated', async () => {
    const eventsA = new RedisEventStore(client, nsA);
    const eventsB = new RedisEventStore(client, nsB);

    await eventsA.publish('type-a', { ns: 'a' }, 'agent_1');
    await eventsA.publish('type-a', { ns: 'a' }, 'agent_1');
    await eventsB.publish('type-b', { ns: 'b' }, 'agent_2');

    expect((await eventsA.getEvents()).events.length).toBe(2);
    expect((await eventsB.getEvents()).events.length).toBe(1);
    expect(await eventsA.getCursor()).toBe(2);
    expect(await eventsB.getCursor()).toBe(1);
  });

  it('claims: namespaces are isolated', async () => {
    const eventsA = new RedisEventStore(client, nsA);
    const eventsB = new RedisEventStore(client, nsB);
    const claimsA = new RedisClaimStore(client, nsA, eventsA);
    const claimsB = new RedisClaimStore(client, nsB, eventsB);

    const resultA = await claimsA.claim('file.ts', 'editing', 'agent_1');
    expect(resultA.status).toBe('approved');

    const resultB = await claimsB.claim('file.ts', 'editing', 'agent_2');
    expect(resultB.status).toBe('approved');

    expect((await claimsA.list()).length).toBe(1);
    expect((await claimsB.list()).length).toBe(1);
  });

  it('discoveries: namespaces are isolated', async () => {
    const eventsA = new RedisEventStore(client, nsA);
    const eventsB = new RedisEventStore(client, nsB);
    const discoveriesA = new RedisDiscoveryStore(client, nsA, eventsA);
    const discoveriesB = new RedisDiscoveryStore(client, nsB, eventsB);

    await discoveriesA.publish('topic-a', 'content-a', 'agent_1');
    await discoveriesA.publish('topic-a2', 'content-a2', 'agent_1');
    await discoveriesB.publish('topic-b', 'content-b', 'agent_2');

    expect((await discoveriesA.search()).length).toBe(2);
    expect((await discoveriesB.search()).length).toBe(1);
  });

  it('load does not affect other namespaces', async () => {
    const stateA = new RedisStateStore(client, nsA);
    const stateB = new RedisStateStore(client, nsB);

    await stateA.set('a-key', 'a-val', 'agent_1');
    await stateB.set('b-key', 'b-val', 'agent_2');

    await stateA.load([
      { key: 'new-a', value: 'new-val', setBy: 'a', setAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ]);

    expect(await stateA.get('a-key')).toBeNull();
    expect((await stateA.get('new-a'))!.value).toBe('new-val');
    expect((await stateB.get('b-key'))!.value).toBe('b-val');
  });
});
