import { describe, it, expect } from 'vitest';
import { HelpStore } from './help.js';
import { EventStore } from './events.js';

describe('HelpStore', () => {
  function setup() {
    const events = new EventStore();
    const help = new HelpStore(events);
    return { events, help };
  }

  it('creates a help request', async () => {
    const { help } = setup();
    const req = await help.request('agent_1', 'stuck on parsing');
    expect(req.id).toBeDefined();
    expect(req.from).toBe('agent_1');
    expect(req.problem).toBe('stuck on parsing');
    expect(req.urgency).toBe('normal');
    expect(req.status).toBe('open');
    expect(req.createdAt).toBeDefined();
  });

  it('creates a help request with capability and urgency', async () => {
    const { help } = setup();
    const req = await help.request('agent_1', 'need regex help', 'regex', 'high');
    expect(req.needs_capability).toBe('regex');
    expect(req.urgency).toBe('high');
  });

  it('claims an open help request', async () => {
    const { help } = setup();
    const req = await help.request('agent_1', 'stuck');
    const claimed = await help.claim(req.id, 'agent_2');
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('claimed');
    expect(claimed!.claimedBy).toBe('agent_2');
  });

  it('returns null when claiming a non-open request', async () => {
    const { help } = setup();
    const req = await help.request('agent_1', 'stuck');
    await help.claim(req.id, 'agent_2');
    // Already claimed, can't claim again
    const result = await help.claim(req.id, 'agent_3');
    expect(result).toBeNull();
  });

  it('returns null when claiming unknown request', async () => {
    const { help } = setup();
    const result = await help.claim('nonexistent', 'agent_1');
    expect(result).toBeNull();
  });

  it('resolves a claimed help request', async () => {
    const { help } = setup();
    const req = await help.request('agent_1', 'stuck');
    await help.claim(req.id, 'agent_2');
    const resolved = await help.resolve(req.id, 'agent_2');
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe('resolved');
  });

  it('returns null when resolving a non-claimed request', async () => {
    const { help } = setup();
    const req = await help.request('agent_1', 'stuck');
    // Still open, not claimed
    const result = await help.resolve(req.id, 'agent_2');
    expect(result).toBeNull();
  });

  it('lists requests by status', async () => {
    const { help } = setup();
    const r1 = await help.request('agent_1', 'problem 1');
    const r2 = await help.request('agent_2', 'problem 2');
    await help.claim(r1.id, 'agent_3');

    const open = await help.list('open');
    expect(open.length).toBe(1);
    expect(open[0].id).toBe(r2.id);

    const claimed = await help.list('claimed');
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(r1.id);

    const all = await help.list();
    expect(all.length).toBe(2);
  });

  it('publishes events for request, claim, and resolve', async () => {
    const { events, help } = setup();
    const req = await help.request('agent_1', 'stuck');
    await help.claim(req.id, 'agent_2');
    await help.resolve(req.id, 'agent_2');

    const { events: evts } = await events.getEvents();
    expect(evts.length).toBe(3);
    expect(evts[0].type).toBe('help.requested');
    expect(evts[1].type).toBe('help.claimed');
    expect(evts[2].type).toBe('help.resolved');
  });
});
