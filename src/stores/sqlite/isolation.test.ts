import { describe, it, expect } from 'vitest';
import { getDatabase } from './db.js';
import { SqliteStateStore } from './state.js';
import { SqliteEventStore } from './events.js';
import { SqliteClaimStore } from './claims.js';
import { SqliteDiscoveryStore } from './discoveries.js';

describe('SQLite namespace isolation', () => {
  function setup() {
    const db = getDatabase(':memory:');

    const eventsA = new SqliteEventStore(db, 'ns-a');
    const eventsB = new SqliteEventStore(db, 'ns-b');

    return {
      stateA: new SqliteStateStore(db, 'ns-a'),
      stateB: new SqliteStateStore(db, 'ns-b'),
      eventsA,
      eventsB,
      claimsA: new SqliteClaimStore(db, 'ns-a', eventsA),
      claimsB: new SqliteClaimStore(db, 'ns-b', eventsB),
      discoveriesA: new SqliteDiscoveryStore(db, 'ns-a', eventsA),
      discoveriesB: new SqliteDiscoveryStore(db, 'ns-b', eventsB),
    };
  }

  it('state: namespaces are isolated', async () => {
    const { stateA, stateB } = setup();

    await stateA.set('key', 'value-a', 'agent_1');
    await stateB.set('key', 'value-b', 'agent_2');

    expect((await stateA.get('key'))!.value).toBe('value-a');
    expect((await stateB.get('key'))!.value).toBe('value-b');

    await stateA.delete('key');
    expect(await stateA.get('key')).toBeNull();
    expect((await stateB.get('key'))!.value).toBe('value-b');
  });

  it('events: namespaces are isolated', async () => {
    const { eventsA, eventsB } = setup();

    await eventsA.publish('type-a', { ns: 'a' }, 'agent_1');
    await eventsA.publish('type-a', { ns: 'a' }, 'agent_1');
    await eventsB.publish('type-b', { ns: 'b' }, 'agent_2');

    expect((await eventsA.getEvents()).events.length).toBe(2);
    expect((await eventsB.getEvents()).events.length).toBe(1);
    expect(await eventsA.getCursor()).toBe(2);
    expect(await eventsB.getCursor()).toBe(1);
  });

  it('claims: namespaces are isolated', async () => {
    const { claimsA, claimsB } = setup();

    const resultA = await claimsA.claim('file.ts', 'editing', 'agent_1');
    expect(resultA.status).toBe('approved');

    // Same resource in different namespace should also be approved
    const resultB = await claimsB.claim('file.ts', 'editing', 'agent_2');
    expect(resultB.status).toBe('approved');

    expect((await claimsA.list()).length).toBe(1);
    expect((await claimsB.list()).length).toBe(1);
  });

  it('discoveries: namespaces are isolated', async () => {
    const { discoveriesA, discoveriesB } = setup();

    await discoveriesA.publish('topic-a', 'content-a', 'agent_1');
    await discoveriesA.publish('topic-a2', 'content-a2', 'agent_1');
    await discoveriesB.publish('topic-b', 'content-b', 'agent_2');

    expect((await discoveriesA.search()).length).toBe(2);
    expect((await discoveriesB.search()).length).toBe(1);
  });

  it('load does not affect other namespaces', async () => {
    const { stateA, stateB } = setup();

    await stateA.set('a-key', 'a-val', 'agent_1');
    await stateB.set('b-key', 'b-val', 'agent_2');

    // Load into namespace A should not affect namespace B
    await stateA.load([
      { key: 'new-a', value: 'new-val', setBy: 'a', setAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ]);

    expect(await stateA.get('a-key')).toBeNull();
    expect((await stateA.get('new-a'))!.value).toBe('new-val');
    expect((await stateB.get('b-key'))!.value).toBe('b-val');
  });
});
