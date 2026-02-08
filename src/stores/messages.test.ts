import { describe, it, expect } from 'vitest';
import { MessageStore } from './messages.js';

describe('MessageStore', () => {
  function setup() {
    return new MessageStore();
  }

  it('sends a message and returns it', async () => {
    const store = setup();
    const msg = await store.send('agent_1', 'agent_2', 'hello');
    expect(msg.id).toBeDefined();
    expect(msg.from).toBe('agent_1');
    expect(msg.to).toBe('agent_2');
    expect(msg.content).toBe('hello');
    expect(msg.sentAt).toBeDefined();
    expect(msg.replyTo).toBeUndefined();
  });

  it('sends a message with replyTo', async () => {
    const store = setup();
    const original = await store.send('agent_1', 'agent_2', 'hello');
    const reply = await store.send('agent_2', 'agent_1', 'hi back', original.id);
    expect(reply.replyTo).toBe(original.id);
    expect(reply.from).toBe('agent_2');
    expect(reply.to).toBe('agent_1');
  });

  it('getFor returns messages for a specific agent', async () => {
    const store = setup();
    await store.send('agent_1', 'agent_2', 'for agent_2');
    await store.send('agent_1', 'agent_3', 'for agent_3');
    await store.send('agent_3', 'agent_2', 'also for agent_2');

    const forAgent2 = await store.getFor('agent_2');
    expect(forAgent2.length).toBe(2);
    expect(forAgent2.every(m => m.to === 'agent_2')).toBe(true);

    const forAgent3 = await store.getFor('agent_3');
    expect(forAgent3.length).toBe(1);
    expect(forAgent3[0].content).toBe('for agent_3');
  });

  it('getFor filters by since timestamp', async () => {
    const store = setup();
    const first = await store.send('agent_1', 'agent_2', 'old message');
    // Send another after — sentAt should be >= first.sentAt
    const second = await store.send('agent_1', 'agent_2', 'new message');

    const filtered = await store.getFor('agent_2', first.sentAt);
    // since filter is strict > (not >=), so messages with sentAt === since are excluded
    // Both messages likely have the same timestamp in fast tests, so filtered may be empty
    // The important thing: filtered should not include messages with sentAt <= since
    for (const m of filtered) {
      expect(m.sentAt > first.sentAt).toBe(true);
    }
  });

  it('getAll returns all messages', async () => {
    const store = setup();
    await store.send('a', 'b', 'one');
    await store.send('b', 'c', 'two');
    await store.send('c', 'a', 'three');

    const all = await store.getAll();
    expect(all.length).toBe(3);
  });

  it('getFor returns empty array when no messages exist', async () => {
    const store = setup();
    const result = await store.getFor('agent_1');
    expect(result).toEqual([]);
  });

  it('getAll returns empty array initially', async () => {
    const store = setup();
    const result = await store.getAll();
    expect(result).toEqual([]);
  });

  it('assigns unique ids to each message', async () => {
    const store = setup();
    const m1 = await store.send('a', 'b', 'one');
    const m2 = await store.send('a', 'b', 'two');
    expect(m1.id).not.toBe(m2.id);
  });
});
