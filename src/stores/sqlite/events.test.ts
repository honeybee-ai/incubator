import { describe, it, expect } from 'vitest';
import { getDatabase } from './db.js';
import { SqliteEventStore } from './events.js';

describe('SqliteEventStore', () => {
  function setup() {
    const db = getDatabase(':memory:');
    return new SqliteEventStore(db, 'test');
  }

  it('publishes events with monotonic IDs', async () => {
    const store = setup();
    const e1 = await store.publish('test', { msg: 'hello' }, 'agent_1');
    const e2 = await store.publish('test', { msg: 'world' }, 'agent_2');
    expect(e1.id).toBe(1);
    expect(e2.id).toBe(2);
    expect(e1.publishedBy).toBe('agent_1');
  });

  it('gets all events', async () => {
    const store = setup();
    await store.publish('a', {}, 'agent_1');
    await store.publish('b', {}, 'agent_1');
    const result = await store.getEvents();
    expect(result.events.length).toBe(2);
    expect(result.cursor).toBe(2);
  });

  it('gets events since cursor', async () => {
    const store = setup();
    await store.publish('a', {}, 'agent_1');
    await store.publish('b', {}, 'agent_1');
    await store.publish('c', {}, 'agent_1');
    const result = await store.getEvents(1);
    expect(result.events.length).toBe(2);
    expect(result.events[0].type).toBe('b');
  });

  it('filters by type', async () => {
    const store = setup();
    await store.publish('conflict', {}, 'agent_1');
    await store.publish('completed', {}, 'agent_1');
    await store.publish('conflict', {}, 'agent_2');
    const result = await store.getEvents(undefined, 'conflict');
    expect(result.events.length).toBe(2);
  });

  it('combines since and type filters', async () => {
    const store = setup();
    await store.publish('conflict', { n: 1 }, 'agent_1');
    await store.publish('completed', { n: 2 }, 'agent_1');
    await store.publish('conflict', { n: 3 }, 'agent_2');
    const result = await store.getEvents(1, 'conflict');
    expect(result.events.length).toBe(1);
    expect(result.events[0].data).toEqual({ n: 3 });
  });

  it('getCursor returns current cursor', async () => {
    const store = setup();
    expect(await store.getCursor()).toBe(0);
    await store.publish('a', {}, 'agent_1');
    expect(await store.getCursor()).toBe(1);
  });

  it('getAll returns all events', async () => {
    const store = setup();
    await store.publish('a', {}, 'agent_1');
    await store.publish('b', {}, 'agent_1');
    const all = await store.getAll();
    expect(all.length).toBe(2);
  });

  it('load replaces all events and cursor', async () => {
    const store = setup();
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
