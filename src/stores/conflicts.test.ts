import { describe, it, expect } from 'vitest';
import { ConflictStore } from './conflicts.js';
import { EventStore } from './events.js';

describe('ConflictStore', () => {
  function setup() {
    const events = new EventStore();
    const conflicts = new ConflictStore(events);
    return { events, conflicts };
  }

  it('flags a conflict', async () => {
    const { conflicts } = setup();
    const conflict = await conflicts.flag('agent_1', 'data says X', 'data says Y', 'contradictory findings');
    expect(conflict.id).toBeDefined();
    expect(conflict.flaggedBy).toBe('agent_1');
    expect(conflict.discovery_a).toBe('data says X');
    expect(conflict.discovery_b).toBe('data says Y');
    expect(conflict.reason).toBe('contradictory findings');
    expect(conflict.status).toBe('open');
    expect(conflict.createdAt).toBeDefined();
  });

  it('resolves an open conflict', async () => {
    const { conflicts } = setup();
    const conflict = await conflicts.flag('agent_1', 'A', 'B', 'mismatch');
    const resolved = await conflicts.resolve(conflict.id, 'agent_2', 'A was correct');
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe('resolved');
    expect(resolved!.resolvedBy).toBe('agent_2');
    expect(resolved!.resolution).toBe('A was correct');
  });

  it('returns null when resolving an already resolved conflict', async () => {
    const { conflicts } = setup();
    const conflict = await conflicts.flag('agent_1', 'A', 'B', 'mismatch');
    await conflicts.resolve(conflict.id, 'agent_2', 'A was correct');
    const result = await conflicts.resolve(conflict.id, 'agent_3', 'actually B');
    expect(result).toBeNull();
  });

  it('returns null when resolving unknown conflict', async () => {
    const { conflicts } = setup();
    const result = await conflicts.resolve('nonexistent', 'agent_1', 'resolution');
    expect(result).toBeNull();
  });

  it('lists conflicts by status', async () => {
    const { conflicts } = setup();
    const c1 = await conflicts.flag('agent_1', 'A', 'B', 'reason 1');
    await conflicts.flag('agent_2', 'C', 'D', 'reason 2');
    await conflicts.resolve(c1.id, 'agent_3', 'resolved');

    const open = await conflicts.list('open');
    expect(open.length).toBe(1);

    const resolved = await conflicts.list('resolved');
    expect(resolved.length).toBe(1);
    expect(resolved[0].id).toBe(c1.id);

    const all = await conflicts.list();
    expect(all.length).toBe(2);
  });

  it('publishes events on flag and resolve', async () => {
    const { events, conflicts } = setup();
    const conflict = await conflicts.flag('agent_1', 'A', 'B', 'mismatch');
    await conflicts.resolve(conflict.id, 'agent_2', 'fixed');

    const { events: evts } = await events.getEvents();
    expect(evts.length).toBe(2);
    expect(evts[0].type).toBe('conflict.flagged');
    expect(evts[0].publishedBy).toBe('agent_1');
    expect(evts[1].type).toBe('conflict.resolved');
    expect(evts[1].publishedBy).toBe('agent_2');
  });

  it('assigns unique ids to conflicts', async () => {
    const { conflicts } = setup();
    const c1 = await conflicts.flag('agent_1', 'A', 'B', 'reason');
    const c2 = await conflicts.flag('agent_1', 'C', 'D', 'reason');
    expect(c1.id).not.toBe(c2.id);
  });
});
